//! The five handlers over a real socket. Carries the behaviour of
//! `test/unit/handlers/event-message-handler.spec.ts` (200 cases),
//! `subscribe-message-handler.spec.ts` (58), `count-message-handler.spec.ts` (10),
//! `auth-message-handler.spec.ts` (12) and `unsubscribe-message-handler.spec.ts` (1). One
//! exception, `a_close_during_the_invite_mint_leaves_the_event_but_not_the_read`,
//! drives the two handlers directly so its `CLOSE` is ordered against a held mint by
//! program order, not a timer.
//!
//! Every assertion is a frame as received, byte for byte, which is what makes these a port
//! rather than an approximation. The EVENT pipeline's reason strings are pinned one test per
//! string, so `wire_parity -- event-rejections` can carry the same table to the differential
//! oracle.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{CLIENT_SECRET, NOW_MS, NOW_SECS, RELAY_SECRET, Server, relay_keys, signed_event};
use nostream_config::settings::{
    ClientLimits, ClientSubscriptionLimits, ConnectionLimits, CreatedAtLimits, EventIdLimits,
    EventLimits, EventRateLimit, KindLimits, Limits, MessageLimits, MessageRateLimit,
    Nip05Settings, Payments, PubkeyLimits, RateLimit,
};
use nostream_core::Event;
use nostream_core::clock::TestClock;
use nostream_core::filter::Filter;
use nostream_core::messages::{SubscribeMessage, UnsubscribeMessage};
use nostream_relay::connection::Connection;
use nostream_relay::relay_key::RelayKeySource;
use nostream_relay::sink::FrameSink;
use nostream_relay::testing::{Fixture, nip42_settings, nip43_settings, nip45_settings, settings};
use nostream_storage::repositories::User;

/// The relay's public key for [`RELAY_SECRET`].
fn relay_pubkey() -> nostream_core::Pubkey {
    nostream_core::crypto::public_key(&RELAY_SECRET).expect("relay public key")
}

/// The event frame a client sends for one signed event.
fn event_frame(event: &Event) -> String {
    format!(
        r#"["EVENT",{}]"#,
        serde_json::to_string(event).expect("event json")
    )
}

/// A settings document with a limit block.
fn settings_with(limits: Limits) -> nostream_config::Settings {
    let mut settings = settings();
    settings.limits = Some(limits);

    settings
}

fn event_limits(event: EventLimits) -> Limits {
    Limits {
        event: Some(event),
        ..Default::default()
    }
}

/// Starts a relay with the test key source.
async fn start(fixture: Fixture) -> Server {
    Server::start_with(fixture, relay_keys(), common::fast_config()).await
}

/// Sends one EVENT and returns its OK frame.
async fn send_event(server: &Server, event: &Event) -> String {
    let (mut client, _challenge) = server.connect().await;

    client.send(&event_frame(event)).await;

    client.expect_frame().await
}

/// The text frames that arrive within `window`, read straight off the socket so a test can
/// bound a silence shorter than `Client::next_message`'s two-second deadline.
async fn frames_within(client: &mut common::Client, window: Duration) -> Vec<String> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let deadline = tokio::time::Instant::now() + window;
    let stream = client.stream();
    let mut frames = Vec::new();

    while let Ok(Some(Ok(message))) = tokio::time::timeout_at(deadline, stream.next()).await {
        if let Message::Text(text) = message {
            frames.push(text.as_str().to_owned());
        }
    }

    frames
}

/// Whether a frame names the closed subscription: a live dispatch to it, or its `EOSE`.
fn names_s1(frame: &str) -> bool {
    frame.starts_with(r#"["EVENT","s1""#) || frame == r#"["EOSE","s1"]"#
}

// ---------------------------------------------------------------------------------------
// EVENT (R9)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn event_id_mismatch_is_rejected() {
    let server = start(Fixture::new(settings())).await;
    let mut event = signed_event(&CLIENT_SECRET, 1, vec![], "hello", NOW_SECS);
    event.content = "tampered".to_owned();

    let frame = send_event(&server, &event).await;

    assert_eq!(
        frame,
        format!(
            r#"["OK","{}",false,"invalid: event id does not match"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn event_signature_mismatch_is_rejected() {
    let server = start(Fixture::new(settings())).await;
    let mut event = signed_event(&CLIENT_SECRET, 1, vec![], "hello", NOW_SECS);
    // Tamper after signing, then recompute the id so it matches: the signature no longer
    // covers the id the relay checks.
    event.content = "tampered".to_owned();
    event.id = nostream_core::crypto::compute_event_id(&event).expect("id");

    let frame = send_event(&server, &event).await;

    assert_eq!(
        frame,
        format!(
            r#"["OK","{}",false,"invalid: event signature verification failed"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn inner_kinds_must_be_gift_wrapped() {
    let server = start(Fixture::new(settings())).await;

    for kind in [13u64, 14, 15, 444] {
        let event = signed_event(&CLIENT_SECRET, kind, vec![], "", NOW_SECS);
        let frame = send_event(&server, &event).await;

        assert_eq!(
            frame,
            format!(
                r#"["OK","{}",false,"blocked: kind {kind} events must not be published directly; wrap them in a kind 1059 gift wrap"]"#,
                event.id
            ),
            "kind {kind}"
        );
    }
}

#[tokio::test]
async fn auth_events_must_use_the_auth_message() {
    let server = start(Fixture::new(settings())).await;
    let event = signed_event(&CLIENT_SECRET, 22_242, vec![], "", NOW_SECS);

    let frame = send_event(&server, &event).await;

    assert_eq!(
        frame,
        format!(
            r#"["OK","{}",false,"invalid: auth events must be sent using the AUTH message type"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn request_to_vanish_relay_tag_is_checked() {
    let server = start(Fixture::new(settings())).await;
    let event = signed_event(
        &CLIENT_SECRET,
        62,
        vec![vec!["r", "wss://somewhere-else.example"]],
        "",
        NOW_SECS,
    );

    let frame = send_event(&server, &event).await;

    assert_eq!(
        frame,
        format!(
            r#"["OK","{}",false,"invalid: request to vanish relay tag invalid"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn an_expired_event_is_rejected() {
    let server = start(Fixture::new(settings())).await;
    let event = signed_event(
        &CLIENT_SECRET,
        1,
        vec![vec!["expiration", "100"]],
        "",
        NOW_SECS,
    );

    let frame = send_event(&server, &event).await;

    assert_eq!(
        frame,
        format!(r#"["OK","{}",false,"event is expired"]"#, event.id)
    );
}

#[tokio::test]
async fn the_event_rate_limit_answers_with_the_backoff() {
    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        rate_limits: Some(vec![EventRateLimit {
            description: None,
            kinds: None,
            period: 60_000,
            rate: 1,
        }]),
        ..Default::default()
    })));
    let server = start(fixture).await;

    let first = signed_event(&CLIENT_SECRET, 1, vec![], "one", NOW_SECS);
    let second = signed_event(&CLIENT_SECRET, 1, vec![], "two", NOW_SECS);

    assert_eq!(
        send_event(&server, &first).await,
        format!(r#"["OK","{}",true,""]"#, first.id)
    );
    assert_eq!(
        send_event(&server, &second).await,
        format!(
            r#"["OK","{}",false,"rate-limited: slow down","60000"]"#,
            second.id
        )
    );
}

#[tokio::test]
async fn the_event_rate_limit_skips_a_non_matching_kind_and_the_relay_pubkey() {
    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        rate_limits: Some(vec![EventRateLimit {
            description: None,
            kinds: Some(vec![nostream_core::KindSelector::Single(
                nostream_core::Kind(1),
            )]),
            period: 60_000,
            rate: 1,
        }]),
        ..Default::default()
    })));
    let server = start(fixture).await;

    let note = signed_event(&CLIENT_SECRET, 1, vec![], "one", NOW_SECS);
    let other = signed_event(&CLIENT_SECRET, 2, vec![], "relay", NOW_SECS);

    assert_eq!(
        send_event(&server, &note).await,
        format!(r#"["OK","{}",true,""]"#, note.id)
    );
    assert_eq!(
        send_event(&server, &other).await,
        format!(r#"["OK","{}",true,""]"#, other.id)
    );
    assert_eq!(
        send_event(&server, &note).await,
        format!(
            r#"["OK","{}",false,"rate-limited: slow down","60000"]"#,
            note.id
        )
    );
}

#[tokio::test]
async fn the_content_limit_is_bytes_of_utf16() {
    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        content: Some(nostream_config::settings::ContentLimitsOrVec::One(
            nostream_config::settings::ContentLimits {
                description: None,
                kinds: None,
                max_length: Some(5),
            },
        )),
        ..Default::default()
    })));
    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "sixsix", NOW_SECS);

    let frame = send_event(&server, &event).await;

    assert_eq!(
        frame,
        format!(
            r#"["OK","{}",false,"rejected: content is longer than 5 bytes"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn created_at_deltas_are_enforced_in_both_directions() {
    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        created_at: Some(CreatedAtLimits {
            max_negative_delta: Some(100),
            max_positive_delta: Some(100),
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;

    let future = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS + 101);
    let past = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS - 101);
    let inside = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS + 100);

    assert_eq!(
        send_event(&server, &future).await,
        format!(
            r#"["OK","{}",false,"rejected: created_at is more than 100 seconds in the future"]"#,
            future.id
        )
    );
    assert_eq!(
        send_event(&server, &past).await,
        format!(
            r#"["OK","{}",false,"rejected: created_at is more than 100 seconds in the past"]"#,
            past.id
        )
    );
    assert_eq!(
        send_event(&server, &inside).await,
        format!(r#"["OK","{}",true,""]"#, inside.id)
    );
}

#[tokio::test]
async fn the_static_proof_of_work_requirements_are_enforced() {
    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        event_id: Some(EventIdLimits {
            min_leading_zero_bits: Some(256),
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    let frame = send_event(&server, &event).await;

    let observed = nostream_core::pow::leading_zero_bits(event.id.as_bytes());
    assert!(
        frame.ends_with(&format!(r#"false,"pow: difficulty {observed}<256"]"#)),
        "{frame}"
    );

    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        pubkey: Some(PubkeyLimits {
            min_balance: 0,
            min_leading_zero_bits: 256,
            whitelist: None,
            blacklist: None,
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;
    let frame = send_event(&server, &event).await;

    let observed = nostream_core::pow::leading_zero_bits(event.pubkey.as_bytes());
    assert!(
        frame.ends_with(&format!(
            r#"false,"pow: pubkey difficulty {observed}<256"]"#
        )),
        "{frame}"
    );
}

#[tokio::test]
async fn pubkey_whitelist_and_blacklist_block() {
    use nostream_core::SettingsPubkey;

    let other = nostream_core::crypto::public_key(&CLIENT_SECRET)
        .expect("pubkey")
        .to_string();
    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        pubkey: Some(PubkeyLimits {
            min_balance: 0,
            min_leading_zero_bits: 0,
            whitelist: Some(vec![SettingsPubkey("00".repeat(32))]),
            blacklist: None,
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert!(
        send_event(&server, &event)
            .await
            .ends_with(r#"false,"blocked: pubkey not allowed"]"#)
    );

    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        pubkey: Some(PubkeyLimits {
            min_balance: 0,
            min_leading_zero_bits: 0,
            whitelist: None,
            blacklist: Some(vec![SettingsPubkey(other)]),
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;

    assert!(
        send_event(&server, &event)
            .await
            .ends_with(r#"false,"blocked: pubkey not allowed"]"#)
    );
}

#[tokio::test]
async fn kind_whitelist_and_blacklist_block() {
    use nostream_core::Kind;
    use nostream_core::KindSelector;

    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        kind: Some(KindLimits {
            whitelist: Some(vec![KindSelector::Single(Kind(0))]),
            blacklist: None,
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert!(
        send_event(&server, &event)
            .await
            .ends_with(r#"false,"blocked: event kind 1 not allowed"]"#)
    );

    let fixture = Fixture::new(settings_with(event_limits(EventLimits {
        kind: Some(KindLimits {
            whitelist: None,
            blacklist: Some(vec![KindSelector::Range([Kind(1), Kind(2)])]),
        }),
        ..Default::default()
    })));
    let server = start(fixture).await;

    assert!(
        send_event(&server, &event)
            .await
            .ends_with(r#"false,"blocked: event kind 1 not allowed"]"#)
    );
}

#[tokio::test]
async fn authentication_can_be_required_to_publish() {
    let mut settings = settings();
    let mut nip42 = nip42_settings();
    nip42.auth_required = Some(true);
    settings.nip42 = Some(nip42);

    let server = start(Fixture::new(settings)).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"auth-required: authentication is required to publish events"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn a_protected_event_needs_its_author() {
    let server = start(Fixture::new(settings())).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![vec!["-"]], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"auth-required: this event may only be published by its author"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn a_repost_may_not_embed_a_protected_event() {
    let server = start(Fixture::new(settings())).await;
    let inner = signed_event(&CLIENT_SECRET, 1, vec![vec!["-"]], "inner", NOW_SECS);
    let repost = signed_event(
        &CLIENT_SECRET,
        6,
        vec![],
        &serde_json::to_string(&inner).expect("inner json"),
        NOW_SECS,
    );

    assert_eq!(
        send_event(&server, &repost).await,
        format!(
            r#"["OK","{}",false,"blocked: reposts must not embed protected events"]"#,
            repost.id
        )
    );
}

#[tokio::test]
async fn a_vanished_pubkey_is_blocked() {
    let fixture = Fixture::new(settings());
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let now = chrono::Utc::now();
    fixture.users.insert(User {
        pubkey,
        is_admitted: true,
        is_vanished: true,
        balance: 0,
        created_at: now,
        updated_at: now,
    });

    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"blocked: request to vanish active for pubkey"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn nip43_admission_is_gated_and_has_its_own_reason() {
    let mut settings = settings();
    settings.nip43 = Some(nip43_settings());

    let server = start(Fixture::new(settings)).await;

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"restricted: pubkey not admitted; send a join request (kind 28934) with a valid invite code"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn an_admitted_pubkey_publishes_and_a_low_balance_blocks() {
    let mut settings = settings();
    settings.payments = Some(Payments {
        enabled: true,
        processor: nostream_config::settings::Processor::Lnurl,
        fee_schedules: nostream_config::settings::FeeSchedules {
            admission: vec![nostream_config::settings::FeeSchedule {
                enabled: true,
                description: None,
                amount: 1_000,
                whitelists: None,
            }],
            publication: None,
        },
        invoice_expiry_seconds: None,
    });
    settings.limits = Some(event_limits(EventLimits {
        pubkey: Some(PubkeyLimits {
            min_balance: 100,
            min_leading_zero_bits: 0,
            whitelist: None,
            blacklist: None,
        }),
        ..Default::default()
    }));

    let fixture = Fixture::new(settings);
    let server = start(fixture).await;
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"blocked: pubkey not admitted"]"#,
            event.id
        )
    );

    let now = chrono::Utc::now();
    server.fixture.users.insert(User {
        pubkey,
        is_admitted: true,
        is_vanished: false,
        balance: 0,
        created_at: now,
        updated_at: now,
    });

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"blocked: insufficient balance"]"#,
            event.id
        )
    );

    server.fixture.users.insert(User {
        pubkey,
        is_admitted: true,
        is_vanished: false,
        balance: 1_000,
        created_at: now,
        updated_at: now,
    });

    assert_eq!(
        send_event(&server, &event).await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
}

#[tokio::test]
async fn nip05_gates_publication() {
    let mut settings = settings();
    settings.nip05 = Some(Nip05Settings {
        mode: nostream_config::settings::Nip05Mode::Enabled,
        verify_expiration: None,
        verify_update_frequency: None,
        max_consecutive_failures: None,
        domain_whitelist: Some(vec!["allowed.example".to_owned()]),
        domain_blacklist: None,
    });

    let server = start(Fixture::new(settings)).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"blocked: NIP-05 verification required"]"#,
            event.id
        )
    );

    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let now = chrono::Utc::now();
    let verification = nostream_storage::repositories::Nip05Verification {
        pubkey,
        nip05: "someone@denied.example".to_owned(),
        domain: "denied.example".to_owned(),
        is_verified: true,
        last_verified_at: Some(now),
        last_checked_at: now,
        failure_count: 0,
        created_at: now,
        updated_at: now,
    };
    server.fixture.nip05.insert(verification.clone());

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"blocked: NIP-05 domain not allowed"]"#,
            event.id
        )
    );

    let allowed = nostream_storage::repositories::Nip05Verification {
        domain: "allowed.example".to_owned(),
        nip05: "someone@allowed.example".to_owned(),
        last_verified_at: Some(
            chrono::DateTime::from_timestamp(NOW_SECS - 604_801, 0).expect("instant"),
        ),
        ..verification
    };
    server.fixture.nip05.insert(allowed);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"blocked: NIP-05 verification expired"]"#,
            event.id
        )
    );

    let fresh = nostream_storage::repositories::Nip05Verification {
        last_verified_at: Some(chrono::DateTime::from_timestamp(NOW_SECS, 0).expect("instant")),
        ..nostream_storage::repositories::Nip05Verification {
            pubkey,
            nip05: "someone@allowed.example".to_owned(),
            domain: "allowed.example".to_owned(),
            is_verified: true,
            last_verified_at: None,
            last_checked_at: now,
            failure_count: 0,
            created_at: now,
            updated_at: now,
        }
    };
    server.fixture.nip05.insert(fresh);

    assert_eq!(
        send_event(&server, &event).await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
}

#[tokio::test]
async fn the_default_strategy_answers_ok_and_duplicate() {
    let server = start(Fixture::new(settings())).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "hello", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
    assert_eq!(
        send_event(&server, &event).await,
        format!(r#"["OK","{}",true,"duplicate:"]"#, event.id)
    );
    assert_eq!(server.fixture.events.events().len(), 1);
}

#[tokio::test]
async fn a_failed_insert_answers_with_the_generic_error() {
    // `default-event-strategy.ts`: a create that throws reaches the handler's catch, which is
    // the generic rejection rather than a stack trace.
    let fixture = Fixture::new(settings());
    fixture.events.fail_create(true);

    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "unlucky", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"error: unable to process event"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn a_store_error_is_reported_as_a_failure_and_not_as_a_refusal() {
    // The capture lets a store error escape `handleMessage` and the adapter sends no frame;
    // the port answers the generic failure. A gate that could not read its store must not
    // tell the publisher it was refused: the message would be false, and on a NIP-43 relay it
    // would send them down a join flow that cannot help.
    let mut nip43 = settings();
    nip43.nip43 = Some(nostream_relay::testing::nip43_settings());

    let fixture = Fixture::new(nip43);
    fixture.users.fail_reads();

    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "unreadable", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"error: unable to process event"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn a_nip05_store_error_is_reported_as_a_failure_and_not_as_a_refusal() {
    let mut enabled = settings();
    enabled.nip05 = Some(nostream_config::settings::Nip05Settings {
        mode: nostream_config::settings::Nip05Mode::Enabled,
        verify_expiration: None,
        verify_update_frequency: None,
        max_consecutive_failures: None,
        domain_whitelist: None,
        domain_blacklist: None,
    });

    let fixture = Fixture::new(enabled);
    fixture.nip05.fail_reads();

    let server = start(fixture).await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "unreadable", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"error: unable to process event"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn without_a_key_an_event_cannot_be_processed() {
    let server = Server::start_with(
        Fixture::new(settings()),
        RelayKeySource::from_values(None, None),
        common::fast_config(),
    )
    .await;
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(
            r#"["OK","{}",false,"error: unable to process event"]"#,
            event.id
        )
    );
}

#[tokio::test]
async fn the_relay_pubkey_bypasses_the_acceptance_gates() {
    let mut settings = settings();
    settings.limits = Some(event_limits(EventLimits {
        rate_limits: Some(vec![EventRateLimit {
            description: None,
            kinds: None,
            period: 60_000,
            rate: 1,
        }]),
        ..Default::default()
    }));

    let server = start(Fixture::new(settings)).await;
    let event = signed_event(&RELAY_SECRET, 1, vec![], "from the relay", NOW_SECS);

    assert_eq!(
        send_event(&server, &event).await,
        format!(r#"["OK","{}",true,""]"#, event.id)
    );
    assert_eq!(
        send_event(&server, &event).await,
        format!(r#"["OK","{}",true,"duplicate:"]"#, event.id)
    );

    // The relay's own key is the one `relay_keys` supplies.
    assert_eq!(
        relay_pubkey(),
        nostream_core::crypto::public_key(&RELAY_SECRET).expect("pubkey")
    );
}

// ---------------------------------------------------------------------------------------
// REQ (R10)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn req_streams_a_stored_event_then_eose() {
    let stored = signed_event(&CLIENT_SECRET, 1, vec![], "stored", NOW_SECS);
    let fixture = Fixture::new(settings());
    let server = start(fixture).await;

    let (mut client, _challenge) = server.connect().await;
    // Accept an event, then read it back.
    client.send(&event_frame(&stored)).await;
    assert!(client.expect_frame().await.ends_with(r#"true,""]"#));

    client.send(r#"["REQ","s2",{"kinds":[1]}]"#).await;
    let frames = client.read_until_eose().await;

    assert_eq!(
        frames,
        vec![
            format!(
                r#"["EVENT","s2",{}]"#,
                serde_json::to_string(&stored).expect("event json")
            ),
            r#"["EOSE","s2"]"#.to_owned(),
        ]
    );
}

#[tokio::test]
async fn a_duplicate_req_is_refused_with_the_capture_string() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;

    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","Subscription rejected: Duplicate subscription s1: Ignoring"]"#
    );
}

#[tokio::test]
async fn the_subscription_count_limit_is_the_capture_string() {
    let limits = Limits {
        client: Some(ClientLimits {
            subscription: Some(ClientSubscriptionLimits {
                max_subscriptions: Some(1),
                ..Default::default()
            }),
        }),
        ..Default::default()
    };
    let server = start(Fixture::new(settings_with(limits))).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);

    client.send(r#"["REQ","s2",{"kinds":[1]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","Subscription rejected: Too many subscriptions: Number of subscriptions must be less than or equal to 1"]"#
    );
}

#[tokio::test]
async fn the_filter_limits_carry_the_captures_strings_and_typos() {
    let limits = Limits {
        client: Some(ClientLimits {
            subscription: Some(ClientSubscriptionLimits {
                max_filters: Some(1),
                max_filter_values: Some(2),
                max_limit: Some(1),
                max_subscription_id_length: Some(5),
                ..Default::default()
            }),
        }),
        ..Default::default()
    };
    let server = start(Fixture::new(settings_with(limits))).await;
    let (mut client, _challenge) = server.connect().await;

    // The first REQ registers; the rest share its id so the count limit cannot pre-empt them.
    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);

    // Too many filters, with the capture's `susbscription` and `less then`.
    client
        .send(r#"["REQ","s1",{"kinds":[1]},{"kinds":[2]}]"#)
        .await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","Subscription rejected: Too many filters: Number of filters per susbscription must be less then or equal to 1"]"#
    );

    // Too many filter values.
    client.send(r#"["REQ","s1",{"kinds":[1,2,3]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","Subscription rejected: Too many filter values: Number of values per filter must be less than or equal to 2"]"#
    );

    // Limit too high.
    client.send(r#"["REQ","s1",{"kinds":[1],"limit":2}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","Subscription rejected: Limit too high: Filter limit must be less than or equal to 1"]"#
    );

    // Subscription id too long, with the capture's `less or equal`.
    client.send(r#"["REQ","abcdef",{"kinds":[1]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","Subscription rejected: Subscription ID too long: Subscription ID must be less or equal to 5"]"#
    );
}

#[tokio::test]
async fn a_restricted_only_req_from_an_unauthenticated_client_is_closed() {
    let mut settings = settings();
    settings.nip42 = Some(nip42_settings());
    let server = start(Fixture::new(settings)).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[4,1059]}]"#).await;

    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","s1","auth-required: authentication is required to request these event kinds"]"#
    );
}

#[tokio::test]
async fn a_restricted_read_delivers_only_to_the_author_or_a_p_tagged_reader() {
    let mut settings = settings();
    settings.nip42 = Some(nip42_settings());
    let server = start(Fixture::new(settings)).await;

    let author = signed_event(&CLIENT_SECRET, 4, vec![], "ciphertext", NOW_SECS);
    let (mut writer, _challenge) = server.connect().await;
    writer.send(&event_frame(&author)).await;
    assert!(writer.expect_frame().await.ends_with(r#"true,""]"#));

    // A restricted-only REQ from an unauthenticated client is closed, not served empty.
    let (mut stranger, _challenge) = server.connect().await;
    stranger.send(r#"["REQ","s1",{"kinds":[4]}]"#).await;
    assert_eq!(
        stranger.expect_frame().await,
        r#"["CLOSED","s1","auth-required: authentication is required to request these event kinds"]"#
    );

    // The author authenticates and reads their own event.
    let (mut owner, challenge) = server.connect().await;
    let auth = auth_event(&challenge, NOW_SECS);
    owner
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&auth).expect("auth json")
        ))
        .await;
    assert!(owner.expect_frame().await.ends_with(r#"true,""]"#));

    owner.send(r#"["REQ","mine",{"kinds":[4]}]"#).await;
    let frames = owner.read_until_eose().await;

    assert_eq!(frames.len(), 2, "{frames:?}");
    assert!(frames[0].starts_with(r#"["EVENT","mine","#));
    assert_eq!(frames[1], r#"["EOSE","mine"]"#);
}

#[tokio::test]
async fn a_close_aborts_an_in_flight_read_without_a_frame() {
    let stored = signed_event(&CLIENT_SECRET, 1, vec![], "stored", NOW_SECS);
    let fixture = Fixture::new(settings());
    let gate = fixture.events.gate_reads();
    fixture.seed_event(stored).await;

    let server = start(fixture).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    client.send(r#"["CLOSE","s1"]"#).await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Nothing was emitted for the aborted read: no EVENT and no EOSE.
    assert!(client.next_message().await.is_none());

    // The subscription is gone, so a fresh REQ under the same id is not a duplicate.
    gate.add_permits(4);
    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    let frames = client.read_until_eose().await;

    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(frames[1], r#"["EOSE","s1"]"#);
}

/// A `CLOSE` must not be handled ahead of the `REQ` it closes.
///
/// The `REQ` and the `CLOSE` leave in one flush, followed by a frame that cannot be decoded:
/// its `NOTICE` is written by the connection loop itself, so receiving it proves the loop has
/// read the two frames ahead of it. No wall-clock wait stands in for an observation — the
/// barrier orders the live event after both frames, and the live event's own `OK` (on the
/// client's deadline) is the only other anchor. The stored read stays parked at its gate until
/// the test releases it, which is what keeps the assertion about ordering: without the gate
/// the in-memory read finishes in one poll and its frames arrive even when the ordering is
/// right. `multi_thread, worker_threads = 1` is the flavour the defect was measured on (30/30);
/// on `current_thread` a spawned handler cannot be polled before the spawning task yields, so
/// the test would pass on a wrong tree.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn a_close_that_overtakes_its_req_streams_nothing() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let fixture = Fixture::new(settings());
    let gate = fixture.events.gate_reads();
    fixture
        .seed_event(signed_event(&CLIENT_SECRET, 1, vec![], "stored", NOW_SECS))
        .await;

    let server = start(fixture).await;
    let (mut client, _challenge) = server.connect().await;
    let live = signed_event(&CLIENT_SECRET, 1, vec![], "live", NOW_SECS);
    let accepted = format!(r#"["OK","{}",true,""]"#, live.id);

    // One flush, so the loop reads the three frames in the order they are written here.
    let stream = client.stream();
    stream
        .feed(Message::Text(
            r#"["REQ","s1",{"kinds":[1]}]"#.to_owned().into(),
        ))
        .await
        .expect("feed the REQ");
    stream
        .feed(Message::Text(r#"["CLOSE","s1"]"#.to_owned().into()))
        .await
        .expect("feed the CLOSE");
    stream
        .feed(Message::Text(r#"{"kind":"#.to_owned().into()))
        .await
        .expect("feed the undecodable frame");
    stream.flush().await.expect("flush the three frames");

    // The loop's own answer to the third frame: the `REQ` and the `CLOSE` have been read.
    let barrier = client.expect_frame().await;
    assert!(barrier.starts_with(r#"["NOTICE","invalid: "#), "{barrier}");

    // The live event's `OK` is the second anchor: nothing for `s1` may reach the client on
    // the way to it, and the client's own deadline bounds the wait.
    client.send(&event_frame(&live)).await;

    loop {
        let Some(message) = client.next_message().await else {
            panic!("the live event's OK never arrived");
        };
        let Message::Text(frame) = message else {
            continue;
        };

        assert!(
            !names_s1(frame.as_str()),
            "a closed subscription streamed: {frame}"
        );

        if frame.as_str() == accepted {
            break;
        }
    }

    // Releasing the read decides nothing new: the read either never opened or was aborted.
    gate.add_permits(4);

    let frames = frames_within(&mut client, Duration::from_millis(300)).await;

    assert!(
        frames.iter().all(|frame| !names_s1(frame)),
        "a closed subscription streamed: {frames:?}"
    );
}

#[tokio::test]
async fn a_new_filter_set_replaces_the_subscription() {
    let fixture = Fixture::new(settings());
    let note = signed_event(&CLIENT_SECRET, 1, vec![], "note", NOW_SECS);
    let metadata = signed_event(&CLIENT_SECRET, 0, vec![], "{}", NOW_SECS);
    fixture.seed_event(note).await;
    fixture.seed_event(metadata.clone()).await;

    let server = start(fixture).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(client.read_until_eose().await.len(), 2);

    // Different filters under the same id: accepted, and the new set decides the stream.
    client.send(r#"["REQ","s1",{"kinds":[0]}]"#).await;
    let frames = client.read_until_eose().await;

    assert_eq!(frames.len(), 2, "{frames:?}");
    assert!(frames[0].contains(&metadata.id.to_string()));
}

#[tokio::test]
async fn an_invite_request_mints_one_kind_28935_event_before_eose() {
    let mut settings = settings();
    settings.nip43 = Some(nip43_settings());
    let server = start(Fixture::new(settings)).await;
    let (mut client, challenge) = server.connect().await;

    let auth = auth_event(&challenge, NOW_SECS);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&auth).expect("auth json")
        ))
        .await;
    assert!(client.expect_frame().await.ends_with(r#"true,""]"#));

    client.send(r#"["REQ","invite",{"kinds":[28935]}]"#).await;
    let frames = client.read_until_eose().await;

    assert_eq!(frames.len(), 2, "{frames:?}");

    let event: serde_json::Value = serde_json::from_str(
        frames[0]
            .strip_prefix(r#"["EVENT","invite","#)
            .and_then(|rest| rest.strip_suffix(']'))
            .expect("an EVENT frame"),
    )
    .expect("event json");

    assert_eq!(event["kind"], 28_935);
    let tags = event["tags"].as_array().expect("tags");
    assert!(tags.iter().any(|tag| tag[0] == "claim"));
    assert!(tags.iter().any(|tag| tag[0] == "-"));
    assert!(tags.iter().any(|tag| tag[0] == "expiration"));
    assert_eq!(
        event["created_at"].as_i64(),
        Some(NOW_SECS),
        "created_at is the frozen clock"
    );
    assert_eq!(server.fixture.invites.minted().len(), 1);
    assert_eq!(frames[1], r#"["EOSE","invite"]"#);
}

#[tokio::test]
async fn a_close_during_the_invite_mint_leaves_the_event_but_not_the_read() {
    // The `CLOSE` is a direct handler call: `unsubscribe::handle` is synchronous, so in this
    // task the abort is a program-order predecessor of the gate release. A `CLOSE` over a
    // socket is covered by `a_close_aborts_an_in_flight_read_without_a_frame`.
    let mut settings = settings();
    settings.nip43 = Some(nip43_settings());

    let fixture = Fixture::new(settings);
    let gate = fixture.invites.gate_creates();
    fixture
        .seed_event(signed_event(&CLIENT_SECRET, 1, vec![], "stored", NOW_SECS))
        .await;

    let (sink, mut frames) = FrameSink::channel(1024 * 1024, None);
    let connection = Arc::new(Connection::new(
        "127.0.0.1".to_owned(),
        nostream_core::nip42::Nip42Session::with_challenge("challenge", 0),
    ));
    assert!(connection.authenticate(
        nostream_core::crypto::public_key(&CLIENT_SECRET).expect("client public key"),
        nostream_core::EventId::from_byte_array([3; 32]),
        NOW_SECS,
    ));
    let context = Arc::new(fixture.context(
        Arc::new(TestClock::new(NOW_MS)),
        relay_keys(),
        Arc::clone(&connection),
        sink,
    ));

    // The seam runs the handler's prefix on this task, so the subscription and its read are
    // registered by the time `begin` returns; only the mint and the read are spawned.
    let reading = tokio::spawn(
        nostream_relay::handlers::subscribe::begin(
            SubscribeMessage {
                subscription_id: "invite".to_owned(),
                filters: vec![Filter {
                    kinds: Some(vec![nostream_core::Kind(28_935), nostream_core::Kind(1)]),
                    ..Default::default()
                }],
            },
            &context,
        )
        .expect("the subscription is accepted"),
    );

    assert!(
        connection.read_in_flight("invite"),
        "the read is registered before the mint starts"
    );

    // The mint's one `await` is held, which is the window a `CLOSE` lands in.
    for _ in 0..100 {
        if fixture.invites.creates_started() == 1 {
            break;
        }

        tokio::task::yield_now().await;
    }

    assert_eq!(
        fixture.invites.creates_started(),
        1,
        "the invite mint is in flight"
    );

    nostream_relay::handlers::unsubscribe::handle(
        UnsubscribeMessage {
            subscription_id: "invite".to_owned(),
        },
        &context,
    );

    // Nothing between the abort above and the release below suspends, so a read still
    // registered here means the `unsubscribe::handle` call was dropped or moved behind this
    // assertion; whether the cancellation reaches the read is what the frames below decide.
    assert!(
        !connection.read_in_flight("invite"),
        "the abort precedes the release of the mint"
    );

    gate.add_permits(1);
    reading
        .await
        .expect("the handler finishes once the mint is released");

    // The capture emits the invite event for a subscription the client has closed
    // (`subscribe-message-handler.ts:111`), and that stays.
    let first = frames.try_recv().expect("the invite event frame");
    assert!(first.starts_with(r#"["EVENT","invite","#), "{first}");

    let event: serde_json::Value = serde_json::from_str(
        first
            .strip_prefix(r#"["EVENT","invite","#)
            .and_then(|rest| rest.strip_suffix(']'))
            .expect("an EVENT frame"),
    )
    .expect("event json");
    assert_eq!(event["kind"], 28_935);

    // Nothing else: the stored read was cancelled with the subscription, so no stored
    // event and no `EOSE`.
    assert!(
        frames.try_recv().is_err(),
        "a closed subscription streams nothing"
    );
    assert_eq!(fixture.invites.minted().len(), 1);
}

#[tokio::test]
async fn an_unauthenticated_invite_request_gets_eose_only() {
    let mut settings = settings();
    settings.nip43 = Some(nip43_settings());
    let server = start(Fixture::new(settings)).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","invite",{"kinds":[28935]}]"#).await;

    assert_eq!(
        client.read_until_eose().await,
        vec!["[\"EOSE\",\"invite\"]".to_owned()]
    );
    assert!(server.fixture.invites.minted().is_empty());
}

// ---------------------------------------------------------------------------------------
// COUNT (R12)
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn count_answers_with_the_count_object() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["COUNT","c1",{"kinds":[1]}]"#).await;

    assert_eq!(client.expect_frame().await, r#"["COUNT","c1",{"count":0}]"#);
}

#[tokio::test]
async fn count_can_be_disabled_by_configuration() {
    let mut settings = settings();
    settings.nip45 = Some(nip45_settings());
    settings.nip45 = Some(nostream_config::settings::Nip45Settings {
        enabled: Some(false),
    });
    let server = start(Fixture::new(settings)).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["COUNT","c1",{"kinds":[1]}]"#).await;

    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","c1","COUNT is disabled by relay configuration"]"#
    );
}

#[tokio::test]
async fn count_limits_are_the_capture_strings() {
    let limits = Limits {
        client: Some(ClientLimits {
            subscription: Some(ClientSubscriptionLimits {
                max_subscriptions: None,
                max_filters: Some(1),
                max_filter_values: Some(2),
                max_limit: None,
                min_prefix_length: None,
                max_subscription_id_length: Some(3),
            }),
        }),
        ..Default::default()
    };
    let server = start(Fixture::new(settings_with(limits))).await;
    let (mut client, _challenge) = server.connect().await;

    client
        .send(r#"["COUNT","c1",{"kinds":[1]},{"kinds":[0]}]"#)
        .await;
    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","c1","Too many filters: Number of filters per count query must be less than or equal to 1"]"#
    );

    client.send(r#"["COUNT","c1",{"kinds":[1,2,3]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","c1","Too many filter values: Number of values per filter must be less than or equal to 2"]"#
    );

    client.send(r#"["COUNT","four",{"kinds":[1]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","four","Query ID too long: Query ID must be less than or equal to 3"]"#
    );
}

#[tokio::test]
async fn a_count_repository_failure_is_generic() {
    let fixture = Fixture::new(settings());
    fixture.events.fail_count();
    let server = start(fixture).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["COUNT","c1",{"kinds":[1]}]"#).await;

    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","c1","error: unable to count events"]"#
    );
}

#[tokio::test]
async fn a_restricted_count_needs_a_scoped_authors_filter() {
    let mut settings = settings();
    settings.nip42 = Some(nip42_settings());
    let server = start(Fixture::new(settings)).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["COUNT","c1",{"kinds":[4]}]"#).await;

    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","c1","auth-required: authentication is required to count these event kinds"]"#
    );
}

// ---------------------------------------------------------------------------------------
// AUTH (R13)
// ---------------------------------------------------------------------------------------

/// A kind-22242 event answering `challenge` for the relay URL.
fn auth_event(challenge: &str, created_at: i64) -> Event {
    signed_event(
        &CLIENT_SECRET,
        22_242,
        vec![
            vec!["relay", "wss://relay.example.com"],
            vec!["challenge", challenge],
        ],
        "",
        created_at,
    )
}

#[tokio::test]
async fn auth_outcomes_are_the_captures_seven() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, challenge) = server.connect().await;

    // 1. wrong kind
    let wrong_kind = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&wrong_kind).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: auth event must be kind 22242"]"#,
            wrong_kind.id
        )
    );

    // 2. id does not match
    let mut bad_id = auth_event(&challenge, NOW_SECS);
    bad_id.content = "tampered".to_owned();
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&bad_id).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: event id does not match"]"#,
            bad_id.id
        )
    );

    // 3. signature does not verify
    let mut bad_sig = auth_event(&challenge, NOW_SECS);
    bad_sig.content = "tampered".to_owned();
    bad_sig.id = nostream_core::crypto::compute_event_id(&bad_sig).expect("id");
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&bad_sig).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: event signature verification failed"]"#,
            bad_sig.id
        )
    );

    // 4. created_at too far from the clock
    let stale = auth_event(&challenge, NOW_SECS - 601);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&stale).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: created_at is too far from the current time"]"#,
            stale.id
        )
    );

    // 5. challenge does not match
    let wrong_challenge = auth_event("not-the-challenge", NOW_SECS);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&wrong_challenge).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: challenge does not match"]"#,
            wrong_challenge.id
        )
    );

    // 6. relay url does not match
    let wrong_relay = signed_event(
        &CLIENT_SECRET,
        22_242,
        vec![
            vec!["relay", "wss://elsewhere.example"],
            vec!["challenge", &challenge],
        ],
        "",
        NOW_SECS,
    );
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&wrong_relay).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: relay url does not match"]"#,
            wrong_relay.id
        )
    );

    // 7. accepted, then replayed
    let good = auth_event(&challenge, NOW_SECS);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&good).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(r#"["OK","{}",true,""]"#, good.id)
    );

    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&good).expect("json")
        ))
        .await;
    assert_eq!(
        client.expect_frame().await,
        format!(
            r#"["OK","{}",false,"invalid: auth event already used"]"#,
            good.id
        )
    );
}

#[tokio::test]
async fn the_challenge_is_never_rotated_by_auth() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, challenge) = server.connect().await;

    let auth = auth_event(&challenge, NOW_SECS);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&auth).expect("json")
        ))
        .await;
    assert!(client.expect_frame().await.ends_with(r#"true,""]"#));

    // A second AUTH for another pubkey still uses the first challenge.
    let second = auth_event(&challenge, NOW_SECS);
    client
        .send(&format!(
            r#"["AUTH",{}]"#,
            serde_json::to_string(&second).expect("json")
        ))
        .await;

    assert!(
        client
            .expect_frame()
            .await
            .contains("auth event already used")
    );
}

#[tokio::test]
async fn nip42_sessions_expire_at_the_ttl_boundary() {
    use nostream_core::nip42::Nip42Session;

    let mut session = Nip42Session::with_challenge("challenge", 60);
    let pubkey = nostream_core::crypto::public_key(&CLIENT_SECRET).expect("pubkey");
    let event_id = nostream_core::EventId::from_byte_array([3; 32]);

    assert!(session.authenticate(pubkey, event_id, 1_000));
    assert!(
        !session.authenticate(pubkey, event_id, 1_000),
        "replay is refused"
    );

    assert!(session.is_authenticated(&pubkey, 1_059));
    assert!(
        !session.is_authenticated(&pubkey, 1_060),
        "expiry is inclusive"
    );

    let mut forever = Nip42Session::with_challenge("challenge", 0);
    assert!(forever.authenticate(pubkey, event_id, 0));
    assert!(forever.is_authenticated(&pubkey, i64::MAX));
}

/// An `AUTH` must be handled before the restricted `REQ` that follows it in the stream.
///
/// The existing NIP-42 tests read the `OK` before sending their `REQ`, which serialises the
/// pair; pipelined in one flush they exercise the loop's ordering. Two workers, the flavour
/// this symptom was measured on (10/10 refused before the ordering fix).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pipelined_auth_before_a_restricted_req_is_ordered() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;

    let mut settings = settings();
    settings.nip42 = Some(nip42_settings());
    let server = start(Fixture::new(settings)).await;
    let (mut client, challenge) = server.connect().await;
    let auth = auth_event(&challenge, NOW_SECS);

    // One flush, so both frames are buffered before the loop reads either of them.
    let stream = client.stream();
    stream
        .feed(Message::Text(
            format!(
                r#"["AUTH",{}]"#,
                serde_json::to_string(&auth).expect("auth json")
            )
            .into(),
        ))
        .await
        .expect("feed the AUTH");
    stream
        .feed(Message::Text(
            r#"["REQ","s1",{"kinds":[4]}]"#.to_owned().into(),
        ))
        .await
        .expect("feed the REQ");
    stream.flush().await.expect("flush both frames");

    let first = client.expect_frame().await;
    let second = client.expect_frame().await;

    assert_eq!(first, format!(r#"["OK","{}",true,""]"#, auth.id));
    assert_eq!(second, r#"["EOSE","s1"]"#);
    assert!(
        !first.starts_with(r#"["CLOSED","s1""#) && !second.starts_with(r#"["CLOSED","s1""#),
        "the REQ was refused: {first} {second}"
    );
}

// ---------------------------------------------------------------------------------------
// Dispatch and the message limiter (R14)
// ---------------------------------------------------------------------------------------

/// The settings that trip every message on its first hit.
fn tripping_message_limits() -> Limits {
    Limits {
        message: Some(MessageLimits {
            rate_limits: Some(vec![MessageRateLimit {
                description: None,
                message_type: None,
                period: 60_000,
                rate: 0,
            }]),
            ip_whitelist: None,
        }),
        ..Default::default()
    }
}

#[tokio::test]
async fn the_message_limiter_closes_reads_and_notices_everything_else() {
    let server = start(Fixture::new(settings_with(tripping_message_limits()))).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","s1","rate-limited: slow down","60000"]"#
    );

    client.send(r#"["COUNT","c1",{"kinds":[1]}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["CLOSED","c1","rate-limited: slow down","60000"]"#
    );

    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);
    client.send(&event_frame(&event)).await;
    assert_eq!(client.expect_frame().await, r#"["NOTICE","rate limited"]"#);

    client.send("not json").await;
    assert_eq!(client.expect_frame().await, r#"["NOTICE","rate limited"]"#);
}

#[tokio::test]
async fn a_whitelisted_ip_bypasses_the_message_limiter() {
    let mut limits = tripping_message_limits();

    if let Some(message) = limits.message.as_mut() {
        message.ip_whitelist = Some(vec!["127.0.0.1".to_owned()]);
    }

    let server = start(Fixture::new(settings_with(limits))).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["REQ","s1",{"kinds":[1]}]"#).await;

    assert_eq!(client.expect_frame().await, r#"["EOSE","s1"]"#);
}

#[tokio::test]
async fn the_connection_limiter_terminates_the_upgrade() {
    let limits = Limits {
        connection: Some(ConnectionLimits {
            rate_limits: vec![RateLimit {
                description: None,
                period: 60_000,
                rate: 0,
            }],
            ip_whitelist: None,
            ip_blacklist: None,
            max_connections_per_ip: None,
        }),
        ..Default::default()
    };
    let server = start(Fixture::new(settings_with(limits))).await;

    let mut client = common::Client::connect(server.address).await;

    // The connection is terminated rather than admitted: nothing is served on it.
    assert!(client.next_message_lossy().await.is_none());
}

#[tokio::test]
async fn an_invalid_frame_gets_the_capture_notice() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["NEG-OPEN","s1",{}]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","invalid: Invalid input"]"#
    );

    client.send(r#"["REQ","s1"]"#).await;
    assert_eq!(
        client.expect_frame().await,
        r#"["NOTICE","invalid: REQ message must contain at least one filter"]"#
    );

    client.send("{\"kind\":").await;
    let notice = client.expect_frame().await;
    assert!(notice.starts_with(r#"["NOTICE","invalid: "#), "{notice}");
}

#[tokio::test]
async fn a_close_emits_nothing_for_an_unknown_subscription() {
    let server = start(Fixture::new(settings())).await;
    let (mut client, _challenge) = server.connect().await;

    client.send(r#"["CLOSE","nothing"]"#).await;

    let frame = client.next_message().await;
    assert!(frame.is_none(), "{frame:?}");
}
