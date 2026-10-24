//! The NIP-56 live-hiding mirror. Carries `test/unit/utils/hidden-content-cache.spec.ts`
//! (12 cases).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

mod common;

use std::time::Duration;

use common::{CLIENT_SECRET, NOW_MS, NOW_SECS, signed_event};
use nostream_config::settings::{Nip56Settings, Settings};
use nostream_core::clock::TestClock;
use nostream_relay::hidden_content::HiddenContentCache;
use nostream_relay::testing::{Fixture, nip56_settings, settings, settings_with_ewma};
use nostream_storage::repositories::ActionableTarget;

fn target_for_event(event: &nostream_core::Event) -> ActionableTarget {
    ActionableTarget {
        reported_pubkey: None,
        reported_event_id: Some(event.id),
    }
}

fn target_for_pubkey(pubkey: nostream_core::Pubkey) -> ActionableTarget {
    ActionableTarget {
        reported_pubkey: Some(pubkey),
        reported_event_id: None,
    }
}

fn hiding_on() -> Settings {
    let mut settings = settings();
    settings.nip56 = Some(Nip56Settings {
        enabled: true,
        hide_actionable_reports: true,
        ..nip56_settings()
    });

    settings
}

#[test]
fn an_empty_mirror_hides_nothing() {
    let cache = HiddenContentCache::new();
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    assert!(!cache.is_hidden(&event));
    assert!(cache.snapshot().event_ids.is_empty());
    assert!(cache.snapshot().pubkeys.is_empty());
}

#[test]
fn a_mark_hides_the_target_immediately() {
    let cache = HiddenContentCache::new();
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    cache.mark_actionable_target(&target_for_event(&event));

    assert!(cache.is_hidden(&event));
}

#[test]
fn a_mark_on_an_author_hides_every_event_of_that_author() {
    let cache = HiddenContentCache::new();
    let first = signed_event(&CLIENT_SECRET, 1, vec![], "one", NOW_SECS);
    let second = signed_event(&CLIENT_SECRET, 1, vec![], "two", NOW_SECS);

    cache.mark_actionable_target(&target_for_pubkey(first.pubkey));

    assert!(cache.is_hidden(&first));
    assert!(cache.is_hidden(&second));
}

#[test]
fn a_snapshot_replaces_the_mirror_wholesale() {
    let cache = HiddenContentCache::new();
    let hidden = signed_event(&CLIENT_SECRET, 1, vec![], "hidden", NOW_SECS);
    let other = signed_event(&CLIENT_SECRET, 1, vec![], "other", NOW_SECS);

    cache.mark_actionable_target(&target_for_event(&hidden));
    assert!(cache.is_hidden(&hidden));

    // A snapshot that names no target unhides everything the mark added.
    cache.replace(&[]);
    assert!(!cache.is_hidden(&hidden));

    cache.replace(&[target_for_event(&other)]);
    assert!(!cache.is_hidden(&hidden));
    assert!(cache.is_hidden(&other));

    // One target may name both sides at once.
    cache.replace(&[ActionableTarget {
        reported_pubkey: Some(other.pubkey),
        reported_event_id: Some(other.id),
    }]);
    assert!(cache.is_hidden(&other));

    // A target that names neither hides nothing.
    cache.replace(&[ActionableTarget {
        reported_pubkey: None,
        reported_event_id: None,
    }]);
    assert!(!cache.is_hidden(&other));
}

#[tokio::test]
async fn a_tick_with_hiding_enabled_queries_the_repository_and_counts() {
    let fixture = Fixture::new(hiding_on());
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    fixture.reports.set_targets(vec![target_for_event(&event)]);

    let cache = HiddenContentCache::new();

    assert_eq!(fixture.reports.queries(), 0);

    cache
        .refresh(fixture.reports.as_ref(), &fixture.settings)
        .await
        .expect("a snapshot");

    assert_eq!(fixture.reports.queries(), 1);
    assert_eq!(cache.refreshes(), 1);
    assert!(cache.is_hidden(&event));
}

#[tokio::test]
async fn a_tick_with_hiding_disabled_queries_nothing() {
    for nip56 in [
        None,
        Some(Nip56Settings {
            enabled: false,
            hide_actionable_reports: true,
            ..nip56_settings()
        }),
        Some(Nip56Settings {
            enabled: true,
            hide_actionable_reports: false,
            ..nip56_settings()
        }),
    ] {
        let mut settings = settings_with_ewma();
        settings.nip56.clone_from(&nip56);

        let fixture = Fixture::new(settings);
        let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

        fixture.reports.set_targets(vec![target_for_event(&event)]);

        let cache = HiddenContentCache::new();

        cache
            .refresh(fixture.reports.as_ref(), &fixture.settings)
            .await
            .expect("a skipped tick");

        assert_eq!(fixture.reports.queries(), 0, "no query: {nip56:?}");
        assert_eq!(cache.refreshes(), 0, "no refresh counted: {nip56:?}");
        assert!(!cache.is_hidden(&event));
    }
}

#[tokio::test]
async fn a_failing_repository_leaves_the_mirror_as_it_was() {
    let fixture = Fixture::new(hiding_on());
    let hidden = signed_event(&CLIENT_SECRET, 1, vec![], "kept", NOW_SECS);

    fixture.reports.fail_queries();
    fixture.reports.set_targets(Vec::new());

    let cache = HiddenContentCache::new();
    cache.mark_actionable_target(&target_for_event(&hidden));

    assert!(
        cache
            .refresh(fixture.reports.as_ref(), &fixture.settings)
            .await
            .is_err()
    );
    assert!(cache.is_hidden(&hidden), "a failed tick changes nothing");
    assert_eq!(cache.refreshes(), 0);
}

#[tokio::test]
async fn start_seeds_the_mirror_and_keeps_refreshing_until_dropped() {
    let fixture = Fixture::new(hiding_on());
    let event = signed_event(&CLIENT_SECRET, 1, vec![], "", NOW_SECS);

    fixture.reports.set_targets(vec![target_for_event(&event)]);

    let cache = HiddenContentCache::new();
    let task = cache.start(
        fixture.reports.clone(),
        std::sync::Arc::clone(&fixture.settings),
        Duration::from_millis(10),
        std::sync::Arc::new(TestClock::new(NOW_MS)),
    );

    let mut seen = false;

    for _ in 0..200 {
        if cache.is_hidden(&event) {
            seen = true;
            break;
        }

        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    task.abort();

    assert!(seen, "the first tick seeds the mirror");
    assert!(cache.refreshes() >= 1);
}
