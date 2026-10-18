//! The drain flag must survive a drain that starts before any subscriber exists.

use nostream_core::lifecycle::ShutdownState;

#[tokio::test]
async fn begin_draining_before_any_subscriber_is_not_lost() {
    let state = ShutdownState::new();
    // No watch() has been called: receiver_count() is 0, the case where Sender::send
    // short-circuits.
    state.begin_draining();
    assert!(state.is_draining());
    tokio::time::timeout(std::time::Duration::from_secs(1), state.wait_for_drain())
        .await
        .expect("wait_for_drain resolves")
}

#[tokio::test]
async fn wait_for_drain_after_a_subscriber_arrives() {
    let state = ShutdownState::new();
    let watcher = state.clone();
    let waiter = tokio::spawn(async move { watcher.wait_for_drain().await });
    state.begin_draining();
    tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
        .await
        .expect("the waiter resolves")
        .expect("join");
}
