//! The fourteen event strategies, one test per case of the capture's fourteen spec files.
//!
//! Each test drives its arm directly — `<arm>::…Strategy.execute(&event, &context)` over a
//! [`Fixture`] whose sink is a [`FrameSink::channel`], so the frames it sent are readable — and
//! asserts an observable: the frames in order, the broadcast hub, or a recorded interaction with
//! its argument. No test opens a socket and no test needs a database.
//!
//! The capture's cases build events of the shape `{id: 'id', pubkey: 'pubkey'}`
//! (`delete-event-strategy.spec.ts:21-28`), which a Rust [`Event`] cannot hold. Each case is
//! rebuilt as a real event with 32-byte ids and the tags it needs: the census maps titles, not
//! case data.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use nostream_config::settings::{Nip56Settings, Settings};
use nostream_core::clock::TestClock;
use nostream_core::event::{EventId, Pubkey, Signature};
use nostream_core::messages::{CommandResult, RelayMessage};
use nostream_core::nip42::Nip42Session;
use nostream_core::{Event, Kind, SettingsPubkey};
use nostream_relay::connection::Connection;
use nostream_relay::error::RelayError;
use nostream_relay::handlers::HandlerContext;
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::sink::FrameSink;
use nostream_relay::strategies::EventStrategy;
use nostream_relay::strategies::contact_list::ContactListStrategy;
use nostream_relay::strategies::delete::DeleteStrategy;
use nostream_relay::strategies::dvm_job_request::DvmJobRequestStrategy;
use nostream_relay::strategies::ephemeral::EphemeralStrategy;
use nostream_relay::strategies::gift_wrap::GiftWrapStrategy;
use nostream_relay::strategies::group::GroupStrategy;
use nostream_relay::strategies::invite_request::InviteRequestStrategy;
use nostream_relay::strategies::join_request::JoinRequestStrategy;
use nostream_relay::strategies::leave_request::LeaveRequestStrategy;
use nostream_relay::strategies::parameterized_replaceable::ParameterizedReplaceableStrategy;
use nostream_relay::strategies::replaceable::ReplaceableStrategy;
use nostream_relay::strategies::report::ReportStrategy;
use nostream_relay::strategies::timestamp::TimestampStrategy;
use nostream_relay::strategies::vanish::VanishStrategy;
use nostream_relay::testing::{Fixture, UpsertFailure, hub_receiver, nip43_settings, settings};
use nostream_relay::unavailable::UnavailableWotGraph;
use nostream_storage::repositories::{
    CreateInviteCodeOptions, EventRecord, EventRepository, FieldUpdate, InviteCodeRepository,
    NewReport, ReportType, User, UserRepository,
};
use serde_json::json;
use tokio::sync::{broadcast, mpsc};

/// The instant every case runs at: 2023-11-14T22:13:20Z.
const NOW_SECS: i64 = 1_700_000_000;

/// The milliseconds of [`NOW_SECS`].
const NOW_MS: u64 = 1_700_000_000_000;

/// Another event id, for a case that needs a second one. The bytes spell hex letters, so a
/// case can also ask for its uppercase form.
fn other_event_id() -> EventId {
    EventId::from_byte_array([0xab; 32])
}

/// The pubkey every case signs with.
fn author() -> Pubkey {
    Pubkey::from_byte_array([0x22; 32])
}

/// `value` repeated to `width` hex characters.
fn hex(value: u8, width: usize) -> String {
    format!("{value:02x}").repeat(width / 2)
}

fn tag(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

/// A well-typed event at [`NOW_SECS`].
fn event(kind: u64, tags: Vec<Vec<String>>, content: &str) -> Event {
    Event {
        id: EventId::from_byte_array([0x11; 32]),
        pubkey: author(),
        created_at: NOW_SECS,
        kind: Kind(kind),
        tags,
        content: content.to_owned(),
        sig: Signature::from_byte_array([0x33; 64]),
    }
}

fn clock() -> Arc<TestClock> {
    Arc::new(TestClock::new(NOW_MS))
}

fn keys() -> RelayKeySource {
    RelayKeySource::from_values(None, None)
}

/// A context whose sink a test can read, with its frames.
fn socket(fixture: &Fixture) -> (HandlerContext, mpsc::UnboundedReceiver<String>) {
    let (sink, frames) = FrameSink::channel(64 * 1024, None);
    let connection = Arc::new(Connection::new(
        "127.0.0.1".to_owned(),
        Nip42Session::with_challenge("challenge", 0),
    ));

    (fixture.context(clock(), keys(), connection, sink), frames)
}

/// The same, with the socket authenticated as `pubkey`.
fn authenticated_socket(
    fixture: &Fixture,
    pubkey: Pubkey,
) -> (HandlerContext, mpsc::UnboundedReceiver<String>) {
    let (context, frames) = socket(fixture);

    context.connection.authenticate(
        pubkey,
        EventId::from_byte_array([0x09; 32]),
        context.now_secs(),
    );

    (context, frames)
}

/// Every frame the sink queued, in order.
fn frames(receiver: &mut mpsc::UnboundedReceiver<String>) -> Vec<String> {
    let mut queued = Vec::new();

    while let Ok(frame) = receiver.try_recv() {
        queued.push(frame);
    }

    queued
}

/// The `OK` frame `HandlerContext::send_ok` renders, through the same encoder.
fn ok_frame(event: &Event, accepted: bool, message: &str) -> String {
    RelayMessage::Ok(CommandResult {
        event_id: event.id,
        accepted,
        message: message.to_owned(),
        params: None,
    })
    .to_text()
}

/// The event the hub queued, if any.
fn broadcast(hub: &mut broadcast::Receiver<Arc<Event>>) -> Option<Event> {
    hub.try_recv().ok().map(|event| (*event).clone())
}

/// Settings with NIP-43 enabled.
fn nip43_on() -> Settings {
    let mut settings = settings();
    settings.nip43 = Some(nip43_settings());

    settings
}

/// Settings with NIP-56 on and the given trusted moderators.
fn nip56_on(trusted_moderators: Vec<Pubkey>, hide_actionable_reports: bool) -> Settings {
    let mut settings = settings();
    settings.nip56 = Some(Nip56Settings {
        enabled: true,
        trusted_moderators: trusted_moderators
            .into_iter()
            .map(|pubkey| SettingsPubkey(pubkey.to_string()))
            .collect(),
        hide_actionable_reports,
    });

    settings
}

/// A structurally valid NIP-44 v2 payload: version byte 2 and 98 more bytes, base64.
fn nip44_payload() -> String {
    let mut bytes = vec![2u8];
    bytes.resize(99, 0);

    STANDARD.encode(bytes)
}

// ---------------------------------------------------------------------------
// contact_list — `contact-list-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

/// The capture's kind-3 fixture: two follows and a tag that is not one.
fn contact_list_event() -> Event {
    event(
        3,
        vec![
            tag(&["p", &hex(0xaa, 64)]),
            tag(&["p", &hex(0xbb, 64)]),
            tag(&["e", &hex(0xcc, 64)]),
        ],
        "",
    )
}

#[tokio::test]
async fn contact_list_upserts_the_event() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = contact_list_event();

    ContactListStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event.clone()]);
    assert_eq!(
        fixture.events.upserts(),
        vec![vec![json!(author().to_string()), json!(3)]]
    );
}

#[tokio::test]
async fn contact_list_updates_the_wot_graph_with_the_p_tagged_pubkeys_when_newly_stored() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());

    ContactListStrategy
        .execute(&contact_list_event(), &context)
        .await
        .unwrap();

    assert_eq!(
        fixture.wot.follow_updates(),
        vec![(author(), vec![hex(0xaa, 64), hex(0xbb, 64)])]
    );
}

#[tokio::test]
async fn contact_list_broadcasts_the_event_when_newly_stored() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = contact_list_event();

    ContactListStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn contact_list_does_not_broadcast_or_update_the_wot_graph_when_the_event_is_a_duplicate() {
    let fixture = Fixture::new(settings());
    let event = contact_list_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    ContactListStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
    assert_eq!(fixture.wot.follow_updates(), Vec::new());
}

#[tokio::test]
async fn contact_list_does_not_fail_the_event_when_the_wot_graph_update_fails() {
    let fixture = Fixture::new(settings());
    fixture.wot.fail_updates();

    let (context, mut sink) = socket(&fixture);
    let event = contact_list_event();

    ContactListStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(fixture.wot.follow_updates().len(), 1);
}

#[tokio::test]
async fn contact_list_emits_a_rejection_when_the_event_already_exists() {
    let fixture = Fixture::new(settings());
    fixture.events.fail_upsert(UpsertFailure::DuplicateEvent);

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = contact_list_event();

    ContactListStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, false, "rejected: event already exists")]
    );
    assert_eq!(fixture.wot.follow_updates(), Vec::new());
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn contact_list_returns_an_error_on_an_unexpected_upsert_failure() {
    // The capture answers `error: <driver message>`; the port's `StorageError` forbids forwarding
    // backend text to a client, so the failure leaves `execute` and the handler answers
    // `error: unable to process event` (ADR 0006, R2).
    let fixture = Fixture::new(settings());
    fixture.events.fail_upsert(UpsertFailure::Unavailable);

    let (context, mut sink) = socket(&fixture);
    let event = contact_list_event();
    let outcome = ContactListStrategy.execute(&event, &context).await;

    assert!(matches!(outcome, Err(RelayError::Storage(_))));
    assert_eq!(frames(&mut sink), Vec::<String>::new());
}

// ---------------------------------------------------------------------------
// delete — `delete-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

/// The capture's kind-5 fixture: two 64-hex `e` tags.
fn delete_event() -> Event {
    event(
        5,
        vec![tag(&["e", &"0".repeat(64)]), tag(&["e", &"f".repeat(64)])],
        "",
    )
}

/// Two stored events of the author's, one per `e` tag of [`delete_event`].
fn stored_targets() -> Vec<Event> {
    vec![
        Event {
            id: "0".repeat(64).parse().unwrap(),
            ..event(1, Vec::new(), "first")
        },
        Event {
            id: "f".repeat(64).parse().unwrap(),
            ..event(1, Vec::new(), "second")
        },
    ]
}

#[tokio::test]
async fn delete_creates_the_event() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = delete_event();

    DeleteStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn delete_soft_deletes_the_events_its_e_tags_name() {
    let fixture = Fixture::new(settings());

    for target in stored_targets() {
        fixture.seed_event(target).await;
    }

    let (context, mut sink) = socket(&fixture);
    let event = delete_event();

    DeleteStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        fixture.events.deletes(),
        vec![(
            author(),
            vec![
                "0".repeat(64).parse().unwrap(),
                "f".repeat(64).parse().unwrap()
            ]
        )]
    );
    assert_eq!(fixture.events.live_events(), vec![event.clone()]);
    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
}

#[tokio::test]
async fn delete_does_not_delete_when_there_are_no_e_tags() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let mut event = delete_event();
    event.tags = Vec::new();

    DeleteStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.deletes(), Vec::new());
    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn delete_broadcasts_the_event_when_created() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = delete_event();

    DeleteStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn delete_does_not_broadcast_when_the_event_is_a_duplicate() {
    let fixture = Fixture::new(settings());
    let event = delete_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    DeleteStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn delete_returns_an_error_when_the_create_fails() {
    // The erase runs **before** the create, so a failed create leaves the deletions applied and
    // nothing answered (the capture's order; the spec's R11 note).
    let fixture = Fixture::new(settings());

    for target in stored_targets() {
        fixture.seed_event(target).await;
    }

    fixture.events.fail_create(true);

    let (context, mut sink) = socket(&fixture);
    let event = delete_event();
    let outcome = DeleteStrategy.execute(&event, &context).await;

    assert!(matches!(outcome, Err(RelayError::Storage(_))));
    assert_eq!(fixture.events.deletes().len(), 1);
    assert_eq!(frames(&mut sink), Vec::<String>::new());
}

// ---------------------------------------------------------------------------
// dvm_job_request — `dvm-job-request-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn dvm_event() -> Event {
    event(5000, Vec::new(), "")
}

#[tokio::test]
async fn dvm_job_request_creates_the_event() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = dvm_event();

    DvmJobRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn dvm_job_request_records_a_job_when_the_event_is_new() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = dvm_event();

    DvmJobRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    let jobs = fixture.dvm.jobs();

    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].id, event.id);
    assert_eq!(jobs[0].requester_pubkey, author());
    assert_eq!(jobs[0].kind, Kind(5000));
}

#[tokio::test]
async fn dvm_job_request_broadcasts_the_event_when_new() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = dvm_event();

    DvmJobRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn dvm_job_request_does_not_broadcast_or_record_a_job_when_the_event_is_a_duplicate() {
    let fixture = Fixture::new(settings());
    let event = dvm_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    DvmJobRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(fixture.dvm.jobs().len(), 0);
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn dvm_job_request_does_not_reject_the_event_when_job_recording_fails() {
    let fixture = Fixture::new(settings());
    fixture.dvm.fail_writes();

    let (context, mut sink) = socket(&fixture);
    let event = dvm_event();

    DvmJobRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(fixture.dvm.jobs().len(), 0);
}

#[tokio::test]
async fn dvm_job_request_returns_an_error_when_the_create_fails() {
    let fixture = Fixture::new(settings());
    fixture.events.fail_create(true);

    let context = fixture.anonymous_context(clock(), keys());
    let outcome = DvmJobRequestStrategy.execute(&dvm_event(), &context).await;

    assert!(matches!(outcome, Err(RelayError::Storage(_))));
    assert_eq!(fixture.dvm.jobs().len(), 0);
}

// ---------------------------------------------------------------------------
// ephemeral — `ephemeral-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ephemeral_sends_ok_and_broadcasts_without_storing() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = event(20_000, Vec::new(), "relayed once");

    EphemeralStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
    assert_eq!(fixture.events.events(), Vec::new());
}

// ---------------------------------------------------------------------------
// gift_wrap — `gift-wrap-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

/// The capture's valid wrap: one `p` tag and a NIP-44 v2 payload.
fn gift_wrap_event() -> Event {
    event(1059, vec![tag(&["p", &hex(0xaa, 64)])], &nip44_payload())
}

#[tokio::test]
async fn gift_wrap_stores_a_valid_wrap() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = gift_wrap_event();

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn gift_wrap_sends_ok_and_broadcasts_when_new() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = gift_wrap_event();

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn gift_wrap_answers_duplicate_without_broadcasting() {
    let fixture = Fixture::new(settings());
    let event = gift_wrap_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn gift_wrap_refuses_a_wrap_without_a_p_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = gift_wrap_event();
    event.tags = Vec::new();

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: gift wrap event (kind 1059) must have a p tag identifying the recipient"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn gift_wrap_refuses_multiple_p_tags() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = gift_wrap_event();
    event.tags = vec![tag(&["p", &hex(0xaa, 64)]), tag(&["p", &hex(0xbb, 64)])];

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: gift wrap event (kind 1059) must have exactly one p tag"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn gift_wrap_accepts_a_p_tag_with_a_relay_hint() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = gift_wrap_event();
    event.tags = vec![tag(&["p", &hex(0xaa, 64), "wss://inbox.example.com"])];

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn gift_wrap_refuses_empty_content() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = gift_wrap_event();
    event.content = String::new();

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: gift wrap content must be a valid NIP-44 v2 payload: unsupported encryption version"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn gift_wrap_refuses_plain_text_content() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = gift_wrap_event();
    event.content = "this is not encrypted".to_owned();

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: gift wrap content must be a valid NIP-44 v2 payload: invalid payload size"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn gift_wrap_refuses_a_hash_prefixed_content() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = gift_wrap_event();
    event.content = "#future-version-payload".to_owned();

    GiftWrapStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: gift wrap content must be a valid NIP-44 v2 payload: unsupported encryption version"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

// ---------------------------------------------------------------------------
// group — `group-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn group_event() -> Event {
    event(
        445,
        vec![tag(&["h", &hex(0xaa, 64)])],
        "base64encodedencryptedcontent",
    )
}

#[tokio::test]
async fn group_stores_a_valid_group_event() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = group_event();

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn group_sends_ok_and_broadcasts_when_new() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = group_event();

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn group_answers_duplicate_without_broadcasting() {
    let fixture = Fixture::new(settings());
    let event = group_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn group_accepts_an_expiration_tag_alongside_the_h_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![
        tag(&["h", &hex(0xaa, 64)]),
        tag(&["expiration", "9999999999"]),
    ];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn group_refuses_a_missing_h_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = Vec::new();

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) must have an h tag identifying the group"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_refuses_a_non_h_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["p", &hex(0xaa, 64)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) must have an h tag identifying the group"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_refuses_two_h_tags() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["h", &hex(0xaa, 64)]), tag(&["h", &hex(0xbb, 64)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) must have exactly one h tag"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_refuses_a_short_group_id() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["h", &"a".repeat(63)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) h tag must contain a valid 64-character lowercase hex group id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_refuses_a_long_group_id() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["h", &"a".repeat(65)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) h tag must contain a valid 64-character lowercase hex group id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_refuses_uppercase_hex() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["h", &"A".repeat(64)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) h tag must contain a valid 64-character lowercase hex group id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_refuses_a_non_hex_group_id() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["h", &"g".repeat(64)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: group event (kind 445) h tag must contain a valid 64-character lowercase hex group id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn group_accepts_lowercase_hex() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = group_event();
    event.tags = vec![tag(&["h", &"0123456789abcdef".repeat(4)])];

    GroupStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(fixture.events.events(), vec![event]);
}

// ---------------------------------------------------------------------------
// invite_request — `invite-request-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn invite_request_event() -> Event {
    event(28_935, vec![tag(&["claim", "forged-code"])], "")
}

#[tokio::test]
async fn invite_request_refuses_a_client_published_request() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let event = invite_request_event();

    InviteRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: kind 28935 is issued by the relay, request one with a REQ for kind 28935"
        )]
    );
}

#[tokio::test]
async fn invite_request_never_broadcasts() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = invite_request_event();

    InviteRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink).len(), 1);
    assert_eq!(broadcast(&mut hub), None);
}

// ---------------------------------------------------------------------------
// join_request — `join-request-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn join_request_event() -> Event {
    event(28_934, vec![tag(&["claim", "valid-code"])], "")
}

#[tokio::test]
async fn join_request_refuses_when_nip43_is_disabled() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = join_request_event();

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "restricted: NIP-43 is not enabled on this relay"
        )]
    );
}

#[tokio::test]
async fn join_request_refuses_a_stale_created_at() {
    let fixture = Fixture::new(nip43_on());
    let (context, mut sink) = authenticated_socket(&fixture, author());
    let mut event = join_request_event();
    event.created_at = NOW_SECS - 3600;

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: created_at is too far from the current time"
        )]
    );
}

#[tokio::test]
async fn join_request_refuses_an_unauthenticated_request() {
    let fixture = Fixture::new(nip43_on());
    let (context, mut sink) = socket(&fixture);
    let event = join_request_event();

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "auth-required: authentication required (NIP-42)"
        )]
    );
}

#[tokio::test]
async fn join_request_refuses_a_request_without_a_claim_tag() {
    let fixture = Fixture::new(nip43_on());
    let (context, mut sink) = authenticated_socket(&fixture, author());
    let mut event = join_request_event();
    event.tags = Vec::new();

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: join request requires a claim tag"
        )]
    );
}

#[tokio::test]
async fn join_request_answers_duplicate_when_already_admitted() {
    let fixture = Fixture::new(nip43_on());
    fixture.users.insert(User {
        pubkey: author(),
        is_admitted: true,
        is_vanished: false,
        balance: 0,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    });

    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = join_request_event();

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            true,
            "duplicate: you are already a member of this relay"
        )]
    );
    assert_eq!(fixture.invites.claims(), Vec::new());
}

#[tokio::test]
async fn join_request_refuses_an_unusable_invite_code() {
    let fixture = Fixture::new(nip43_on());
    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = join_request_event();

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "restricted: invalid or expired invite code"
        )]
    );
    assert_eq!(
        fixture.invites.claims(),
        vec![("valid-code".to_owned(), author())]
    );
}

#[tokio::test]
async fn the_join_request_admits_and_answers_with_the_welcome() {
    // The two observable halves of the four exempt cache titles (R11): the claim is spent, the
    // member is admitted, and the frame names the relay.
    let fixture = Fixture::new(nip43_on());
    fixture
        .invites
        .create(
            "valid-code",
            &CreateInviteCodeOptions {
                expires_at: None,
                remaining_uses: FieldUpdate::Set(1),
                created_by: None,
            },
        )
        .await
        .unwrap();

    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = join_request_event();

    JoinRequestStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            true,
            "info: welcome to wss://relay.example.com!"
        )]
    );

    let user = UserRepository::find_by_pubkey(fixture.users.as_ref(), &author())
        .await
        .unwrap();

    assert_eq!(user.map(|user| user.is_admitted), Some(true));
    assert_eq!(
        fixture.invites.claims(),
        vec![("valid-code".to_owned(), author())]
    );
}

// ---------------------------------------------------------------------------
// leave_request — `leave-request-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn leave_request_event() -> Event {
    event(28_936, vec![tag(&["-"])], "")
}

fn admitted_user() -> User {
    User {
        pubkey: author(),
        is_admitted: true,
        is_vanished: false,
        balance: 0,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
    }
}

#[tokio::test]
async fn leave_request_refuses_when_nip43_is_disabled() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = leave_request_event();

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "restricted: NIP-43 is not enabled on this relay"
        )]
    );
}

#[tokio::test]
async fn leave_request_refuses_a_request_without_the_protected_tag() {
    let fixture = Fixture::new(nip43_on());
    fixture.users.insert(admitted_user());

    let (context, mut sink) = authenticated_socket(&fixture, author());
    let mut event = leave_request_event();
    event.tags = Vec::new();

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: leave request requires a NIP-70 \"-\" tag"
        )]
    );

    let user = UserRepository::find_by_pubkey(fixture.users.as_ref(), &author())
        .await
        .unwrap();

    assert_eq!(user.map(|user| user.is_admitted), Some(true));
}

#[tokio::test]
async fn leave_request_refuses_a_stale_created_at() {
    let fixture = Fixture::new(nip43_on());
    fixture.users.insert(admitted_user());

    let (context, mut sink) = authenticated_socket(&fixture, author());
    let mut event = leave_request_event();
    event.created_at = NOW_SECS - 3600;

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: created_at is too far from the current time"
        )]
    );
}

#[tokio::test]
async fn leave_request_refuses_an_unauthenticated_request() {
    let fixture = Fixture::new(nip43_on());
    fixture.users.insert(admitted_user());

    let (context, mut sink) = socket(&fixture);
    let event = leave_request_event();

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "auth-required: authentication required (NIP-42)"
        )]
    );
}

#[tokio::test]
async fn leave_request_answers_ok_when_the_user_is_unknown() {
    let fixture = Fixture::new(nip43_on());
    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = leave_request_event();

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);

    let user = UserRepository::find_by_pubkey(fixture.users.as_ref(), &author())
        .await
        .unwrap();

    assert_eq!(user, None);
}

#[tokio::test]
async fn leave_request_answers_ok_when_the_user_is_not_admitted() {
    let fixture = Fixture::new(nip43_on());
    fixture.users.insert(User {
        is_admitted: false,
        ..admitted_user()
    });

    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = leave_request_event();

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
}

#[tokio::test]
async fn the_leave_request_revokes_the_admission() {
    // The observable half of the two exempt cache titles (R11).
    let fixture = Fixture::new(nip43_on());
    fixture.users.insert(admitted_user());

    let (context, mut sink) = authenticated_socket(&fixture, author());
    let event = leave_request_event();

    LeaveRequestStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);

    let user = UserRepository::find_by_pubkey(fixture.users.as_ref(), &author())
        .await
        .unwrap();

    assert_eq!(user.map(|user| user.is_admitted), Some(false));
}

// ---------------------------------------------------------------------------
// parameterized_replaceable — `parameterized-replaceable-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn parameterized_event(tags: Vec<Vec<String>>) -> Event {
    event(30_000, tags, "")
}

#[tokio::test]
async fn parameterized_replaceable_uses_an_empty_deduplication_key_without_a_d_tag() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = parameterized_event(Vec::new());

    ParameterizedReplaceableStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(fixture.events.upserts(), vec![vec![json!("")]]);
    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn parameterized_replaceable_uses_the_first_d_tag_value() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = parameterized_event(vec![tag(&["d", "one"])]);

    ParameterizedReplaceableStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(fixture.events.upserts(), vec![vec![json!("one")]]);
}

#[tokio::test]
async fn parameterized_replaceable_uses_only_the_first_d_tag_element() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = parameterized_event(vec![tag(&["d", "one", "two"])]);

    ParameterizedReplaceableStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(fixture.events.upserts(), vec![vec![json!("one")]]);
}

#[tokio::test]
async fn parameterized_replaceable_broadcasts_when_created() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = parameterized_event(vec![tag(&["d", "one"])]);

    ParameterizedReplaceableStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn parameterized_replaceable_does_not_broadcast_a_duplicate() {
    let fixture = Fixture::new(settings());
    let event = parameterized_event(vec![tag(&["d", "one"])]);

    // The conflict target is the deduplication key, so the stored row has to carry the key the
    // arm writes.
    EventRepository::upsert(
        fixture.events.as_ref(),
        &EventRecord::from_event(&event).with_deduplication(vec![json!("one")]),
    )
    .await
    .unwrap();

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    ParameterizedReplaceableStrategy
        .execute(&event, &context)
        .await
        .unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
    assert_eq!(
        fixture.events.upserts(),
        vec![vec![json!("one")], vec![json!("one")]]
    );
}

#[tokio::test]
async fn parameterized_replaceable_returns_an_error_when_the_upsert_fails() {
    let fixture = Fixture::new(settings());
    fixture.events.fail_upsert(UpsertFailure::Unavailable);

    let (context, mut sink) = socket(&fixture);
    let outcome = ParameterizedReplaceableStrategy
        .execute(&parameterized_event(vec![tag(&["d", "one"])]), &context)
        .await;

    assert!(matches!(outcome, Err(RelayError::Storage(_))));
    assert_eq!(frames(&mut sink), Vec::<String>::new());
}

// ---------------------------------------------------------------------------
// replaceable — `replaceable-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn replaceable_event() -> Event {
    event(0, Vec::new(), "{\"name\":\"relay\"}")
}

#[tokio::test]
async fn replaceable_upserts_the_event() {
    let fixture = Fixture::new(settings());
    let context = fixture.anonymous_context(clock(), keys());
    let event = replaceable_event();

    ReplaceableStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        fixture.events.upserts(),
        vec![vec![json!(author().to_string()), json!(0)]]
    );
    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn replaceable_broadcasts_when_new() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = replaceable_event();

    ReplaceableStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn replaceable_does_not_broadcast_when_the_stored_row_wins() {
    let fixture = Fixture::new(settings());
    let event = replaceable_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    ReplaceableStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn replaceable_returns_an_error_on_an_unexpected_upsert_failure() {
    // The capture answers `error: <driver message>`; the port's `StorageError` forbids forwarding
    // backend text, so that failure leaves `execute` (ADR 0006, R2). The one failure that *is* a
    // decision — the event id already exists — is still a refusal, and the capture has no case
    // for it here, so it is asserted beside the other.
    let fixture = Fixture::new(settings());
    fixture.events.fail_upsert(UpsertFailure::Unavailable);

    let (context, mut sink) = socket(&fixture);
    let event = replaceable_event();
    let outcome = ReplaceableStrategy.execute(&event, &context).await;

    assert!(matches!(outcome, Err(RelayError::Storage(_))));
    assert_eq!(frames(&mut sink), Vec::<String>::new());

    fixture.events.fail_upsert(UpsertFailure::DuplicateEvent);

    ReplaceableStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, false, "rejected: event already exists")]
    );
}

// ---------------------------------------------------------------------------
// report — `report-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

/// The capture's kind-1984 fixture: the author reports `reported` for spam.
fn report_event() -> Event {
    event(1984, vec![tag(&["p", &hex(0x33, 64), "spam"])], "")
}

/// The row the capture's fixture asserts for [`report_event`], at `weight`.
fn expected_report(weight: f32, actionable: bool) -> NewReport {
    NewReport {
        event_id: EventId::from_byte_array([0x11; 32]),
        reporter_pubkey: author(),
        reported_pubkey: Some(hex(0x33, 64).parse().unwrap()),
        reported_event_id: None,
        report_type: ReportType::Spam,
        weight,
        actionable,
    }
}

/// An event whose author is the reported pubkey, for the hidden-content assertion.
fn reported_authors_event() -> Event {
    Event {
        id: EventId::from_byte_array([0x77; 32]),
        pubkey: hex(0x33, 64).parse().unwrap(),
        ..event(1, Vec::new(), "reported")
    }
}

#[tokio::test]
async fn report_creates_the_event() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    let context = fixture.anonymous_context(clock(), keys());
    let event = report_event();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event]);
}

#[tokio::test]
async fn report_broadcasts_the_event_when_new() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = report_event();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn report_does_not_broadcast_or_record_a_duplicate() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    let event = report_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
    assert_eq!(fixture.reports.reports(), Vec::new());
}

#[tokio::test]
async fn report_records_full_weight_for_a_direct_follow() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    fixture.wot.set_distance(Some(1));

    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert_eq!(fixture.reports.reports(), vec![expected_report(1.0, false)]);
    assert_eq!(fixture.wot.distance_queries(), vec![author()]);
}

#[tokio::test]
async fn report_records_zero_weight_outside_the_graph() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert_eq!(fixture.reports.reports(), vec![expected_report(0.0, false)]);
    assert_eq!(fixture.wot.distance_queries(), vec![author()]);
}

#[tokio::test]
async fn report_is_stored_unweighted_when_the_graph_is_unavailable() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    let (mut context, mut sink) = socket(&fixture);
    context.wot = Arc::new(UnavailableWotGraph);

    // A daemon with no graph wired is the capture's disabled-WoT branch: no distance is known,
    // so the row is stored unweighted rather than the write being skipped.
    let event = report_event();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.reports.reports(), vec![expected_report(0.0, false)]);
    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
}

#[tokio::test]
async fn report_records_a_max_weight_actionable_row_for_a_moderator() {
    let fixture = Fixture::new(nip56_on(vec![author()], false));
    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert_eq!(fixture.reports.reports(), vec![expected_report(1.0, true)]);
}

#[tokio::test]
async fn report_marks_the_target_hidden_when_hiding_is_enabled() {
    let fixture = Fixture::new(nip56_on(vec![author()], true));
    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert!(fixture.hidden.is_hidden(&reported_authors_event()));
}

#[tokio::test]
async fn report_does_not_mark_the_target_when_hiding_is_disabled() {
    let fixture = Fixture::new(nip56_on(vec![author()], false));
    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert_eq!(fixture.reports.reports().len(), 1);
    assert!(!fixture.hidden.is_hidden(&reported_authors_event()));
}

#[tokio::test]
async fn report_does_not_mark_the_target_for_a_non_moderator() {
    let fixture = Fixture::new(nip56_on(Vec::new(), true));
    fixture.wot.set_distance(Some(1));

    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert_eq!(fixture.reports.reports().len(), 1);
    assert!(!fixture.hidden.is_hidden(&reported_authors_event()));
}

#[tokio::test]
async fn report_does_not_consult_the_graph_for_a_moderator() {
    let fixture = Fixture::new(nip56_on(vec![author()], false));
    let context = fixture.anonymous_context(clock(), keys());

    ReportStrategy
        .execute(&report_event(), &context)
        .await
        .unwrap();

    assert_eq!(fixture.wot.distance_queries(), Vec::new());
}

#[tokio::test]
async fn report_records_nothing_without_a_valid_target() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    let context = fixture.anonymous_context(clock(), keys());
    let mut event = report_event();
    event.tags = Vec::new();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.reports.reports(), Vec::new());
}

#[tokio::test]
async fn report_records_nothing_for_a_moderator_without_a_valid_target() {
    let fixture = Fixture::new(nip56_on(vec![author()], false));
    let context = fixture.anonymous_context(clock(), keys());
    let mut event = report_event();
    event.tags = Vec::new();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.reports.reports(), Vec::new());
}

#[tokio::test]
async fn report_records_one_row_per_target_in_one_batch() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    fixture.wot.set_distance(Some(1));

    let context = fixture.anonymous_context(clock(), keys());
    let mut event = report_event();
    event.tags = vec![
        tag(&["p", &hex(0x33, 64), "impersonation"]),
        tag(&["e", &other_event_id().to_string(), "nudity"]),
    ];

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.reports.report_writes().len(), 1);
    assert_eq!(
        fixture.reports.reports(),
        vec![
            NewReport {
                reported_pubkey: None,
                reported_event_id: Some(other_event_id()),
                report_type: ReportType::Nudity,
                ..expected_report(1.0, false)
            },
            NewReport {
                reported_event_id: None,
                report_type: ReportType::Impersonation,
                ..expected_report(1.0, false)
            },
        ]
    );
}

#[tokio::test]
async fn report_stores_the_event_without_scoring_when_nip56_is_off() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = report_event();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event.clone()]);
    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
    assert_eq!(fixture.reports.reports(), Vec::new());
    assert_eq!(fixture.wot.distance_queries(), Vec::new());
}

#[tokio::test]
async fn report_does_not_reject_the_event_when_recording_fails() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    fixture.reports.fail_writes();

    let (context, mut sink) = socket(&fixture);
    let event = report_event();

    ReportStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(fixture.reports.reports(), Vec::new());
}

#[tokio::test]
async fn report_returns_an_error_when_the_create_fails() {
    let fixture = Fixture::new(nip56_on(Vec::new(), false));
    fixture.events.fail_create(true);

    let context = fixture.anonymous_context(clock(), keys());
    let outcome = ReportStrategy.execute(&report_event(), &context).await;

    assert!(matches!(outcome, Err(RelayError::Storage(_))));
    assert_eq!(fixture.reports.reports(), Vec::new());
}

// ---------------------------------------------------------------------------
// timestamp — `timestamp-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

/// The 31-byte `.ots` magic header (`src/utils/nip03.ts:27-30`).
const OTS_MAGIC: [u8; 31] = [
    0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
    0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
];

/// The Bitcoin block-header attestation tag.
const OTS_BITCOIN_TAG: [u8; 8] = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];

/// The sha256 file-hash op.
const OTS_OP_SHA256: u8 = 0x08;

fn write_varuint(mut value: u64) -> Vec<u8> {
    let mut out = Vec::new();

    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;

        if value != 0 {
            byte |= 0x80;
        }

        out.push(byte);

        if value == 0 {
            return out;
        }
    }
}

fn bitcoin_attestation(block_height: u64) -> Vec<u8> {
    let payload = write_varuint(block_height);
    let mut bytes = vec![0x00];
    bytes.extend(OTS_BITCOIN_TAG);
    bytes.extend(write_varuint(payload.len() as u64));
    bytes.extend(payload);

    bytes
}

/// A valid proof whose file digest is `digest` (`buildValidOtsForDigest`,
/// `timestamp-event-strategy.spec.ts:56-60`).
fn valid_ots_for(digest: &EventId) -> String {
    let mut bytes = OTS_MAGIC.to_vec();
    bytes.push(1);
    bytes.push(OTS_OP_SHA256);
    bytes.extend(digest.as_bytes());
    bytes.extend(bitcoin_attestation(810_391));

    STANDARD.encode(bytes)
}

/// The attested event id: a 32-byte id the helper can build a proof for.
fn attested_id() -> EventId {
    other_event_id()
}

fn timestamp_event() -> Event {
    event(
        1040,
        vec![
            tag(&["e", &attested_id().to_string(), "wss://relay.example.com"]),
            tag(&["k", "1"]),
        ],
        &valid_ots_for(&attested_id()),
    )
}

#[tokio::test]
async fn timestamp_stores_and_broadcasts_a_valid_proof() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = timestamp_event();

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event.clone()]);
    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
    assert_eq!(broadcast(&mut hub), Some(event));
}

#[tokio::test]
async fn timestamp_answers_duplicate_without_broadcasting() {
    let fixture = Fixture::new(settings());
    let event = timestamp_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn timestamp_accepts_an_event_without_a_k_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![tag(&["e", &attested_id().to_string()])];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(fixture.events.events(), vec![event.clone()]);
    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
}

#[tokio::test]
async fn timestamp_refuses_a_missing_e_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = Vec::new();

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps event (kind 1040) must have an e tag referencing the attested event"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_multiple_e_tags() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![
        tag(&["e", &attested_id().to_string()]),
        tag(&["e", &hex(0xbb, 64)]),
    ];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps event (kind 1040) must reference exactly one event"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_a_malformed_e_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![tag(&["e", "not-a-hex-id"])];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps e tag must contain a 32-byte lowercase hex event id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_uppercase_hex_in_the_e_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![tag(&["e", &attested_id().to_string().to_uppercase()])];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps e tag must contain a 32-byte lowercase hex event id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_a_non_integer_k_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![
        tag(&["e", &attested_id().to_string()]),
        tag(&["k", "banana"]),
    ];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps k tag must be a non-negative integer kind"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_a_negative_k_tag() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![tag(&["e", &attested_id().to_string()]), tag(&["k", "-1"])];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps k tag must be a non-negative integer kind"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_multiple_k_tags() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.tags = vec![
        tag(&["e", &attested_id().to_string()]),
        tag(&["k", "1"]),
        tag(&["k", "2"]),
    ];

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: opentimestamps event (kind 1040) must have at most one k tag"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_a_mismatched_ots_digest() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.content = valid_ots_for(&EventId::from_byte_array([0xdd; 32]));

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: ots proof digest does not match the referenced event id"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_content_that_is_not_an_ots_proof() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.content =
        STANDARD.encode(b"this is long enough to reach the header check, but it is not a proof");

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: invalid ots proof: invalid ots magic header"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

#[tokio::test]
async fn timestamp_refuses_empty_content() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut event = timestamp_event();
    event.content = String::new();

    TimestampStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(
            &event,
            false,
            "invalid: content is empty; expected base64-encoded ots file"
        )]
    );
    assert_eq!(fixture.events.events(), Vec::new());
}

// ---------------------------------------------------------------------------
// vanish — `vanish-event-strategy.spec.ts`
// ---------------------------------------------------------------------------

fn vanish_event() -> Event {
    event(62, vec![tag(&["r", "relay_url"])], "")
}

#[tokio::test]
async fn vanish_soft_deletes_the_other_events_and_stores_the_request() {
    let fixture = Fixture::new(settings());

    for (id, content) in [(0x01u8, "first"), (0x02u8, "second")] {
        fixture
            .seed_event(Event {
                id: EventId::from_byte_array([id; 32]),
                ..event(1, Vec::new(), content)
            })
            .await;
    }

    let (context, mut sink) = socket(&fixture);
    let event = vanish_event();

    VanishStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        fixture.events.delete_except_kinds_calls(),
        vec![(author(), vec![Kind::REQUEST_TO_VANISH])]
    );
    assert_eq!(fixture.events.live_events(), vec![event.clone()]);
    assert_eq!(fixture.users.vanish_calls(), vec![(author(), true)]);
    assert_eq!(frames(&mut sink), vec![ok_frame(&event, true, "")]);
}

#[tokio::test]
async fn vanish_never_broadcasts() {
    let fixture = Fixture::new(settings());
    let (context, mut sink) = socket(&fixture);
    let mut hub = hub_receiver(&fixture.hub);
    let event = vanish_event();

    VanishStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(frames(&mut sink).len(), 1);
    assert_eq!(broadcast(&mut hub), None);
}

#[tokio::test]
async fn vanish_answers_duplicate_when_the_request_exists() {
    let fixture = Fixture::new(settings());
    let event = vanish_event();
    fixture.seed_event(event.clone()).await;

    let (context, mut sink) = socket(&fixture);

    VanishStrategy.execute(&event, &context).await.unwrap();

    assert_eq!(
        frames(&mut sink),
        vec![ok_frame(&event, true, "duplicate:")]
    );
}
