//! AC16 — the metrics stream: `text/event-stream`, one frame immediately and one per interval,
//! each parsing as the shape R7 orders (D5's `unavailable` snapshot).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::Duration;

use common::{Fixture, TestServer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Reads one `data: …\n\n` frame from the stream.
async fn read_frame(stream: &mut TcpStream) -> String {
    let mut frame = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = stream.read(&mut byte).await.expect("a frame byte");
        if read == 0 {
            break;
        }
        frame.push(byte[0]);
        if frame.ends_with(b"\n\n") {
            break;
        }
    }
    String::from_utf8_lossy(&frame).into_owned()
}

fn payload(frame: &str) -> serde_json::Value {
    let line = frame
        .lines()
        .find(|line| line.starts_with("data: "))
        .unwrap_or_else(|| panic!("a data frame: {frame:?}"));
    serde_json::from_str(&line["data: ".len()..]).expect("the frame parses as JSON")
}

#[tokio::test]
async fn the_stream_opens_with_the_unavailable_snapshot_and_repeats_it() {
    let interval = Duration::from_millis(1_000);
    let fixture = Fixture {
        metrics_interval: interval,
        ..Fixture::default()
    };
    let server = TestServer::start_with(fixture).await;
    let cookie = server.login().await;

    let mut stream = TcpStream::connect(server.addr).await.expect("connect");
    let request =
        format!("GET /admin/metrics HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {cookie}\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();

    let head = common::read_head(&mut stream).await;
    let (status, headers) = common::parse_head(&head);
    assert_eq!(status, 200);
    let header = |name: &str| {
        headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(
        header("content-type"),
        Some("text/event-stream; charset=utf-8")
    );
    assert_eq!(header("cache-control"), Some("no-cache, no-transform"));
    assert!(
        header("connection").is_some_and(|value| value.starts_with("keep-alive")),
        "{:?}",
        header("connection")
    );

    let first = tokio::time::timeout(Duration::from_secs(1), read_frame(&mut stream))
        .await
        .expect("the first frame within a second");
    let snapshot = payload(&first);
    assert_eq!(snapshot["status"], "unavailable");
    let metrics = snapshot["metrics"].as_object().expect("metrics");
    assert_eq!(metrics.len(), 7);
    for key in [
        "eventsPerSecond",
        "eventsRejectedPerSecond",
        "eventsAcceptedTotal",
        "eventsRejectedTotal",
        "activeConnections",
        "cpuLoadPercent",
        "memoryUsedMb",
    ] {
        assert!(metrics[key].is_number(), "{key} is numeric");
    }
    assert_eq!(snapshot["prometheus"]["available"], false);
    assert!(snapshot["prometheus"]["error"].is_string());
    assert!(snapshot["health"]["database"]["ok"].is_boolean());
    assert_eq!(snapshot["health"]["redis"]["ok"], false);
    assert!(snapshot["timestamp"].as_u64().unwrap() >= common::NOW_MS);

    let second = tokio::time::timeout(interval + Duration::from_secs(1), read_frame(&mut stream))
        .await
        .expect("a second frame within the interval");
    assert_eq!(payload(&second)["status"], "unavailable");
}
