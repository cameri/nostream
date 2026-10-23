//! The per-socket state (R26): the subscription table, the NIP-42 session, the in-flight
//! read flags, and live dispatch over a real socket.
//!
//! Carries the state half of `test/unit/adapters/web-socket-adapter.spec.ts` (60) and
//! `message-handler-factory.spec.ts`'s dispatch ordering (6).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

mod common;

use std::sync::Arc;

use common::{CLIENT_SECRET, NOW_MS, NOW_SECS, Server, fast_config, relay_keys, signed_event};
use nostream_core::clock::TestClock;
use nostream_core::filter::Filter;
use nostream_core::messages::SubscribeMessage;
use nostream_core::{EventId, Pubkey};
use nostream_relay::connection::{Connection, Subscription};
use nostream_relay::sink::FrameSink;
use nostream_relay::testing::{Fixture, settings};

/// A relay carrying the test's signing key, so an accepted event reaches the default path.
async fn start(fixture: Fixture) -> Server {
    Server::start_with(fixture, relay_keys(), fast_config()).await
}

fn connection() -> Arc<Connection> {
    Arc::new(Connection::new(
        "127.0.0.1".to_owned(),
        nostream_core::nip42::Nip42Session::with_challenge("challenge", 0),
    ))
}

// ---------------------------------------------------------------------------------------
// The subscription table
// ---------------------------------------------------------------------------------------

#[test]
fn a_subscription_registers_once_and_an_identical_re_req_is_recognised() {
    let connection = connection();
    let filters = vec![Filter {
        kinds: Some(vec![nostream_core::Kind(1)]),
        ..Default::default()
    }];

    assert!(connection.subscription("s1").is_none());

    connection.subscribe(Subscription {
        id: "s1".to_owned(),
        filters: filters.clone(),
    });

    assert_eq!(connection.subscription_count(), 1);
    assert!(connection.has_identical_subscription("s1", &filters));
    assert!(connection.subscription("s1").is_some());
    assert!(connection.subscription("other").is_none());
}

#[test]
fn unsubscribing_removes_the_entry_and_reports_it() {
    let connection = connection();

    connection.subscribe(Subscription {
        id: "s1".to_owned(),
        filters: Vec::new(),
    });

    let removed = connection.unsubscribe("s1").expect("the subscription");

    assert_eq!(removed.id, "s1");
    assert_eq!(connection.subscription_count(), 0);
    assert!(connection.unsubscribe("s1").is_none());
}

#[test]
fn a_later_subscription_replaces_the_filters_under_the_same_id() {
    let connection = connection();
    let first = vec![Filter {
        kinds: Some(vec![nostream_core::Kind(1)]),
        ..Default::default()
    }];
    let second = vec![Filter {
        kinds: Some(vec![nostream_core::Kind(4)]),
        ..Default::default()
    }];

    connection.subscribe(Subscription {
        id: "s1".to_owned(),
        filters: first,
    });
    connection.subscribe(Subscription {
        id: "s1".to_owned(),
        filters: second.clone(),
    });

    assert_eq!(connection.subscription_count(), 1);
    assert_eq!(
        connection
            .subscription("s1")
            .map(|subscription| subscription.filters),
        Some(second)
    );
}

#[test]
fn matching_subscription_ids_are_returned_in_id_order() {
    let connection = connection();
    let note = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    connection.subscribe(Subscription {
        id: "note".to_owned(),
        filters: vec![Filter {
            kinds: Some(vec![nostream_core::Kind(1)]),
            ..Default::default()
        }],
    });
    connection.subscribe(Subscription {
        id: "channel".to_owned(),
        filters: vec![Filter {
            kinds: Some(vec![nostream_core::Kind(4)]),
            ..Default::default()
        }],
    });
    connection.subscribe(Subscription {
        id: "everything".to_owned(),
        filters: vec![Filter::default()],
    });

    // The table is keyed by subscription id, so the ids come back sorted.
    assert_eq!(
        connection.matching_subscription_ids(&note),
        vec!["everything".to_owned(), "note".to_owned()]
    );
}

// ---------------------------------------------------------------------------------------
// The NIP-42 session
// ---------------------------------------------------------------------------------------

#[test]
fn a_connection_starts_unauthenticated_with_its_challenge() {
    let connection = connection();

    assert_eq!(connection.challenge(), "challenge");
    assert!(connection.authenticated_pubkeys(NOW_SECS).is_empty());
    assert!(
        !connection
            .authenticated_pubkeys(NOW_SECS)
            .contains(&Pubkey::from_byte_array([7; 32]))
    );
}

#[test]
fn authenticating_records_the_pubkey_in_order_and_refuses_a_replay() {
    let connection = connection();
    let first = Pubkey::from_byte_array([1; 32]);
    let second = Pubkey::from_byte_array([2; 32]);

    assert!(connection.authenticate(first, EventId::from_byte_array([1; 32]), NOW_SECS));
    assert!(connection.authenticate(second, EventId::from_byte_array([2; 32]), NOW_SECS));
    assert!(
        !connection.authenticate(first, EventId::from_byte_array([1; 32]), NOW_SECS),
        "an auth event id is single use"
    );

    assert_eq!(
        connection.authenticated_pubkeys_in_order(NOW_SECS),
        vec![first, second]
    );
    assert!(connection.authenticated_pubkeys(NOW_SECS).contains(&first));
}

// ---------------------------------------------------------------------------------------
// In-flight reads and close (R26)
// ---------------------------------------------------------------------------------------

#[test]
fn a_read_is_in_flight_until_it_ends_and_an_abort_notifies_it() {
    let connection = connection();

    assert!(!connection.read_in_flight("s1"));

    let cancelled = connection.begin_read("s1");

    assert!(connection.read_in_flight("s1"));

    connection.abort_read("s1");

    assert!(*cancelled.borrow());
    assert!(!connection.read_in_flight("s1"));

    let cancelled = connection.begin_read("s2");
    connection.end_read("s2");

    assert!(!*cancelled.borrow());
    assert!(!connection.read_in_flight("s2"));
}

#[test]
fn close_clears_the_table_the_session_and_the_reads() {
    let connection = connection();
    let pubkey = Pubkey::from_byte_array([1; 32]);

    connection.subscribe(Subscription {
        id: "s1".to_owned(),
        filters: vec![Filter::default()],
    });
    connection.authenticate(pubkey, EventId::from_byte_array([1; 32]), NOW_SECS);
    let cancelled = connection.begin_read("s1");

    connection.close();

    assert_eq!(connection.subscription_count(), 0);
    assert!(connection.authenticated_pubkeys(NOW_SECS).is_empty());
    assert!(!connection.read_in_flight("s1"));
    assert!(*cancelled.borrow(), "an in-flight read is aborted");
}

// ---------------------------------------------------------------------------------------
// Live dispatch over a socket (R26)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn two_overlapping_subscriptions_both_receive_a_live_event() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","wide",{}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","wide"]"#);
    client.send(r#"["REQ","notes",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","notes"]"#);

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "live", NOW_SECS);

    client
        .send(&format!(
            r#"["EVENT",{}]"#,
            serde_json::to_string(&event).expect("event json")
        ))
        .await;

    // The author's own OK, then the event on each matching subscription in id order.
    assert_eq!(
        client.expect_frame().await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["EVENT","notes",{}]"#,
            serde_json::to_string(&event).expect("event json")
        )
    );
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["EVENT","wide",{}]"#,
            serde_json::to_string(&event).expect("event json")
        )
    );
}

#[tokio::test]
async fn a_non_matching_subscription_receives_nothing() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","channels",{"kinds":[4]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","channels"]"#);

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "not a channel", NOW_SECS);

    client
        .send(&format!(
            r#"["EVENT",{}]"#,
            serde_json::to_string(&event).expect("event json")
        ))
        .await;

    assert_eq!(
        client.expect_frame().await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );

    // A REQ proves the socket is still serving after the live dispatch produced no frame.
    client.send(r#"["REQ","probe",{"kinds":[1]}]"#).await;
    let frames = client.read_until_eose().await;

    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(
        frames[0],
        format!(
            r#"["EVENT","probe",{}]"#,
            serde_json::to_string(&event).expect("event json")
        )
    );
    assert_eq!(frames[1], r#"["EOSE","probe"]"#);
}

#[tokio::test]
async fn a_re_req_replaces_the_filters_so_only_the_new_set_receives() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[4]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);
    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "replaced", NOW_SECS);

    client
        .send(&format!(
            r#"["EVENT",{}]"#,
            serde_json::to_string(&event).expect("event json")
        ))
        .await;

    assert_eq!(
        client.expect_frame().await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["EVENT","s1",{}]"#,
            serde_json::to_string(&event).expect("event json")
        )
    );
}

#[tokio::test]
async fn a_close_leaves_the_other_subscriptions_untouched() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","a",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","a"]"#);
    client.send(r#"["REQ","b",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","b"]"#);

    client.send(r#"["CLOSE","a"]"#).await;

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "half", NOW_SECS);

    client
        .send(&format!(
            r#"["EVENT",{}]"#,
            serde_json::to_string(&event).expect("event json")
        ))
        .await;

    assert_eq!(
        client.expect_frame().await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["EVENT","b",{}]"#,
            serde_json::to_string(&event).expect("event json")
        )
    );
}

#[tokio::test]
async fn closing_the_socket_aborts_an_in_flight_read() {
    // A gated read holds inside the repository until a permit is released, which is the
    // window a socket close lands in.
    let fixture = Fixture::new(settings());
    let gate = fixture.events.gate_reads();
    fixture
        .seed_event(signed_event(&CLIENT_SECRET, 1, vec![], "stored", NOW_SECS))
        .await;

    let (sink, mut frames) = FrameSink::channel();
    let connection = Arc::new(Connection::new(
        "127.0.0.1".to_owned(),
        nostream_core::nip42::Nip42Session::with_challenge("challenge", 0),
    ));
    let context = Arc::new(fixture.context(
        Arc::new(TestClock::new(NOW_MS)),
        relay_keys(),
        Arc::clone(&connection),
        sink,
    ));

    let reading = tokio::spawn({
        let context = Arc::clone(&context);

        async move {
            nostream_relay::handlers::subscribe::handle(
                SubscribeMessage {
                    subscription_id: "s1".to_owned(),
                    filters: vec![Filter {
                        kinds: Some(vec![nostream_core::Kind(1)]),
                        ..Default::default()
                    }],
                },
                &context,
            )
            .await;
        }
    });

    // Let the handler register the subscription and reach the gated read.
    for _ in 0..100 {
        if connection.read_in_flight("s1") {
            break;
        }

        tokio::task::yield_now().await;
    }

    assert!(connection.read_in_flight("s1"), "the read is in flight");

    connection.close();
    gate.add_permits(1);
    reading
        .await
        .expect("the handler finishes once the read is released");

    assert!(
        frames.try_recv().is_err(),
        "a closed socket's read sends no frame"
    );
    assert_eq!(connection.subscription_count(), 0);
}

/// Starts a read that streams a public and then a restricted event, with the AUTH recorded
/// between the two when `authenticate_mid_read` is set, and returns the frames it produced.
///
/// The gate releases one record at a time, so the AUTH lands after the first record has been
/// judged and before the second one is.
async fn restricted_read_with(authenticate_mid_read: bool) -> Vec<String> {
    let mut configured = settings();
    let mut nip42 = nostream_relay::testing::nip42_settings();
    // A session that lasts: the settings fixture expires one at once, which is what most
    // AUTH tests want and this one does not.
    nip42.session_expiry_seconds = Some(3_600);
    configured.nip42 = Some(nip42);

    let fixture = Fixture::new(configured);
    let gate = fixture.events.gate_reads_per_item();
    fixture
        .seed_event(signed_event(&CLIENT_SECRET, 1, vec![], "public", NOW_SECS))
        .await;
    fixture
        .seed_event(signed_event(
            &CLIENT_SECRET,
            4,
            vec![],
            "encrypted",
            NOW_SECS,
        ))
        .await;

    let (sink, mut frames) = FrameSink::channel();
    // The session outlives the read: `Nip42Session` carries the TTL it was built with.
    let connection = Arc::new(Connection::new(
        "127.0.0.1".to_owned(),
        nostream_core::nip42::Nip42Session::with_challenge("challenge", 3_600),
    ));
    let context = Arc::new(fixture.context(
        Arc::new(TestClock::new(NOW_MS)),
        relay_keys(),
        Arc::clone(&connection),
        sink,
    ));

    let reading = tokio::spawn({
        let context = Arc::clone(&context);

        async move {
            nostream_relay::handlers::subscribe::handle(
                SubscribeMessage {
                    subscription_id: "restricted".to_owned(),
                    // A filter that names no kind is accepted while unauthenticated; the
                    // stream can still carry a restricted event, which the per-event guard is
                    // what withholds.
                    filters: vec![Filter::default()],
                },
                &context,
            )
            .await;
        }
    });

    for _ in 0..100 {
        if connection.read_in_flight("restricted") {
            break;
        }

        tokio::task::yield_now().await;
    }

    assert!(
        connection.read_in_flight("restricted"),
        "the read is in flight"
    );

    // The public record passes while the client is unauthenticated.
    gate.add_permits(1);

    let mut collected = Vec::new();
    for _ in 0..100 {
        if let Ok(frame) = frames.try_recv() {
            collected.push(frame);
            break;
        }

        tokio::task::yield_now().await;
    }

    assert_eq!(
        collected.len(),
        1,
        "the public record arrived: {collected:?}"
    );

    // The AUTH lands between the two records: the guard the read uses next is built after it,
    // as the capture's is (`createReadAuthorizationGuard(settings, () => getAuthenticatedPubkeys())`).
    if authenticate_mid_read {
        let now = i64::try_from(NOW_MS / 1_000).expect("seconds");
        let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("a pubkey");

        assert!(
            connection.authenticate(
                pubkey,
                nostream_core::event::EventId::from_byte_array([1; 32]),
                now,
            ),
            "the AUTH is recorded"
        );
    }

    gate.add_permits(1);
    reading.await.expect("the read finishes");
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    while let Ok(frame) = frames.try_recv() {
        collected.push(frame);
    }

    collected
}

#[tokio::test]
async fn a_restricted_read_is_judged_against_the_authenticated_set_at_each_event() {
    // No AUTH: the public record arrives and the restricted one is withheld.
    let withheld = restricted_read_with(false).await;

    assert_eq!(withheld.len(), 2, "{withheld:?}");
    assert!(withheld[0].starts_with(r#"["EVENT","restricted","#));
    assert!(withheld[0].contains("public"));
    assert_eq!(withheld[1], r#"["EOSE","restricted"]"#);

    // AUTH between the two records: the second one is delivered, which a guard built once per
    // read could not do.
    let authenticated = restricted_read_with(true).await;

    assert_eq!(authenticated.len(), 3, "{authenticated:?}");
    assert!(authenticated[0].starts_with(r#"["EVENT","restricted","#));
    assert!(authenticated[0].contains("public"));
    assert!(authenticated[1].starts_with(r#"["EVENT","restricted","#));
    assert!(authenticated[1].contains("encrypted"));
    assert_eq!(authenticated[2], r#"["EOSE","restricted"]"#);
}
