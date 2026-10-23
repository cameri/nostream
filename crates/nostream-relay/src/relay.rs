//! The relay: the listening loop, one task per socket, live dispatch, liveness and drain.
//! Mirrors `src/adapters/web-socket-server-adapter.ts`, the message half of
//! `src/adapters/web-socket-adapter.ts`, and `src/factories/message-handler-factory.ts`.
//!
//! Each connection task owns its socket and the state machine R26 lists: `alive`, the
//! subscription table, the NIP-42 session, the in-flight handler set and the sink. Outbound
//! frames travel through [`FrameSink`]; inbound text is rate-limited, decoded, and handed to
//! the handler `messageHandlerFactory` would pick. Accepted events fan out to this process's
//! connections through one broadcast channel (cross-worker fan-out stays a stub).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use nostream_config::settings::Settings;
use nostream_core::adaptive_pow::AdaptivePowState;
use nostream_core::clock::Clock;
use nostream_core::lifecycle::ShutdownState;
use nostream_core::messages::RelayMessage;
use nostream_core::{Event, messages};

use crate::connection::{AcceptedTransport, Connection, ConnectionContext};
use crate::error::RelayError;
use crate::handlers::{self, HandlerContext, Stores};
use crate::hidden_content::{DEFAULT_REFRESH_INTERVAL, HiddenContentCache};
use crate::limits::RateLimits;
use crate::relay_key::RelayKeySource;
use crate::sink::FrameSink;
use crate::transport;

/// The knobs a [`Relay`] is built with that are not settings (`liveness` and the NIP-56
/// refresh are intervals the capture fixes in code, and tests shorten both).
#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// `WSS_CLIENT_HEALTH_PROBE_INTERVAL` (`web-socket-server-adapter.ts:18`).
    pub liveness_interval: Duration,
    /// `DEFAULT_REFRESH_INTERVAL_MS` (`hidden-content-cache.ts:7`).
    pub hidden_refresh_interval: Duration,
    /// `WS_DRAIN_TIMEOUT_MS`, resolved by `getWsDrainTimeoutMs`.
    pub drain_timeout: Duration,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            liveness_interval: Duration::from_millis(120_000),
            hidden_refresh_interval: DEFAULT_REFRESH_INTERVAL,
            drain_timeout: transport::drain_timeout(),
        }
    }
}

/// The relay's shared state: one value handed to every connection task.
pub struct Relay {
    settings: Arc<Settings>,
    stores: Arc<Stores>,
    clock: Arc<dyn Clock>,
    keys: Arc<RelayKeySource>,
    limits: Arc<RateLimits>,
    random: Arc<dyn nostream_core::random::RandomSource>,
    hidden: Arc<HiddenContentCache>,
    hub: broadcast::Sender<Event>,
    pow: Arc<Mutex<AdaptivePowState>>,
    config: RelayConfig,
}

impl std::fmt::Debug for Relay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Relay")
            .field("relay_url", &self.settings.info.relay_url)
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Relay {
    /// Builds the relay from the loaded settings, the repository seams and a clock. The
    /// signing key is read from the environment (`RELAY_PRIVATE_KEY`, then `SECRET`).
    pub fn new(settings: Settings, stores: Arc<Stores>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Self::with_keys(settings, stores, clock, RelayKeySource::from_env())
    }

    /// Builds the relay with an explicit key source, for tests and for the daemon's wiring.
    pub fn with_keys(
        settings: Settings,
        stores: Arc<Stores>,
        clock: Arc<dyn Clock>,
        keys: RelayKeySource,
    ) -> Arc<Self> {
        let settings = Arc::new(settings);
        let (hub, _receiver) = broadcast::channel(1_024);

        Arc::new(Self {
            limits: Arc::new(RateLimits::new(&settings, Arc::clone(&clock))),
            random: Arc::new(nostream_core::random::SystemRandom),
            settings,
            stores,
            clock,
            keys: Arc::new(keys),
            hidden: HiddenContentCache::new(),
            hub,
            pow: Arc::new(Mutex::new(AdaptivePowState::default())),
            config: RelayConfig::default(),
        })
    }

    /// Replaces the intervals, returning the relay for chaining.
    pub fn with_config(mut self: Arc<Self>, config: RelayConfig) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .map(|relay| relay.config = config)
            .unwrap_or_else(|| {
                tracing::warn!("relay is already shared; the intervals were not replaced");
            });

        self
    }

    /// The intervals this relay runs with.
    pub fn config(&self) -> &RelayConfig {
        &self.config
    }

    /// Replaces the randomness source, returning the relay for chaining. A recorded fixture
    /// replays its session with the recording's stream.
    pub fn with_random(
        mut self: Arc<Self>,
        random: Arc<dyn nostream_core::random::RandomSource>,
    ) -> Arc<Self> {
        Arc::get_mut(&mut self)
            .map(|relay| relay.random = random)
            .unwrap_or_else(|| {
                tracing::warn!("relay is already shared; the randomness was not replaced");
            });

        self
    }

    /// The hidden-content mirror, so a caller can seed it.
    pub fn hidden_content(&self) -> &Arc<HiddenContentCache> {
        &self.hidden
    }

    /// The process's broadcast hub, for a caller that publishes from outside a connection.
    pub fn hub(&self) -> &broadcast::Sender<Event> {
        &self.hub
    }

    /// The context one socket's handlers run in.
    fn handler_context(&self, connection: Arc<Connection>, sink: FrameSink) -> HandlerContext {
        HandlerContext {
            settings: Arc::clone(&self.settings),
            clock: Arc::clone(&self.clock),
            random: Arc::clone(&self.random),
            sink,
            connection,
            stores: Arc::clone(&self.stores),
            limits: Arc::clone(&self.limits),
            hidden: Arc::clone(&self.hidden),
            keys: Arc::clone(&self.keys),
            broadcast: self.hub.clone(),
            pow: Arc::clone(&self.pow),
        }
    }

    /// Accepts sockets until `shutdown` fires, then drains.
    ///
    /// The hidden-content refresh starts with the relay and stops with it; the drain waits
    /// `config.drain_timeout` for the connections to finish and then aborts the rest
    /// (`drainClients`, `web-socket-server-adapter.ts:67-95`).
    pub async fn serve(
        self: &Arc<Self>,
        listener: TcpListener,
        shutdown: ShutdownState,
    ) -> Result<(), RelayError> {
        let hidden_task = self.hidden.start(
            Arc::clone(&self.stores.reports),
            Arc::clone(&self.settings),
            self.config.hidden_refresh_interval,
            Arc::clone(&self.clock),
        );

        let mut connections: JoinSet<()> = JoinSet::new();

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => {
                            let relay = Arc::clone(self);
                            let shutdown = shutdown.clone();

                            connections.spawn(async move {
                                relay.handle_socket(stream, peer, shutdown).await;
                            });
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "accept failed");
                        }
                    }
                }
                _ = shutdown.wait_for_drain() => break,
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }

        tracing::debug!(
            connections = connections.len(),
            timeout_ms = self.config.drain_timeout.as_millis(),
            "draining"
        );

        let deadline = tokio::time::sleep(self.config.drain_timeout);
        tokio::pin!(deadline);

        while !connections.is_empty() {
            tokio::select! {
                _ = connections.join_next() => {}
                _ = &mut deadline => {
                    tracing::warn!(
                        remaining = connections.len(),
                        "terminating connections after the drain timeout"
                    );
                    connections.abort_all();
                    break;
                }
            }
        }

        hidden_task.abort();

        Ok(())
    }

    /// Serves one accepted socket: the upgrade, the per-socket state machine, and the close.
    pub async fn handle_socket(
        self: Arc<Self>,
        stream: TcpStream,
        peer: std::net::SocketAddr,
        shutdown: ShutdownState,
    ) {
        let max_payload = transport::max_payload_size(&self.settings);

        let transport = match transport::upgrade(stream, max_payload).await {
            Ok(transport) => transport,
            Err(error) => {
                tracing::debug!(%peer, error = %error, "websocket handshake failed");
                return;
            }
        };

        if shutdown.is_draining() {
            tracing::debug!(%peer, "client rejected: draining");
            self.close_draining(transport).await;
            return;
        }

        if self.is_connection_rate_limited(&peer).await {
            tracing::debug!(%peer, "client terminated: rate-limited");
            return;
        }

        self.run_connection(transport, peer, shutdown).await;
    }

    /// `isRateLimited` at the connection level (`rate-limiter-middleware.ts`): a tripped
    /// window terminates the upgrade.
    async fn is_connection_rate_limited(&self, peer: &std::net::SocketAddr) -> bool {
        match self.limits.connection_limited(&peer.ip().to_string()) {
            Ok(limited) => limited,
            Err(error) => {
                // Fail closed: an unavailable store must not admit an unlimited client.
                tracing::warn!(error = %error, "connection rate limiter unavailable; refusing");
                true
            }
        }
    }

    async fn close_draining(&self, mut transport: AcceptedTransport) {
        let _ = transport
            .close(Some(transport::close_frame(
                CloseCode::Away,
                transport::DRAIN_REASON,
            )))
            .await;
    }

    /// The per-socket loop (R26): read, live-dispatch, liveness and drain in one task.
    async fn run_connection(
        self: Arc<Self>,
        mut transport: AcceptedTransport,
        peer: std::net::SocketAddr,
        shutdown: ShutdownState,
    ) {
        let (sink, mut frames) = FrameSink::channel();

        let connection_context = ConnectionContext {
            settings: Arc::clone(&self.settings),
            clock: Arc::clone(&self.clock),
            random: Arc::clone(&self.random),
            sink: sink.clone(),
        };

        let connection = match Connection::accept(&transport, &connection_context) {
            Ok(connection) => Arc::new(connection),
            Err(error) => {
                tracing::warn!(%peer, error = %error, "unable to register the connection");
                return;
            }
        };

        let context = Arc::new(self.handler_context(Arc::clone(&connection), sink.clone()));

        let mut hub = self.hub.subscribe();
        let mut drained = shutdown.watch();
        // `tokio::time::interval`'s first tick is immediate and the capture's `setInterval`
        // first fires one interval after the socket opens, so the interval is re-armed.
        let mut liveness = tokio::time::interval(self.config.liveness_interval);
        liveness.reset();
        let mut alive = true;
        let mut handlers: JoinSet<()> = JoinSet::new();

        // The task keeps a sender alive so the frame queue is never closed underneath it.
        let _task_sink = sink.clone();

        loop {
            tokio::select! {
                frame = frames.recv() => {
                    let Some(text) = frame else { break };

                    if transport::send_text(&mut transport, &text).await.is_err() {
                        break;
                    }
                }
                message = transport.next() => {
                    let Some(message) = message else { break };

                    match message {
                        Ok(message) => match transport::classify(message) {
                            transport::Inbound::Text(text) => {
                                alive = true;
                                self.on_client_message(&text, &context, &mut handlers);
                            }
                            transport::Inbound::Ping(payload) => {
                                // A client Ping is answered in place and marks the socket
                                // alive (`web-socket-adapter.ts:342-346`).
                                alive = true;

                                if transport::send_pong(&mut transport, payload).await.is_err() {
                                    break;
                                }
                            }
                            transport::Inbound::Binary | transport::Inbound::Pong => {
                                alive = true;
                            }
                            transport::Inbound::Close | transport::Inbound::Other => break,
                        },
                        Err(error) => {
                            self.close_on_error(&mut transport, &error).await;
                            break;
                        }
                    }
                }
                event = hub.recv() => {
                    if let Ok(event) = event {
                        self.dispatch_live(&context, &event);
                    }
                }
                _ = liveness.tick() => {
                    if !alive {
                        // No pong and no message since the previous tick: close with no code
                        // (`web-socket-adapter.ts:157-167`).
                        tracing::debug!(%peer, "pong timeout");
                        break;
                    }

                    alive = false;

                    if transport.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
                _ = drained.changed() => {
                    if *drained.borrow() {
                        self.drain_connection(&context, &mut transport).await;
                        break;
                    }
                }
                Some(_) = handlers.join_next(), if !handlers.is_empty() => {}
            }
        }

        handlers.abort_all();
        connection.close();
    }

    /// The close frame an inbound error implies: 1009 for a message over the limit, 1002 for
    /// a protocol violation (an RSV bit with no negotiated extension), nothing otherwise.
    async fn close_on_error(
        &self,
        transport: &mut AcceptedTransport,
        error: &tokio_tungstenite::tungstenite::Error,
    ) {
        if transport::is_message_too_long(error) {
            tracing::debug!("client sent a payload too large");
            let _ = transport.close(Some(transport::too_big_frame())).await;
        } else if transport::is_protocol_error(error) {
            tracing::debug!(error = %error, "websocket protocol error");
            let _ = transport
                .close(Some(transport::protocol_error_frame()))
                .await;
        } else {
            tracing::debug!(error = %error, "websocket closed");
        }
    }

    /// One inbound text frame: the message limiter first, then the decoder, then the handler
    /// (`web-socket-adapter.ts:198-240`).
    fn on_client_message(
        &self,
        text: &str,
        context: &Arc<HandlerContext>,
        handlers: &mut JoinSet<()>,
    ) {
        match self
            .limits
            .message_backoff(&context.connection.remote_address)
        {
            Ok(Some(backoff)) => {
                let frame = rate_limited_frame(text, backoff, &context.connection);

                context.sink.send(&frame);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                // The capture's adapter logs the throw and drops the message without a frame.
                tracing::error!(error = %error, "message rate limiter unavailable");
                return;
            }
        }

        match messages::decode(text) {
            Ok(message) => {
                let context = Arc::clone(context);
                handlers.spawn(handlers::dispatch(message, context));
            }
            Err(error) => context.send_notice(&error.notice()),
        }
    }

    /// Live dispatch (`onSendEvent`): the read guard, the NIP-56 mirror, then every matching
    /// subscription on this socket.
    fn dispatch_live(&self, context: &HandlerContext, event: &Event) {
        if !context.read_authorization_guard().allows(event) {
            return;
        }

        let hiding = self
            .settings
            .nip56
            .as_ref()
            .is_some_and(|nipp56| nipp56.enabled && nipp56.hide_actionable_reports);

        if hiding && self.hidden.is_hidden(event) {
            return;
        }

        for subscription_id in context.connection.matching_subscription_ids(event) {
            context
                .sink
                .send(&RelayMessage::Event(messages::OutgoingEventMessage {
                    subscription_id,
                    event: event.clone(),
                }));
        }
    }

    /// `drainAndClose`: one `CLOSED` per subscription, then 1001 with the drain reason.
    async fn drain_connection(&self, context: &HandlerContext, transport: &mut AcceptedTransport) {
        // The frames go straight to the socket: the loop that drains the sink is the one
        // being left, so a queued frame would be dropped with it.
        for subscription in context.connection.subscriptions() {
            let frame = RelayMessage::Closed(messages::ClosedMessage {
                subscription_id: subscription.id,
                message: format!("error: {}", transport::DRAIN_REASON),
                params: None,
            });

            if transport::send_text(transport, &frame.to_text())
                .await
                .is_err()
            {
                return;
            }
        }

        let _ = transport
            .close(Some(transport::close_frame(
                CloseCode::Away,
                transport::DRAIN_REASON,
            )))
            .await;
    }
}

/// `createRateLimitedMessage` (`web-socket-adapter.ts:284-307`): a `REQ`/`COUNT` frame with
/// an id is closed with the backoff, and a limited `REQ` also ends its subscription.
fn rate_limited_frame(text: &str, backoff_ms: u64, connection: &Connection) -> RelayMessage {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return RelayMessage::rate_limited(None, None, backoff_ms),
    };

    let serde_json::Value::Array(items) = value else {
        return RelayMessage::rate_limited(None, None, backoff_ms);
    };

    let verb = items.first().and_then(serde_json::Value::as_str);
    let subscription_id = items.get(1).and_then(serde_json::Value::as_str);

    match (verb, subscription_id) {
        (Some("REQ"), Some(subscription_id)) => {
            connection.abort_read(subscription_id);
            connection.unsubscribe(subscription_id);

            RelayMessage::rate_limited(
                Some(messages::MessageType::Req),
                Some(subscription_id),
                backoff_ms,
            )
        }
        (Some("COUNT"), Some(subscription_id)) => RelayMessage::rate_limited(
            Some(messages::MessageType::Count),
            Some(subscription_id),
            backoff_ms,
        ),
        _ => RelayMessage::rate_limited(None, None, backoff_ms),
    }
}
