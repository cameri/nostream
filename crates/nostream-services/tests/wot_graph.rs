//! The web-of-trust graph: its gates, the breadth-first rebuild and the follow-list cache.
//!
//! Mirrors `test/unit/services/wot-graph-service.spec.ts`. The Redis set the capture keeps
//! per pubkey is the service's in-process map (ADR 0010), so a "cached" set here is one
//! `update_follow_list` wrote.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::sync::Arc;

use nostream_config::settings::{Settings, WotSettings};
use nostream_core::{Event, Kind, Pubkey, SettingsPubkey};
use nostream_relay::wot::WotGraph;
use nostream_services::services::wot_graph_service::WotGraphService;
use nostream_services::testing::{self, InMemoryEventRepository};
use nostream_storage::repositories::EventRepository;
use std::time::{Duration, Instant};

/// The trait-object view `WotGraphService::new` takes.
fn events(repository: &Arc<InMemoryEventRepository>) -> Arc<dyn EventRepository> {
    Arc::clone(repository) as _
}

/// Settings with the graph in the state a case needs.
fn wot_settings(enabled: bool, seed: &str, max_depth: u32, minimum_followers: u32) -> Settings {
    let mut settings = testing::settings();
    settings.wot = Some(WotSettings {
        enabled,
        seed_pubkey: SettingsPubkey(seed.to_owned()),
        minimum_followers,
        max_depth,
        refresh_interval_hours: 24,
    });

    settings
}

/// A kind-3 event by `secret`'s key, following the given pubkeys.
fn contact_list(secret: &[u8; 32], follows: &[&Pubkey]) -> Event {
    let tags = follows
        .iter()
        .map(|pubkey| vec!["p".to_owned(), pubkey.to_string()])
        .collect();

    testing::signed_event(secret, Kind::CONTACT_LIST, tags, "")
}

/// The `&[String]` shape `update_follow_list` takes.
fn follows(pubkeys: &[&Pubkey]) -> Vec<String> {
    pubkeys.iter().map(|pubkey| pubkey.to_string()).collect()
}

#[derive(Clone, Default)]
struct Buffer(Arc<std::sync::Mutex<Vec<u8>>>);

impl Write for Buffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .extend_from_slice(bytes);

        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buffer {
    type Writer = Buffer;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn captured(buffer: &Buffer) -> String {
    String::from_utf8(
        buffer
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    )
    .unwrap_or_default()
}

async fn wait_for_rebuilds(service: &WotGraphService, count: u64) {
    let deadline = Instant::now() + Duration::from_secs(2);

    while service.rebuilds() < count {
        assert!(
            Instant::now() < deadline,
            "the graph did not reach {count} rebuilds; it has {}",
            service.rebuilds()
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn the_gates_answer_without_a_repository_read() {
    let other = testing::pubkey(9);

    // Absent `wot`.
    let repository = InMemoryEventRepository::new();
    let service = WotGraphService::new(Arc::new(testing::settings()), events(&repository));
    assert_eq!(service.get_distance(&other).await.unwrap(), None);
    assert_eq!(repository.reads(), 0);

    // Disabled.
    let repository = InMemoryEventRepository::new();
    let settings = wot_settings(false, &testing::pubkey(1).to_string(), 2, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));
    assert_eq!(service.get_distance(&other).await.unwrap(), None);
    assert_eq!(repository.reads(), 0);

    // The seed is its own distance zero, and no build is needed to know it.
    let repository = InMemoryEventRepository::new();
    let seed = testing::pubkey(1);
    let settings = wot_settings(true, &seed.to_string(), 2, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));
    assert_eq!(service.get_distance(&seed).await.unwrap(), Some(0));
    assert_eq!(repository.reads(), 0);
}

#[tokio::test]
async fn a_malformed_seed_leaves_the_graph_empty_and_ready() {
    let buffer = Buffer::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_max_level(tracing::Level::ERROR)
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let other = testing::pubkey(9);

    for seed in ["ab".repeat(31) + "a", "z".repeat(64)] {
        let repository = InMemoryEventRepository::new();
        let settings = wot_settings(true, &seed, 2, 1);
        let service = WotGraphService::new(Arc::new(settings), events(&repository));

        assert_eq!(service.get_distance(&other).await.unwrap(), None);
        assert!(service.is_ready(), "an invalid seed is permanently ready");
        assert_eq!(repository.reads(), 0);
    }

    let logs = captured(&buffer);
    assert_eq!(
        logs.matches("is not a 64-character hex pubkey").count(),
        2,
        "each invalid seed is logged once: {logs}"
    );
}

#[tokio::test]
async fn the_rebuild_is_breadth_first_and_thresholded() {
    // A follows C; B follows C and D; the seed follows A and B.
    let a_probe = contact_list(&[2; 32], &[]);
    let b_probe = contact_list(&[3; 32], &[]);
    let c_probe = contact_list(&[4; 32], &[]);
    let d_probe = contact_list(&[5; 32], &[]);
    let (a, b) = (a_probe.pubkey, b_probe.pubkey);
    let (c, d) = (c_probe.pubkey, d_probe.pubkey);

    let seed_event = contact_list(&[1; 32], &[&a, &b]);
    let seed = seed_event.pubkey;
    let a_event = contact_list(&[2; 32], &[&c]);
    let b_event = contact_list(&[3; 32], &[&c, &d]);

    let repository = InMemoryEventRepository::with_events([
        seed_event.clone(),
        a_event.clone(),
        b_event.clone(),
    ]);

    // Two followers are required at depth 2: only C is followed by both A and B.
    let settings = wot_settings(true, &seed.to_string(), 2, 2);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    assert_eq!(service.get_distance(&a).await.unwrap(), Some(1));
    assert_eq!(service.get_distance(&b).await.unwrap(), Some(1));
    assert_eq!(service.get_distance(&c).await.unwrap(), Some(2));
    assert_eq!(service.get_distance(&d).await.unwrap(), None);

    // With one follower, every follow of the depth-1 frontier is admitted.
    let repository = InMemoryEventRepository::with_events([seed_event, a_event, b_event]);
    let settings = wot_settings(true, &seed.to_string(), 2, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    assert_eq!(service.get_distance(&c).await.unwrap(), Some(2));
    assert_eq!(service.get_distance(&d).await.unwrap(), Some(2));
    assert_eq!(service.get_distance(&a).await.unwrap(), Some(1));
}

#[tokio::test]
async fn max_depth_zero_holds_only_the_seed() {
    let a_probe = contact_list(&[2; 32], &[]);
    let a = a_probe.pubkey;
    let seed_event = contact_list(&[1; 32], &[&a]);
    let seed = seed_event.pubkey;

    let repository = InMemoryEventRepository::with_events([seed_event]);
    let settings = wot_settings(true, &seed.to_string(), 0, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    assert_eq!(service.get_distance(&a).await.unwrap(), None);
    assert_eq!(service.get_distance(&seed).await.unwrap(), Some(0));
    assert_eq!(repository.reads(), 0, "a depth-0 walk reads no follows");
}

#[tokio::test]
async fn a_cached_follow_list_skips_the_repository() {
    let a_probe = contact_list(&[2; 32], &[]);
    let a = a_probe.pubkey;
    let seed_event = contact_list(&[1; 32], &[]);
    let seed = seed_event.pubkey;

    let repository = InMemoryEventRepository::with_events([seed_event]);
    let settings = wot_settings(true, &seed.to_string(), 1, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    service
        .update_follow_list(&seed, &follows(&[&a]))
        .await
        .unwrap();

    assert_eq!(service.get_distance(&a).await.unwrap(), Some(1));
    assert_eq!(
        repository.reads(),
        0,
        "the cached set answers the seed's follows"
    );
}

#[tokio::test]
async fn an_uncached_pubkey_reads_once_and_its_tags_are_stored() {
    let b_probe = contact_list(&[3; 32], &[]);
    let b = b_probe.pubkey;
    let a_probe = contact_list(&[2; 32], &[]);
    let a = a_probe.pubkey;

    // A's follow list carries B, an empty value and a valueless `p` tag; both are dropped.
    let mut a_event = contact_list(&[2; 32], &[&b]);
    a_event.tags.push(vec!["p".to_owned(), String::new()]);
    a_event.tags.push(vec!["p".to_owned()]);

    let seed_event = contact_list(&[1; 32], &[&a]);
    let seed = seed_event.pubkey;
    let repository = InMemoryEventRepository::with_events([seed_event, a_event]);
    let settings = wot_settings(true, &seed.to_string(), 2, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    assert_eq!(service.get_distance(&b).await.unwrap(), Some(2));
    assert_eq!(repository.reads(), 2, "the seed and A were each read once");

    // A rebuild finds A's `p` tags in the map, so only the seed's row is re-read.
    service
        .update_follow_list(&seed, &follows(&[&a]))
        .await
        .unwrap();
    wait_for_rebuilds(&service, 2).await;
    assert_eq!(
        repository.reads(),
        2,
        "A's extracted follows are cached across builds"
    );
}

#[tokio::test]
async fn only_the_seed_and_graph_members_trigger_a_rebuild() {
    let a_probe = contact_list(&[2; 32], &[]);
    let b_probe = contact_list(&[3; 32], &[]);
    let (a, b) = (a_probe.pubkey, b_probe.pubkey);

    let seed_event = contact_list(&[1; 32], &[&a]);
    let seed = seed_event.pubkey;
    let a_event = contact_list(&[2; 32], &[&b]);
    let repository = InMemoryEventRepository::with_events([seed_event, a_event]);
    let settings = wot_settings(true, &seed.to_string(), 2, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    assert_eq!(service.get_distance(&b).await.unwrap(), Some(2));
    assert_eq!(service.rebuilds(), 1);

    let outsider = testing::pubkey(9);
    service
        .update_follow_list(&outsider, &follows(&[&a]))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(service.rebuilds(), 1, "an outsider cannot move a distance");

    service
        .update_follow_list(&a, &follows(&[&b]))
        .await
        .unwrap();
    wait_for_rebuilds(&service, 2).await;

    service
        .update_follow_list(&seed, &follows(&[&a]))
        .await
        .unwrap();
    wait_for_rebuilds(&service, 3).await;
}

#[tokio::test]
async fn two_triggers_during_a_build_queue_one_rebuild() {
    let b_probe = contact_list(&[3; 32], &[]);
    let b = b_probe.pubkey;
    let a_probe = contact_list(&[2; 32], &[]);
    let a = a_probe.pubkey;

    // A follows nobody, so its (empty) follow list is never cached: every build reads it.
    let seed_event = contact_list(&[1; 32], &[&a]);
    let seed = seed_event.pubkey;
    let repository =
        InMemoryEventRepository::with_events([seed_event, contact_list(&[2; 32], &[])]);
    let settings = wot_settings(true, &seed.to_string(), 2, 1);
    let service = WotGraphService::new(Arc::new(settings), events(&repository));

    let gate = repository.gate_reads();

    // The first trigger's build blocks at A's row; the next two arrive while it is in flight.
    service
        .update_follow_list(&seed, &follows(&[&a]))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    service
        .update_follow_list(&seed, &follows(&[&a]))
        .await
        .unwrap();
    service
        .update_follow_list(&seed, &follows(&[&a]))
        .await
        .unwrap();

    gate.add_permits(16);
    wait_for_rebuilds(&service, 2).await;

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        service.rebuilds(),
        2,
        "two triggers during one build queue exactly one more"
    );
    assert_eq!(repository.reads(), 2, "one read per build");

    assert_eq!(service.get_distance(&b).await.unwrap(), None);
}
