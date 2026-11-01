//! The relay: the listening loop, one task per socket, live dispatch, liveness and drain.
//! Mirrors `src/adapters/web-socket-server-adapter.ts`, the message half of
//! `src/adapters/web-socket-adapter.ts`, and `src/factories/message-handler-factory.ts`.
//!
//! Each connection task owns its socket and the state machine R26 lists: `alive`, the
//! subscription table, the NIP-42 session, the in-flight handler set and the sink. Outbound
//! frames travel through [`FrameSink`]; inbound text is rate-limited, decoded, and given to
//! the handler `messageHandlerFactory` would pick — the handler's ordering-sensitive prefix
//! runs here, on the loop, before the next frame is read, and the rest of it is spawned into
//! the per-socket handler set. Accepted events fan out to this process's connections through
//! one broadcast channel (cross-worker fan-out stays a stub).

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
use crate::connection_cap::ConnectionCap;
use crate::handlers::{self, HandlerContext, Stores};
use crate::hidden_content::{DEFAULT_REFRESH_INTERVAL, HiddenContentCache};
use crate::limits::RateLimits;
use crate::relay_key::RelayKeySource;
use crate::sink::{FrameBudget, FrameSink, Refusal};
use crate::transport;
use crate::wot::WotGraph;

/// The knobs a [`Relay`] is built with. Most are not settings: a constant the capture fixes in
/// code (`liveness`, the NIP-56 refresh) or a policy the port adds with no counterpart there
/// (`frame_queue_bytes`, `write_timeout`; ADR 0005). The two bounds are settings an operator
/// writes — `network.frameMemoryBudgetBytes` and `limits.connection.maxConnectionsPerIp` — and
/// [`RelayConfig::from_settings`] is what reads them; [`RelayConfig::default`] is the value a
/// relay runs with when the key is absent. Tests set the cadences they need and the bounds a
/// case asks for. A new value the capture's settings document carries belongs in [`Settings`].
#[derive(Debug, Clone)]
pub struct RelayConfig {
    /// `WSS_CLIENT_HEALTH_PROBE_INTERVAL` (`web-socket-server-adapter.ts:18`).
    pub liveness_interval: Duration,
    /// `DEFAULT_REFRESH_INTERVAL_MS` (`hidden-content-cache.ts:7`).
    pub hidden_refresh_interval: Duration,
    /// `WS_DRAIN_TIMEOUT_MS`, resolved by `getWsDrainTimeoutMs`.
    pub drain_timeout: Duration,
    /// The byte bound on one socket's outbound frame queue. The capture has no counterpart:
    /// it queues every frame without a limit (`web-socket-adapter.ts:150-155`), so the bound
    /// is the port's own policy (ADR 0005).
    pub frame_queue_bytes: usize,
    /// How long one socket write may take before the connection ends. The capture has no
    /// counterpart either: its liveness probe is a process-wide `setInterval` a blocked write
    /// cannot starve (`web-socket-server-adapter.ts:18,46`), while this loop performs the
    /// write itself.
    pub write_timeout: Duration,
    /// The queued outbound payload bytes every socket of this relay shares. The capture has
    /// no counterpart: it bounds neither one socket's queue nor their sum (ADR 0008).
    pub frame_memory_budget_bytes: usize,
    /// The live sockets one source address may hold at once. The capture has no counterpart
    /// either: its connection limits are rates, not counts (`src/@types/settings.ts:163-167`;
    /// ADR 0008).
    pub max_connections_per_ip: usize,
}

impl Default for RelayConfig {
    /// The capture's own constants, and no environment read: `WS_DRAIN_TIMEOUT_MS` is
    /// resolved by [`transport::drain_timeout`], which the composition root calls (ADR 0004);
    /// the queue bound and the write timeout are the port's additions (ADR 0005). The two
    /// bounds are the shipped default an operator's setting overrides, not the only value.
    fn default() -> Self {
        Self {
            liveness_interval: Duration::from_millis(120_000),
            hidden_refresh_interval: DEFAULT_REFRESH_INTERVAL,
            drain_timeout: Duration::from_millis(transport::DEFAULT_WS_DRAIN_TIMEOUT_MS),
            // 8 MiB: above any single outbound frame, and a few hundred times below the
            // 405 MiB an unbounded queue reached in the measurement that motivated it.
            frame_queue_bytes: 8 * 1024 * 1024,
            // Shorter than the 120 s liveness interval, so a client that stops reading is
            // closed by the write path before a missed pong could close it.
            write_timeout: Duration::from_secs(30),
            // 256 MiB: 32 sockets at the `frame_queue_bytes` ceiling can be fully buffered
            // before the budget binds, which is below the 48 a single address gets through
            // the shipped attempt limits alone (ADR 0008).
            frame_memory_budget_bytes: 256 * 1024 * 1024,
            // 64: four times the concurrent total one well-behaved client needs. The cap is per
            // address while the budget is process-wide, so what the pair really bounds is
            // `min(budget, addresses × cap × frame_queue_bytes)` — the cap alone cannot be
            // read as the memory ceiling (ADR 0008).
            max_connections_per_ip: 64,
        }
    }
}

/// The ceiling a setting's bound may carry, in that bound's own unit: 1 TiB (1 099 511 627 776)
/// of queued frames for `network.frameMemoryBudgetBytes`, and 1.09 million sockets for
/// `limits.connection.maxConnectionsPerIp`. One number because one check reads both; it is far
/// above any deployment each way, and far below `usize::MAX`, so a stray digit cannot reach
/// [`FrameBudget::admit`]'s arithmetic. A value above it keeps the compiled default (ADR 0008).
pub const MAX_SETTING_BOUND: usize = 1024 * 1024 * 1024 * 1024;

/// Whether an operator's value for a bound is one the relay can run with: at most
/// [`MAX_SETTING_BOUND`]. Public because the daemon's settings gate reports the same verdict
/// before a relay exists, and one predicate is what keeps `--check` and the relay from
/// disagreeing (ADR 0008). Zero is in range: the validator refuses it, so a value that reaches
/// here is one the relay runs with as written.
pub fn in_range(value: u64) -> bool {
    value <= MAX_SETTING_BOUND as u64
}

/// Why a value was not taken from a bound's setting: the question [`in_range`] answers, said out
/// loud, so the report can name the ceiling the value crossed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundRefusal {
    /// The value is above [`MAX_SETTING_BOUND`].
    AboveCeiling(u64),
}

/// The two settings whose value is a bound, each with the value the operator wrote when that value
/// is not taken. This is the only walk of the two leaves outside [`RelayConfig::from_settings`]:
/// the daemon's gate and the CLI's `config validate` both report from it, so a key added to one
/// surface cannot be reported by one door and ignored by another (ADR 0008).
pub fn refused_bounds(settings: &Settings) -> Vec<(&'static str, BoundRefusal)> {
    let mut refused = Vec::new();
    if let Some(bytes) = settings.network.frame_memory_budget_bytes
        && let Some(reason) = bound_refusal(bytes)
    {
        refused.push(("network.frameMemoryBudgetBytes", reason));
    }
    if let Some(cap) = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.connection.as_ref())
        .and_then(|connection| connection.max_connections_per_ip)
        && let Some(reason) = bound_refusal(cap)
    {
        refused.push(("limits.connection.maxConnectionsPerIp", reason));
    }
    refused
}

/// Whether a bound's setting is not taken, or `None` when it is.
///
/// It asks [`in_range`] first, so the constructor and every report agree by construction rather
/// than by two comparisons that happen to match: a value `in_range` accepts is never refused here.
pub fn bound_refusal(value: u64) -> Option<BoundRefusal> {
    if in_range(value) {
        None
    } else {
        Some(BoundRefusal::AboveCeiling(MAX_SETTING_BOUND as u64))
    }
}

/// The sentence one refused bound is reported with, for both doors; the words live beside the
/// decision so the daemon's gate and the CLI cannot phrase it differently.
pub fn refusal_message(setting: &str, reason: BoundRefusal) -> String {
    match reason {
        BoundRefusal::AboveCeiling(ceiling) => {
            format!("{setting}: above the {ceiling} a bound accepts; the key's value is ignored")
        }
    }
}

/// Reports one bound's setting that the relay will not run with, as one structured line saying
/// the ceiling it crossed.
fn warn_refused_bound(setting: &'static str, value: u64, default: usize) {
    match bound_refusal(value) {
        Some(BoundRefusal::AboveCeiling(ceiling)) => tracing::warn!(
            setting,
            value,
            ceiling,
            default,
            "a bound above its ceiling runs with its default"
        ),
        None => {}
    }
}

impl RelayConfig {
    /// The configuration a relay built from `settings` runs with: [`RelayConfig::default`] for
    /// every knob the capture fixes in code, with the two bounds an operator sets read from
    /// their leaves — `network.frameMemoryBudgetBytes` and
    /// `limits.connection.maxConnectionsPerIp` — when present.
    ///
    /// This is the one place either setting is interpreted, so `nostreamd` and the tests cannot
    /// disagree about it. `drain_timeout` stays the composition root's to resolve: it is an
    /// environment read (ADR 0004), not a setting.
    ///
    /// A leaf is taken as written whenever it is at most [`MAX_SETTING_BOUND`]; an absent leaf
    /// keeps the default, and so does a value above the ceiling. The ceiling is not cosmetic:
    /// `usize::MAX` fits a `usize`, so it would pass a bare range check and reach
    /// [`FrameBudget::admit`], whose fit guard uses `saturating_sub` while its accounting adds
    /// unchecked — a budget that cannot be exhausted, and an add that overflows. A zero never
    /// reaches this constructor from a loaded document: the validator refuses it by name
    /// (ADR 0008).
    pub fn from_settings(settings: &Settings) -> Self {
        let mut config = Self::default();

        if let Some(bytes) = settings.network.frame_memory_budget_bytes {
            if in_range(bytes) {
                config.frame_memory_budget_bytes = bytes as usize;
            } else {
                // `warn!`, not `debug!`: the value passes `--check` and is then quietly
                // replaced, so this line and the gate's report are the only places an operator
                // learns that the number they wrote is not the number the relay runs with.
                warn_refused_bound(
                    "network.frameMemoryBudgetBytes",
                    bytes,
                    config.frame_memory_budget_bytes,
                );
            }
        }

        if let Some(cap) = settings
            .limits
            .as_ref()
            .and_then(|limits| limits.connection.as_ref())
            .and_then(|connection| connection.max_connections_per_ip)
        {
            if in_range(cap) {
                config.max_connections_per_ip = cap as usize;
            } else {
                warn_refused_bound(
                    "limits.connection.maxConnectionsPerIp",
                    cap,
                    config.max_connections_per_ip,
                );
            }
        }

        config
    }
}

/// The relay's shared state: one value handed to every connection task.
pub struct Relay {
    settings: Arc<Settings>,
    stores: Arc<Stores>,
    wot: Arc<dyn WotGraph>,
    clock: Arc<dyn Clock>,
    keys: Arc<RelayKeySource>,
    limits: Arc<RateLimits>,
    random: Arc<dyn nostream_core::random::RandomSource>,
    hidden: Arc<HiddenContentCache>,
    hub: broadcast::Sender<Arc<Event>>,
    pow: Arc<Mutex<AdaptivePowState>>,
    frame_budget: Arc<FrameBudget>,
    connection_cap: Arc<ConnectionCap>,
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
    /// Builds the relay from its collaborators: the settings, the stores, the trust graph, the
    /// clock, the key source, the randomness and the intervals.
    ///
    /// Everything the relay runs with is an argument, so a relay that mints from
    /// `SystemRandom` or resolves `WS_DRAIN_TIMEOUT_MS` from the environment is one whose
    /// composition root asked for it: `RelayConfig::default()` is the port's own defaults — the
    /// capture's constants plus the policies ADR 0005 and ADR 0008 add — and the environment
    /// read is [`transport::drain_timeout`] at the call site.
    pub fn new(
        settings: Settings,
        stores: Arc<Stores>,
        wot: Arc<dyn WotGraph>,
        clock: Arc<dyn Clock>,
        keys: RelayKeySource,
        random: Arc<dyn nostream_core::random::RandomSource>,
        config: RelayConfig,
    ) -> Arc<Self> {
        let settings = Arc::new(settings);
        let (hub, _receiver) = broadcast::channel(1024);
        let frame_budget = Arc::new(FrameBudget::new(config.frame_memory_budget_bytes));
        let connection_cap = Arc::new(ConnectionCap::new(config.max_connections_per_ip));

        Arc::new(Self {
            limits: Arc::new(RateLimits::new(&settings, Arc::clone(&clock))),
            random,
            settings,
            stores,
            wot,
            clock,
            keys: Arc::new(keys),
            hidden: HiddenContentCache::new(),
            hub,
            pow: Arc::new(Mutex::new(AdaptivePowState::default())),
            frame_budget,
            connection_cap,
            config,
        })
    }

    /// The hidden-content mirror. The parity harness reads it to wait for the boot refresh
    /// that seeds it; nothing else in the workspace calls this.
    pub fn hidden_content(&self) -> &Arc<HiddenContentCache> {
        &self.hidden
    }

    /// The process-wide bound on queued outbound payload bytes. The counter it carries is what
    /// a metrics exporter would read once the admin `/metrics` route is implemented; the warn
    /// line on a refusal is what an operator has today (ADR 0008).
    pub fn frame_budget(&self) -> &Arc<FrameBudget> {
        &self.frame_budget
    }

    /// The live-connection cap per source address, and its refusal counter.
    pub fn connection_cap(&self) -> &Arc<ConnectionCap> {
        &self.connection_cap
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
            wot: Arc::clone(&self.wot),
            limits: Arc::clone(&self.limits),
            hidden: Arc::clone(&self.hidden),
            keys: Arc::clone(&self.keys),
            broadcast: self.hub.clone(),
            pow: Arc::clone(&self.pow),
        }
    }

    /// Accepts sockets until `shutdown` fires, then drains.
    ///
    /// Returns nothing because serving cannot fail: an accept error is logged and the loop
    /// continues, and the drain is bounded by `config.drain_timeout`. A caller that wants to
    /// know the task finished awaits the future; a caller that wants to know *why* there is
    /// a `ShutdownState` to watch.
    ///
    /// The hidden-content refresh starts with the relay and stops with it; the drain waits
    /// `config.drain_timeout` for the connections to finish and then aborts the rest
    /// (`drainClients`, `web-socket-server-adapter.ts:67-95`).
    pub async fn serve(self: &Arc<Self>, listener: TcpListener, shutdown: ShutdownState) {
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
    }

    /// Serves one accepted socket: the upgrade, the per-socket state machine, and the close.
    pub async fn handle_socket(
        self: Arc<Self>,
        stream: TcpStream,
        peer: std::net::SocketAddr,
        shutdown: ShutdownState,
    ) {
        let max_payload = transport::max_payload_size(&self.settings);

        let mut transport = match transport::upgrade(stream, max_payload).await {
            Ok(transport) => transport,
            Err(error) => {
                tracing::debug!(%peer, error = %error, "websocket handshake failed");
                return;
            }
        };

        if self.is_connection_rate_limited(&peer).await {
            tracing::debug!(%peer, "client terminated: rate-limited");
            return;
        }

        // After the attempt limiter, so a rate-limited socket is still dropped silently as it
        // always was and takes no slot; before `run_connection`, because registering the
        // `Connection` sends the NIP-42 challenge as a text frame and a refused client must
        // receive no text frame (ADR 0008). The slot is held until this function returns,
        // which covers the registration failure inside `run_connection` as well as its
        // normal exit.
        let ip = peer.ip().to_string();
        let Some(_slot) = self.connection_cap.acquire(&ip) else {
            tracing::debug!(
                %peer,
                max_connections_per_ip = self.connection_cap.max_per_ip(),
                live = self.connection_cap.live(&ip),
                "client terminated: connection cap"
            );
            self.close_frame(
                &mut transport,
                CloseCode::Again,
                transport::CONNECTION_CAP_REASON,
            )
            .await;

            return;
        };

        self.run_connection(transport, peer, shutdown).await;
    }

    /// `isRateLimited` at the connection level (`rate-limiter-middleware.ts`): a tripped
    /// window terminates the upgrade.
    ///
    /// Keyed on the accept loop's peer rather than on `Connection::remote_address`: the
    /// decision is taken after the upgrade but before the connection is registered, as the
    /// capture checks it after the handshake, so there is no `Connection` yet; both derive
    /// from the same socket address (ADR 0004).
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

    /// The per-socket loop (R26): read, live-dispatch, liveness and drain in one task.
    async fn run_connection(
        self: Arc<Self>,
        mut transport: AcceptedTransport,
        peer: std::net::SocketAddr,
        shutdown: ShutdownState,
    ) {
        let (sink, mut frames) = FrameSink::channel(
            self.config.frame_queue_bytes,
            Some(Arc::clone(&self.frame_budget)),
        );

        let connection_context = ConnectionContext {
            settings: Arc::clone(&self.settings),
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
        // `watch()`'s receiver has already seen a drain that began before it existed, and its
        // `changed()` would never fire, so the flag is read once before the loop as well as
        // in the select arm: a socket accepted while the relay is draining gets its CLOSED
        // frames and its 1001 instead of being aborted by the deadline (R4).
        let mut drain_seen = *drained.borrow_and_update();
        // `tokio::time::interval`'s first tick is immediate and the capture's `setInterval`
        // first fires one interval after the socket opens, so the interval is re-armed.
        let mut liveness = tokio::time::interval(self.config.liveness_interval);
        liveness.reset();
        let mut alive = true;
        let mut handlers: JoinSet<()> = JoinSet::new();

        // The task keeps a sender alive so the frame queue is never closed underneath it.
        let _task_sink = sink.clone();

        loop {
            if drain_seen {
                self.drain_connection(&context, &mut transport).await;
                break;
            }

            // Read at the top of every iteration, so a flag the producers set while the loop
            // was parked on a write is acted on as soon as that write returns. No `await`
            // sits between a write completing and this check.
            match sink.refusal() {
                Refusal::None => {}
                refusal @ (Refusal::QueueFull | Refusal::BudgetExhausted) => {
                    self.close_refused(&mut transport, peer, refusal).await;
                    break;
                }
            }

            tokio::select! {
                frame = frames.recv() => {
                    let Some(text) = frame else { break };

                    let bytes = text.len();
                    let written = tokio::time::timeout(
                        self.config.write_timeout,
                        transport::send_text(&mut transport, text),
                    )
                    .await;

                    sink.release(bytes);

                    if !matches!(written, Ok(Ok(()))) {
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

                                let pong = tokio::time::timeout(
                                    self.config.write_timeout,
                                    transport::send_pong(&mut transport, payload),
                                )
                                .await;

                                if !matches!(pong, Ok(Ok(()))) {
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
                    match event {
                        Ok(event) => self.dispatch_live(&context, &event),
                        // The ring holds 1,024 events: a connection that falls further behind
                        // misses some, and the miss is logged rather than swallowed. One
                        // subscription needs one `find_by_filters` to catch up, which is the
                        // client's job, not this loop's.
                        Err(broadcast::error::RecvError::Lagged(missed)) => {
                            tracing::warn!(%peer, missed, "live events missed; the client must re-read");
                        }
                        // The relay holds a sender for its whole life, so this is
                        // unreachable; leaving beats spinning on a closed channel.
                        Err(broadcast::error::RecvError::Closed) => break,
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

                    let ping = tokio::time::timeout(
                        self.config.write_timeout,
                        transport.send(Message::Ping(Vec::new().into())),
                    )
                    .await;

                    if !matches!(ping, Ok(Ok(()))) {
                        break;
                    }
                }
                _ = drained.changed() => drain_seen = *drained.borrow_and_update(),
                // A refusal can arrive with nothing else to wake this loop: the budget is
                // shared, so the frame that did not fit may have left this socket's own queue
                // empty, the socket idle, and its read stopped and parked with nothing to run it.
                // The producer signals when it records the refusal, and the next iteration's
                // check closes the client — immediate, not one liveness tick away (ADR 0008).
                _ = sink.refused() => {}
                Some(_) = handlers.join_next(), if !handlers.is_empty() => {}
            }
        }

        handlers.abort_all();
        connection.close();
    }

    /// Closes a client whose frame was refused, with the close its bound implies: 1013 and the
    /// reason for that bound, then the loop's cleanup (`handlers.abort_all()` and
    /// `connection.close()`).
    ///
    /// The policy is a disconnect, not a silent break, for both bounds: a client cut mid-`REQ`
    /// with no frame cannot tell a slow link from a relay that forgot it (ADR 0005), and a
    /// refusal that looked like a network fault is exactly what the two reason strings and
    /// their counters exist to keep out of the logs (ADR 0008).
    async fn close_refused(
        &self,
        transport: &mut AcceptedTransport,
        peer: std::net::SocketAddr,
        refusal: Refusal,
    ) {
        match refusal {
            // This socket was never refused, nothing to close.
            Refusal::None => {}
            Refusal::QueueFull => {
                tracing::debug!(%peer, "closing a client that cannot keep up with its frame queue");

                self.close_frame(transport, CloseCode::Again, transport::SLOW_CONSUMER_REASON)
                    .await;
            }
            Refusal::BudgetExhausted => {
                tracing::debug!(%peer, "closing a client that exhausted the frame memory budget");

                self.close_frame(transport, CloseCode::Again, transport::FRAME_BUDGET_REASON)
                    .await;
            }
        }
    }

    /// Writes one close frame straight to the transport, bounded by the write timeout so a
    /// client that stopped reading cannot hold the task open.
    async fn close_frame(
        &self,
        transport: &mut AcceptedTransport,
        code: CloseCode,
        reason: &'static str,
    ) {
        let _ = tokio::time::timeout(
            self.config.write_timeout,
            transport.close(Some(transport::close_frame(code, reason))),
        )
        .await;
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

            let _ = tokio::time::timeout(
                self.config.write_timeout,
                transport.close(Some(transport::too_big_frame())),
            )
            .await;
        } else if transport::is_protocol_error(error) {
            tracing::debug!(error = %error, "websocket protocol error");

            let _ = tokio::time::timeout(
                self.config.write_timeout,
                transport.close(Some(transport::protocol_error_frame())),
            )
            .await;
        } else {
            tracing::debug!(error = %error, "websocket closed");
        }
    }

    /// One inbound text frame: the message limiter first, then the decoder, then the handler
    /// (`web-socket-adapter.ts:198-240`).
    ///
    /// The handler's prefix runs here, before the loop reads the next frame; its continuation
    /// joins the socket's handler set.
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
                if let Some(handler) = handlers::begin(message, context) {
                    handlers.spawn(handler);
                }
            }
            Err(error) => context.send_notice(&error.notice()),
        }
    }

    /// Live dispatch (`onSendEvent`): the read guard, the NIP-56 mirror, then every matching
    /// subscription on this socket.
    fn dispatch_live(&self, context: &HandlerContext, event: &Arc<Event>) {
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
                    event: Arc::clone(event),
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

            let written = tokio::time::timeout(
                self.config.write_timeout,
                transport::send_text(transport, frame.to_text()),
            )
            .await;

            if !matches!(written, Ok(Ok(()))) {
                return;
            }
        }

        let _ = tokio::time::timeout(
            self.config.write_timeout,
            transport.close(Some(transport::close_frame(
                CloseCode::Away,
                transport::DRAIN_REASON,
            ))),
        )
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
