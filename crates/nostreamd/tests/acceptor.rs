//! The acceptor's drain behaviour.

// This integration-test target may unwrap: a failed assertion here is a failed test,
// which is the point. The allowance names this file rather than exempting test targets
// workspace-wide, so a new test file still has to ask.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use nostream_core::clock::TestClock;
use nostream_core::lifecycle::ShutdownState;
use nostream_relay::Relay;
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::testing::{Fixture, settings};
use nostreamd::Acceptor;

#[tokio::test]
async fn the_acceptor_binds_an_ephemeral_port_and_drains_on_shutdown() {
    let acceptor = Acceptor::bind("127.0.0.1:0".parse().expect("socket addr"))
        .await
        .expect("bind");
    let port = acceptor.local_addr().port();
    assert!(port > 0, "the ephemeral port resolved");

    let fixture = Fixture::new(settings());
    let relay = Relay::new(
        (*fixture.settings).clone(),
        Arc::clone(&fixture.stores),
        Arc::new(TestClock::new(1_700_000_000_000)),
        RelayKeySource::from_values(None, None),
        Arc::new(nostream_core::random::SystemRandom),
        // Explicit, so the suite's drain deadline is its own and not the environment's.
        nostream_relay::relay::RelayConfig {
            drain_timeout: std::time::Duration::from_millis(300),
            ..Default::default()
        },
    );

    let shutdown = ShutdownState::new();
    let connection_shutdown = shutdown.clone();
    let task = tokio::spawn(async move { acceptor.run(relay, connection_shutdown).await });

    // A socket connects and the relay's accept loop takes it. This socket is dropped before
    // the upgrade, so it proves the accept path was reached and the drain ends the loop; that
    // the wire answers with the NIP-42 challenge is `tests/wire.rs`'s.
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    drop(stream);

    tokio::time::sleep(Duration::from_millis(50)).await;

    shutdown.begin_draining();

    // The task ends within the deadline: serving reports no result, so the only thing left to
    // get wrong is a drain that never completes.
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the acceptor stops within two seconds")
        .expect("join");
}
