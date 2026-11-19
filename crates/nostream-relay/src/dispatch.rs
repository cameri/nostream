//! The one-listener dispatch: a socket whose first bytes are a WebSocket upgrade goes to the
//! relay; every other socket is HTTP/1.1 and goes to the fallback the composition root hands
//! in.
//!
//! This is decision D1 in `docs/rewrite/decisions/0014-admin-http-surface.md`: the capture
//! serves express and the WS upgrade from one Node `http.createServer(app)`
//! (`src/factories/worker-factory.ts:62-77`), so a second port would change the console's URL
//! and the cookie's `Path`. The head is **peeked**, never consumed (`TcpStream::peek`), so the
//! relay's upgrade path reads exactly the bytes it would have read without this module in the
//! way.
//!
//! A head that does not complete within 8 KiB or 1,000 ms goes to the relay: that is today's
//! path, and it is where a non-HTTP client (or a slow writer) has always ended up.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;

/// The peek buffer: the head's maximum size before the socket is treated as non-HTTP.
pub const MAX_HEAD_BYTES: usize = 8 * 1024;

/// How long the head may take to arrive.
pub const HEAD_TIMEOUT: Duration = Duration::from_millis(1_000);

/// What to do with a socket that is not a WebSocket upgrade. `nostreamd` implements this over
/// its `axum::Router`; a test can implement it over anything.
pub trait HttpFallback: Send + Sync + std::fmt::Debug {
    /// Serves one accepted socket as HTTP/1.1.
    fn serve(
        &self,
        stream: TcpStream,
        peer: SocketAddr,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// The protocol a socket's first bytes announce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// An HTTP request head carrying `Upgrade: websocket`.
    WebSocket,
    /// A complete HTTP request head without that header.
    Http,
    /// A head that did not complete inside the bounds, or not HTTP at all: today's path.
    Unknown,
}

/// Whether a complete request head carries an `Upgrade: websocket` header (case-insensitive).
pub fn is_websocket_upgrade(head: &[u8]) -> bool {
    let Ok(head) = std::str::from_utf8(head) else {
        return false;
    };
    head.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.trim().eq_ignore_ascii_case("upgrade")
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
    })
}

/// The end of the request head (the first `\r\n\r\n`), if it is all there.
fn head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

/// Classifies a peeked head.
pub fn classify(head: &[u8], complete: bool) -> Protocol {
    if !complete {
        return Protocol::Unknown;
    }
    if is_websocket_upgrade(head) {
        Protocol::WebSocket
    } else if head.starts_with(b"GET ")
        || head.starts_with(b"POST ")
        || head.starts_with(b"PUT ")
        || head.starts_with(b"PATCH ")
        || head.starts_with(b"DELETE ")
        || head.starts_with(b"HEAD ")
        || head.starts_with(b"OPTIONS ")
    {
        Protocol::Http
    } else {
        Protocol::Unknown
    }
}

/// Peeks the socket's first bytes and classifies them without consuming them.
pub async fn classify_socket(stream: &TcpStream) -> Protocol {
    let mut buffer = vec![0u8; MAX_HEAD_BYTES];
    let deadline = Instant::now() + HEAD_TIMEOUT;

    loop {
        match stream.peek(&mut buffer).await {
            Ok(0) => return Protocol::Unknown,
            Ok(read) => {
                if let Some(end) = head_end(&buffer[..read]) {
                    return classify(&buffer[..end], true);
                }
                if read >= MAX_HEAD_BYTES {
                    return Protocol::Unknown;
                }
            }
            Err(_) => return Protocol::Unknown,
        }

        if Instant::now() >= deadline {
            return Protocol::Unknown;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn a_websocket_handshake_is_recognised_whatever_the_case() {
        let head =
            b"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n\r\n";
        assert_eq!(classify(head, true), Protocol::WebSocket);
        let head = b"GET / HTTP/1.1\r\nupgrade: websocket\r\n\r\n";
        assert_eq!(classify(head, true), Protocol::WebSocket);
    }

    #[test]
    fn a_plain_request_is_http_and_an_incomplete_head_is_unknown() {
        let head = b"GET /admin/ HTTP/1.1\r\nHost: x\r\n\r\n";
        assert_eq!(classify(head, true), Protocol::Http);
        assert_eq!(classify(head, false), Protocol::Unknown);
        assert_eq!(classify(b"\x00\x01\x02", true), Protocol::Unknown);
    }

    #[test]
    fn the_head_s_terminator_is_found() {
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(18));
        assert_eq!(head_end(b"GET / HTTP/1.1\r\n"), None);
    }
}
