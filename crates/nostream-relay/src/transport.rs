//! The websocket transport: the handshake, the size limit, the close codes and the drain
//! timeout. Mirrors `src/factories/worker-factory.ts:73-91` and
//! `src/adapters/web-socket-server-adapter.ts`.
//!
//! The upgrade is accepted for every path — this job adds no HTTP route, so a non-upgrade
//! request gets tungstenite's refusal and nothing else.
//!
//! **Compression is declined** (ADR 0004): `tokio-tungstenite` offers no
//! `permessage-deflate`, so a client's offer is ignored and the session runs uncompressed.
//! The 101 response therefore carries no `Sec-WebSocket-Extensions` header.

use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

use nostream_config::settings::Settings;
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::connection::AcceptedTransport;
use crate::error::RelayError;

/// The fallback message limit (`maxPayload: maxPayloadSize ?? 131072`,
/// `src/factories/worker-factory.ts:78`).
pub const DEFAULT_MAX_PAYLOAD: usize = 131_072;

/// The drain timeout when `WS_DRAIN_TIMEOUT_MS` is unusable
/// (`DEFAULT_WS_DRAIN_TIMEOUT_MS`, `src/utils/shutdown-state.ts:1`).
pub const DEFAULT_WS_DRAIN_TIMEOUT_MS: u64 = 30_000;

/// The close reason a draining server sends (`drainAndClose`).
pub const DRAIN_REASON: &str = "relay shutting down";

/// `network.maxPayloadSize` (`network.max_payload_size` in the shipped YAML), else 131072.
pub fn max_payload_size(settings: &Settings) -> usize {
    settings
        .network
        .max_payload_size
        .and_then(|size| usize::try_from(size).ok())
        .filter(|size| *size > 0)
        .unwrap_or(DEFAULT_MAX_PAYLOAD)
}

/// The websocket configuration the limit implies.
///
/// `max_message_size` bounds the reassembled message and `max_frame_size` a single frame, so
/// a fragmented message cannot grow past the limit either. The write buffer is unbuffered so
/// every frame leaves when it is sent, which is what the capture's `client.send` does.
pub fn web_socket_config(max_payload: usize) -> WebSocketConfig {
    WebSocketConfig::default()
        .write_buffer_size(0)
        .max_message_size(Some(max_payload))
        .max_frame_size(Some(max_payload))
}

/// Completes the websocket handshake over an accepted socket.
pub async fn upgrade(
    stream: TcpStream,
    max_payload: usize,
) -> Result<AcceptedTransport, RelayError> {
    tokio_tungstenite::accept_async_with_config(stream, Some(web_socket_config(max_payload)))
        .await
        .map_err(|error| RelayError::Handshake(error.to_string()))
}

/// A close frame with a code and a reason, as `close(code, reason)` sends.
pub fn close_frame(code: CloseCode, reason: &'static str) -> CloseFrame {
    CloseFrame {
        code,
        reason: reason.into(),
    }
}

/// The frame an oversized message is closed with: 1009, empty reason (measured).
pub fn too_big_frame() -> CloseFrame {
    CloseFrame {
        code: CloseCode::Size,
        reason: "".into(),
    }
}

/// The frame a protocol violation is closed with: 1002.
pub fn protocol_error_frame() -> CloseFrame {
    CloseFrame {
        code: CloseCode::Protocol,
        reason: "".into(),
    }
}

/// `getWsDrainTimeoutMs` (`src/utils/shutdown-state.ts:17-29`): unset, empty, non-numeric or
/// negative resolves to 30000; otherwise the parsed value in milliseconds.
pub fn resolve_drain_timeout(raw: Option<&str>) -> u64 {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return DEFAULT_WS_DRAIN_TIMEOUT_MS;
    };

    match raw.parse::<i64>() {
        Ok(millis) if millis >= 0 => u64::try_from(millis).unwrap_or(DEFAULT_WS_DRAIN_TIMEOUT_MS),
        _ => DEFAULT_WS_DRAIN_TIMEOUT_MS,
    }
}

/// `resolve_drain_timeout` over `WS_DRAIN_TIMEOUT_MS`.
pub fn drain_timeout_from_env() -> u64 {
    resolve_drain_timeout(std::env::var("WS_DRAIN_TIMEOUT_MS").ok().as_deref())
}

/// The drain timeout as a duration.
pub fn drain_timeout() -> Duration {
    Duration::from_millis(drain_timeout_from_env())
}

/// Whether a websocket error is the max-payload failure (measured: close code 1009).
pub fn is_message_too_long(error: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(
        error,
        tokio_tungstenite::tungstenite::Error::Capacity(
            tokio_tungstenite::tungstenite::error::CapacityError::MessageTooLong { .. }
        )
    )
}

/// Whether a websocket error is the RSV-bit violation a compression-declining server sees
/// (`Invalid WebSocket frame: RSV1 must be clear`, `web-socket-adapter.ts:73`).
pub fn is_protocol_error(error: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(error, tokio_tungstenite::tungstenite::Error::Protocol(_))
}

/// One inbound websocket message, as the per-socket loop needs it. Classification lives here
/// so that the loop never names a `Message` variant of its own.
#[derive(Debug)]
pub enum Inbound {
    Text(String),
    Binary,
    Ping(Vec<u8>),
    Pong,
    Close,
    Other,
}

/// Classifies an inbound message (`web-socket-adapter.ts:198-240`).
pub fn classify(message: Message) -> Inbound {
    match message {
        Message::Text(text) => Inbound::Text(text.as_str().to_owned()),
        Message::Binary(_) => Inbound::Binary,
        Message::Ping(payload) => Inbound::Ping(payload.to_vec()),
        Message::Pong(_) => Inbound::Pong,
        Message::Close(_) => Inbound::Close,
        Message::Frame(_) => Inbound::Other,
    }
}

/// Writes one text frame. This is the relay's single write point for outbound JSON.
pub async fn send_text(
    transport: &mut AcceptedTransport,
    text: &str,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    transport.send(Message::Text(text.to_owned().into())).await
}

/// Answers a client Ping in place.
pub async fn send_pong(
    transport: &mut AcceptedTransport,
    payload: Vec<u8>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    transport.send(Message::Pong(payload.into())).await
}

/// A negotiated socket, for callers that hold the concrete type.
pub type Transport = WebSocketStream<TcpStream>;

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn settings_with(size: Option<u64>) -> Settings {
        let mut settings = crate::testing::settings();
        settings.network.max_payload_size = size;

        settings
    }

    #[test]
    fn max_payload_falls_back_to_131072() {
        assert_eq!(max_payload_size(&settings_with(None)), 131_072);
        assert_eq!(max_payload_size(&settings_with(Some(0))), 131_072);
        assert_eq!(max_payload_size(&settings_with(Some(524_288))), 524_288);
    }

    #[test]
    fn a_null_extension_header_is_never_offered() {
        // The configuration has no extension slot at all; this pins the shape the handshake
        // is built from, so a future compression feature has to change this test.
        let config = web_socket_config(1024);

        assert_eq!(config.max_message_size, Some(1024));
        assert_eq!(config.max_frame_size, Some(1024));
        assert_eq!(config.write_buffer_size, 0);
    }

    #[test]
    fn drain_timeout_resolution_matches_the_capture() {
        assert_eq!(resolve_drain_timeout(None), 30_000);
        assert_eq!(resolve_drain_timeout(Some("")), 30_000);
        assert_eq!(resolve_drain_timeout(Some("abc")), 30_000);
        assert_eq!(resolve_drain_timeout(Some("-1")), 30_000);
        assert_eq!(resolve_drain_timeout(Some("10")), 10);
        assert_eq!(resolve_drain_timeout(Some("0")), 0);
    }
}
