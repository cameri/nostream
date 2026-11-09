//! The vectors the audit found owed: one socket test per NIP that was live in the capture and
//! named by no test (`docs/rewrite/nip-parity.md` §9, R9).
//!
//! Five of these are passive accept-and-serve behaviours — the relay stores the NIP's event shape
//! and hands it back unchanged, which is the same shape the capture's own NIP-89 integration
//! feature takes (*"passive accept-and-serve"*). NIP-50 is a read-side behaviour with a runnable
//! in-memory oracle: `Filter::matches` implements the capture's search matcher. What no test here
//! reaches is NIP-50's **ranking**, which lives in the SQL backend's `ts_rank` and needs
//! Postgres, so it stays with the `#[ignore]`d `parity` target (`docs/rewrite/nip-parity.md`
//! §10).
//!
//! Each test proves the relay accepts and returns the NIP's shape. None proves the NIP's
//! client-side tag rules are enforced: kind 1111 stays on the default arm, and 31989/31990 are
//! addressable only because they fall in 30000-39999.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{CLIENT_SECRET, NOW_SECS, Server, fast_config, relay_keys, signed_event};
use nostream_config::Settings;
use nostream_core::Event;
use nostream_relay::testing::{Fixture, nip50_settings, settings};

/// A relay over `document` with the test relay key: without one, every publish is answered
/// `error: unable to process event` (the capture's missing-`SECRET` path).
async fn start(document: Settings) -> Server {
    Server::start_with(Fixture::new(document), relay_keys(), fast_config()).await
}

/// The shipped `nip50` document, whose `enabled` is unset and so off.
fn nip50_off() -> Settings {
    let mut settings = settings();
    settings.nip50 = Some(nip50_settings());

    settings
}

/// The same document with NIP-50 on.
fn nip50_on() -> Settings {
    let mut settings = settings();
    settings.nip50 = Some(nostream_config::settings::Nip50Settings {
        enabled: Some(true),
        ..nip50_settings()
    });

    settings
}

/// The event frame a client sends for one signed event.
fn event_frame(event: &Event) -> String {
    format!(
        r#"["EVENT",{}]"#,
        serde_json::to_string(event).expect("event json")
    )
}

/// The `OK` frame an accepted event's publish is answered with.
fn accepted(event: &Event) -> String {
    format!(r#"["OK","{}",true,""]"#, event.id)
}

/// Publishes each event, asserting the relay accepted it.
async fn publish(server: &Server, events: &[&Event]) {
    let (mut client, _challenge) = server.connect().await;

    for event in events {
        client.send(&event_frame(event)).await;

        assert_eq!(client.expect_frame().await, accepted(event));
    }
}

/// Reads `filters` on a fresh subscription and returns its frames, `EOSE` last.
async fn read(server: &Server, subscription_id: &str, filters: &str) -> Vec<String> {
    let (mut client, _challenge) = server.connect().await;

    client
        .send(&format!(r#"["REQ","{subscription_id}",{filters}]"#))
        .await;

    client.read_until_eose().await
}

// ---------------------------------------------------------------------------------------
// NIP-14 — Subject tag
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn nip14_a_kind_1_event_returns_its_subject_tag() {
    let server = start(settings()).await;
    let event = signed_event(
        &CLIENT_SECRET,
        1,
        vec![vec!["subject", "A test subject"]],
        "hello",
        NOW_SECS,
    );

    publish(&server, &[&event]).await;

    let frames = read(&server, "s1", r#"{"kinds":[1]}"#).await;

    assert_eq!(frames.len(), 2, "{frames:?}");
    assert!(frames[0].contains(r#""kind":1"#), "{}", frames[0]);
    assert!(
        frames[0].contains(r#"["subject","A test subject"]"#),
        "{}",
        frames[0]
    );
}

// ---------------------------------------------------------------------------------------
// NIP-22 — Comments (kind 1111)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn nip22_a_kind_1111_comment_is_stored_and_served_unchanged() {
    let server = start(settings()).await;
    let root = signed_event(&CLIENT_SECRET, 1, vec![], "the root note", NOW_SECS);
    let root_id = root.id.to_string();
    let root_author = root.pubkey.to_string();
    // The NIP's shape: the root scope in uppercase (`K`/`E`/`P`) and the parent scope in
    // lowercase (`k`/`e`/`p`). Here the comment replies to the root, so both scopes name it.
    let comment = signed_event(
        &CLIENT_SECRET,
        1111,
        vec![
            vec!["K", "1"],
            vec!["E", root_id.as_str()],
            vec!["P", root_author.as_str()],
            vec!["k", "1"],
            vec!["e", root_id.as_str()],
            vec!["p", root_author.as_str()],
        ],
        "a comment",
        NOW_SECS,
    );

    publish(&server, &[&root, &comment]).await;

    let frames = read(&server, "s1", r#"{"kinds":[1111]}"#).await;

    assert_eq!(frames.len(), 2, "{frames:?}");
    let expected = [
        r#"["K","1"]"#.to_owned(),
        format!(r#"["E","{root_id}"]"#),
        format!(r#"["P","{root_author}"]"#),
        r#"["k","1"]"#.to_owned(),
        format!(r#"["e","{root_id}"]"#),
        format!(r#"["p","{root_author}"]"#),
    ];

    for tag in expected {
        assert!(frames[0].contains(&tag), "{tag} missing from {}", frames[0]);
    }
}

// ---------------------------------------------------------------------------------------
// NIP-28 — Public chat channels (kinds 40, 41, 42)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn nip28_channel_metadata_is_replaceable_and_channel_events_are_not() {
    let server = start(settings()).await;
    let create = signed_event(
        &CLIENT_SECRET,
        40,
        vec![vec!["name", "the channel"]],
        "",
        NOW_SECS,
    );
    let channel_id = create.id.to_string();
    let metadata = signed_event(
        &CLIENT_SECRET,
        41,
        vec![vec!["e", channel_id.as_str()], vec!["name", "first name"]],
        "",
        NOW_SECS,
    );
    let message = signed_event(
        &CLIENT_SECRET,
        42,
        vec![vec!["e", channel_id.as_str()]],
        "hello channel",
        NOW_SECS,
    );
    // A newer kind 41 for the same author replaces the first.
    let newer_metadata = signed_event(
        &CLIENT_SECRET,
        41,
        vec![vec!["e", channel_id.as_str()], vec!["name", "second name"]],
        "",
        NOW_SECS + 1,
    );

    publish(&server, &[&create, &metadata, &message, &newer_metadata]).await;

    let frames = read(&server, "s1", r#"{"kinds":[40,41,42]}"#).await;

    assert_eq!(frames.len(), 4, "three events and the EOSE: {frames:?}");
    assert!(
        frames[..3]
            .iter()
            .any(|frame| frame.contains(&format!(r#""id":"{channel_id}""#)))
    );
    assert!(
        frames[..3]
            .iter()
            .any(|frame| frame.contains(&format!(r#""id":"{}""#, message.id)))
    );
    assert!(
        frames[..3]
            .iter()
            .any(|frame| frame.contains(&format!(r#""id":"{}""#, newer_metadata.id))),
        "the newer kind 41 replaced the first: {frames:?}"
    );
    assert!(
        !frames[..3]
            .iter()
            .any(|frame| frame.contains(&format!(r#""id":"{}""#, metadata.id))),
        "the replaced kind 41 is not served: {frames:?}"
    );
}

// ---------------------------------------------------------------------------------------
// NIP-50 — Search
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn nip50_a_search_filter_is_served_only_when_enabled() {
    let matching = signed_event(
        &CLIENT_SECRET,
        1,
        vec![],
        "a note about nostalgia",
        NOW_SECS,
    );
    let other = signed_event(
        &CLIENT_SECRET,
        1,
        vec![],
        "a note about something else",
        NOW_SECS,
    );

    // The shipped document has NIP-50 off, and the search criterion is dropped rather than
    // refused: the read is the plain kind-1 read.
    let off = start(nip50_off()).await;
    publish(&off, &[&matching, &other]).await;

    let frames = read(&off, "s1", r#"{"search":"nostalgia","kinds":[1]}"#).await;

    assert_eq!(frames.len(), 3, "both events with search off: {frames:?}");

    // With NIP-50 on, the matcher decides.
    let on = start(nip50_on()).await;
    publish(&on, &[&matching, &other]).await;

    let frames = read(&on, "s1", r#"{"search":"nostalgia","kinds":[1]}"#).await;

    assert_eq!(frames.len(), 2, "only the matching event: {frames:?}");
    assert!(
        frames[0].contains("nostalgia"),
        "the served event is the matching one: {}",
        frames[0]
    );
    assert_eq!(frames[1], r#"["EOSE","s1"]"#);
}

// ---------------------------------------------------------------------------------------
// NIP-65 — Relay lists (kind 10002)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn nip65_a_relay_list_is_stored_and_replaces_the_previous_one() {
    let server = start(settings()).await;
    let first = signed_event(
        &CLIENT_SECRET,
        10_002,
        vec![
            vec!["r", "wss://relay.one.example"],
            vec!["r", "wss://relay.two.example"],
            vec!["r", "wss://relay.three.example"],
            vec!["r", "wss://relay.four.example"],
        ],
        "",
        NOW_SECS,
    );
    let second = signed_event(
        &CLIENT_SECRET,
        10_002,
        vec![vec!["r", "wss://relay.five.example"]],
        "",
        NOW_SECS + 1,
    );

    publish(&server, &[&first, &second]).await;

    let frames = read(&server, "s1", r#"{"kinds":[10002]}"#).await;

    assert_eq!(frames.len(), 2, "one relay list and the EOSE: {frames:?}");
    assert!(frames[0].contains(&format!(r#""id":"{}""#, second.id)));
    assert!(!frames[0].contains(&format!(r#""id":"{}""#, first.id)));

    // NIP-65 makes every `r` value a URL, and the event schema is what refuses a bad one, before
    // any handler sees the event.
    let refused = signed_event(
        &CLIENT_SECRET,
        10_002,
        vec![vec!["r", "not a url"]],
        "",
        NOW_SECS + 2,
    );
    let (mut client, _challenge) = server.connect().await;

    client.send(&event_frame(&refused)).await;

    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","invalid: Invalid relay URL"]"#
    );
}

// ---------------------------------------------------------------------------------------
// NIP-89 — Recommended application handlers (kinds 31989, 31990)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn nip89_recommendation_and_handler_events_are_stored_and_served() {
    let server = start(settings()).await;
    let handler = signed_event(
        &CLIENT_SECRET,
        31_990,
        vec![
            vec!["d", "example-app"],
            vec!["k", "1"],
            vec!["web", "https://example.com/app"],
        ],
        "",
        NOW_SECS,
    );
    let address = format!("31990:{}:example-app", handler.pubkey);
    let recommendation = signed_event(
        &CLIENT_SECRET,
        31_989,
        vec![vec!["d", "1"], vec!["a", address.as_str()]],
        "",
        NOW_SECS,
    );
    // A second recommendation under the same `d` replaces the first, because 31989 is addressable.
    let newer_recommendation = signed_event(
        &CLIENT_SECRET,
        31_989,
        vec![vec!["d", "1"], vec!["a", address.as_str()], vec!["k", "1"]],
        "",
        NOW_SECS + 1,
    );

    publish(&server, &[&handler, &recommendation, &newer_recommendation]).await;

    let frames = read(&server, "s1", r#"{"kinds":[31989,31990]}"#).await;

    assert_eq!(frames.len(), 3, "both kinds and the EOSE: {frames:?}");
    assert!(frames[0].contains(&format!(r#""id":"{}""#, handler.id)));
    assert!(frames[1].contains(&format!(r#""id":"{}""#, newer_recommendation.id)));
    assert!(!frames[1].contains(&format!(r#""id":"{}""#, recommendation.id)));
}
