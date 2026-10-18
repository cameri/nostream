//! The acceptor's drain behaviour.

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use nostream_core::lifecycle::ShutdownState;
use nostreamd::Acceptor;

#[tokio::test]
async fn the_acceptor_binds_an_ephemeral_port_and_drains_on_shutdown() {
    let acceptor = Acceptor::bind("127.0.0.1:0".parse().expect("socket addr"))
        .await
        .expect("bind");
    let port = acceptor.local_addr().port();
    assert!(port > 0, "the ephemeral port resolved");

    let shutdown = ShutdownState::new();
    let watch_rx = shutdown.watch();

    let task = tokio::spawn(async move { acceptor.run(watch_rx).await });

    // A socket connects and is dropped (Phase 1 accepts and drops; the wire is Phase 2).
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    drop(stream);

    tokio::time::sleep(Duration::from_millis(50)).await;

    shutdown.begin_draining();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the acceptor stops within two seconds")
        .expect("join");
    assert!(result.is_ok(), "the acceptor drained cleanly");
}
