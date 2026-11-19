//! AC8 — one listener, one port, in the real binary: the admin surface answers HTTP and the
//! WebSocket upgrade answers the wire on the same socket (D1, R1).
//!
//! | case | what it proves |
//! |---|---|
//! | `the_daemon_serves_the_admin_page_and_the_wire_on_one_port` | `GET /admin/` is HTML, `GET /admin/session` without a cookie is 401, and a WebSocket client's first frame is the NIP-42 challenge |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::net::{SocketAddr, TcpListener};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The daemon child, killed when the test ends.
struct Daemon {
    child: Child,
    port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The fixture password hash `hashAdminPassword` writes for `hunter2` (salt `0x07`).
const PASSWORD_HASH: &str = "scrypt:BwcHBwcHBwcHBwcHBwcHBw==:r5daXU05UJ9EUDu45YoHMWUoQCmkVbwINYNntY1/dwrJPOt3fTi/1IWw1wp9+YXRj1Vm6IpFi+gSU0JdqZvWIw==";

/// Starts `nostreamd` on a port it took from an ephemeral bind and released.
fn start_daemon() -> (Daemon, tempfile::TempDir) {
    let temp = tempfile::tempdir().expect("tempdir");
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).expect("config dir");

    // The port is taken and released, as the task asks: the daemon binds it next.
    let listener = TcpListener::bind("127.0.0.1:0").expect("an ephemeral port");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    let settings = format!(
        "info:\n  name: Example\n  relay_url: ws://127.0.0.1:{port}\nadmin:\n  enabled: true\n  passwordHash: \"{PASSWORD_HASH}\"\n"
    );
    let mut file = std::fs::File::create(config_dir.join("settings.yaml")).expect("settings");
    file.write_all(settings.as_bytes()).expect("write settings");

    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let child = Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .arg("--config-dir")
        .arg(&config_dir)
        .arg("--listen-port")
        .arg(port.to_string())
        .arg("--log-level")
        .arg("info")
        .current_dir(&workspace)
        .env("SECRET", "a-test-secret")
        // One runtime worker, so a verification that ran on the runtime would stall the
        // listener: `main.rs` builds the runtime with `.worker_threads(WORKER_COUNT)`.
        .env("WORKER_COUNT", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the daemon starts");

    (Daemon { child, port }, temp)
}

/// One HTTP/1.1 request, returning the status and the body.
async fn request(port: u16, path: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let head = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await.expect("write");
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    (status, body)
}

/// One `POST` with a JSON body, returning the status and the body.
async fn post_json(port: u16, path: &str, body: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(head.as_bytes()).await.expect("write");
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(30), stream.read_to_end(&mut response)).await;
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    (status, body)
}

/// Polls `GET /admin/session` until the daemon answers, or ten seconds pass.
async fn wait_for_daemon(port: u16) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = 0u16;
    while Instant::now() < deadline {
        if let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>()
            && tokio::net::TcpStream::connect(addr).await.is_ok()
        {
            let (status, _) = request(port, "/admin/session").await;
            if status != 0 {
                return status;
            }
            last = status;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    last
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_serves_the_admin_page_and_the_wire_on_one_port() {
    let (daemon, _temp) = start_daemon();
    let port = daemon.port;

    let session_status = wait_for_daemon(port).await;
    assert_eq!(session_status, 401, "GET /admin/session without a cookie");

    let (status, body) = request(port, "/admin/session").await;
    assert_eq!(status, 401);
    assert_eq!(body, "{\"error\":\"Unauthorized\"}");

    let (status, body) = request(port, "/admin/").await;
    assert_eq!(status, 200, "GET /admin/");
    assert!(
        body.starts_with("<!DOCTYPE html>"),
        "the page is HTML: {}",
        &body[..body.len().min(80)]
    );
    assert!(
        body.contains("/admin/assets/dashboard.js"),
        "the page's scripts"
    );

    // The same port still speaks the wire: the first frame is the NIP-42 challenge.
    let (mut client, _response) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/"))
            .await
            .expect("the WebSocket handshake");
    use futures_util::StreamExt;
    let message = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("a frame within two seconds")
        .expect("a frame")
        .expect("a text frame");
    let text = message.to_string();
    assert!(
        text.starts_with("[\"AUTH\",\""),
        "the NIP-42 challenge is the first frame: {text}"
    );

    // A path outside the admin surface is an HTTP 404, not a dropped socket.
    let (status, body) = request(port, "/healthz").await;
    assert_eq!(status, 404, "the daemon is an HTTP server with one mount");
    assert_eq!(body, "Not Found");
}

/// D15 — scrypt runs on the blocking pool. With **one** runtime worker (`WORKER_COUNT=1`, the
/// value `main.rs` hands `.worker_threads`), a verification that ran on the runtime would leave
/// the listener unable to answer until it finished: measured, the synchronous path returns from
/// `GET /admin/session` after about 1.7 s, and the offloaded one in about 13 ms. The bound is
/// **500 ms** — far above the offload's cost and far below the synchronous path's.
#[tokio::test(flavor = "multi_thread")]
async fn a_login_verification_does_not_stall_the_listener() {
    let (daemon, _temp) = start_daemon();
    let port = daemon.port;
    assert_eq!(wait_for_daemon(port).await, 401);

    // The wire is live before the login starts: the NIP-42 challenge is the first frame.
    let (mut client, _response) =
        tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/"))
            .await
            .expect("the WebSocket handshake");
    use futures_util::StreamExt;
    let challenge = tokio::time::timeout(Duration::from_secs(2), client.next())
        .await
        .expect("the NIP-42 challenge")
        .expect("a frame")
        .expect("a text frame");
    assert!(challenge.to_string().starts_with("[\"AUTH\",\""));

    let login =
        tokio::spawn(
            async move { post_json(port, "/admin/login", "{\"password\":\"hunter2\"}").await },
        );
    // Let the request reach the daemon before the probe goes out.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let started = Instant::now();
    let (status, _body) = request(port, "/admin/session").await;
    let elapsed = started.elapsed();
    println!("listener answered in {elapsed:?}");
    assert_eq!(status, 401, "the listener answered during the verification");
    assert!(
        elapsed < Duration::from_millis(500),
        "the listener answered in {elapsed:?} with one runtime worker; the bound is 500 ms \
         (offload ~13 ms, a verification on the runtime ~1.7 s)"
    );

    let (status, _body) = login.await.expect("the login task");
    assert_eq!(
        status, 200,
        "the login completes after the listener answered"
    );
}
