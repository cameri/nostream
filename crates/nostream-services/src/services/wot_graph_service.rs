//! `wot-graph-service.ts`: the web-of-trust graph the relay's contact-list and report
//! strategies reach for.
//!
//! The adjacency and the distance map live in this process (ADR 0010): the capture kept the
//! follow sets in Redis and this rewrite keeps them in a map, so a rebuild still falls back to
//! the newest kind-3 event for a pubkey whose set is empty — exactly as the capture's
//! `cached.length` test does.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use nostream_config::Settings;
use nostream_core::{Filter, Kind, Pubkey};
use nostream_relay::wot::{WotFuture, WotGraph};
use nostream_storage::repositories::EventRepository;
use tokio::sync::Notify;

use crate::error::ServicesError;

/// The seed's grammar (`SEED_PUBKEY_PATTERN`, `src/services/wot-graph-service.ts:12`).
const SEED_LENGTH: usize = 64;

/// `WotGraphService`.
#[derive(Clone)]
pub struct WotGraphService {
    inner: Arc<Inner>,
}

struct Inner {
    settings: Arc<Settings>,
    events: Arc<dyn EventRepository>,
    follows: Mutex<HashMap<String, Vec<String>>>,
    distances: Mutex<HashMap<String, u32>>,
    ready: AtomicBool,
    building: AtomicBool,
    queued: AtomicBool,
    rebuilds: AtomicU64,
    finished: Notify,
}

impl WotGraphService {
    /// Builds the graph over the event store.
    pub fn new(settings: Arc<Settings>, events: Arc<dyn EventRepository>) -> Self {
        Self {
            inner: Arc::new(Inner {
                settings,
                events,
                follows: Mutex::new(HashMap::new()),
                distances: Mutex::new(HashMap::new()),
                ready: AtomicBool::new(false),
                building: AtomicBool::new(false),
                queued: AtomicBool::new(false),
                rebuilds: AtomicU64::new(0),
                finished: Notify::new(),
            }),
        }
    }

    /// How many rebuilds have completed. The capture logs the same number.
    pub fn rebuilds(&self) -> u64 {
        self.inner.rebuilds.load(Ordering::SeqCst)
    }

    /// Whether the graph has been built.
    pub fn is_ready(&self) -> bool {
        self.inner.ready.load(Ordering::SeqCst)
    }

    fn wot(&self) -> Option<&nostream_config::settings::WotSettings> {
        self.inner.settings.wot.as_ref()
    }

    fn is_enabled(&self) -> bool {
        self.wot()
            .is_some_and(|wot| wot.enabled && !wot.seed_pubkey.0.is_empty())
    }

    fn seed(&self) -> Option<String> {
        self.wot()
            .filter(|wot| wot.enabled && !wot.seed_pubkey.0.is_empty())
            .map(|wot| wot.seed_pubkey.0.clone())
    }

    /// Schedules a rebuild without waiting for it: the caller is the event path, which must
    /// not block on a full graph rebuild. A trigger during a build sets one queued rebuild.
    fn trigger(&self) {
        if self.inner.building.swap(true, Ordering::SeqCst) {
            self.inner.queued.store(true, Ordering::SeqCst);
            return;
        }

        let service = self.clone();
        tokio::spawn(async move { service.run_builds().await });
    }

    async fn ensure_built(&self) {
        if self.inner.ready.load(Ordering::SeqCst) {
            return;
        }

        if self.inner.building.swap(true, Ordering::SeqCst) {
            // A build is in flight; it will fold this trigger into one extra pass, and the
            // caller waits for the whole run rather than starting a second one.
            self.inner.queued.store(true, Ordering::SeqCst);

            while self.inner.building.load(Ordering::SeqCst) {
                self.inner.finished.notified().await;
            }

            return;
        }

        self.run_builds().await;
    }

    async fn run_builds(&self) {
        loop {
            match self.rebuild().await {
                Ok(()) => {
                    self.inner.rebuilds.fetch_add(1, Ordering::SeqCst);
                }
                Err(error) => {
                    tracing::error!(error = %error, "wot graph rebuild failed");
                }
            }

            if !self.inner.queued.swap(false, Ordering::SeqCst) {
                break;
            }
        }

        self.inner.building.store(false, Ordering::SeqCst);
        self.inner.finished.notify_waiters();

        // A trigger that landed between the flag store and the queue swap above would
        // otherwise be lost; it set `queued` while `building` still read true.
        if self.inner.queued.swap(false, Ordering::SeqCst) {
            self.trigger();
        }
    }

    async fn rebuild(&self) -> Result<(), ServicesError> {
        let Some(wot) = self.wot().filter(|wot| wot.enabled) else {
            self.replace_distances(HashMap::new());
            self.inner.ready.store(true, Ordering::SeqCst);
            return Ok(());
        };

        let seed = wot.seed_pubkey.0.clone();

        if seed.is_empty() {
            self.replace_distances(HashMap::new());
            self.inner.ready.store(true, Ordering::SeqCst);
            return Ok(());
        }

        if !is_seed_pubkey(&seed) {
            tracing::error!(
                seed = %seed,
                "wot.seedPubkey is not a 64-character hex pubkey; the trust graph will be empty"
            );
            self.replace_distances(HashMap::new());
            self.inner.ready.store(true, Ordering::SeqCst);
            return Ok(());
        }

        let max_depth = wot.max_depth;
        let minimum_followers = u64::from(wot.minimum_followers);
        let mut distances: HashMap<String, u32> = HashMap::new();
        // Persists across depth levels: a candidate's follower count reflects every
        // already-trusted account that follows it, not just the previous frontier.
        let mut follower_counts: HashMap<String, u64> = HashMap::new();
        let mut frontier = vec![seed.clone()];

        for depth in 1..=max_depth {
            if frontier.is_empty() {
                break;
            }

            let mut candidates: HashSet<String> = HashSet::new();

            for pubkey in &frontier {
                for followed in self.get_follows(pubkey).await? {
                    if followed == seed || distances.contains_key(&followed) {
                        continue;
                    }

                    *follower_counts.entry(followed.clone()).or_default() += 1;
                    candidates.insert(followed);
                }
            }

            let threshold = if depth == 1 { 1 } else { minimum_followers };
            let mut next_frontier = Vec::new();

            // A deterministic order keeps a rebuild's log and its frontier stable.
            let mut ordered: Vec<String> = candidates.into_iter().collect();
            ordered.sort();

            for candidate in ordered {
                if follower_counts.get(&candidate).copied().unwrap_or(0) >= threshold {
                    distances.insert(candidate.clone(), depth);
                    next_frontier.push(candidate);
                }
            }

            frontier = next_frontier;
        }

        self.replace_distances(distances);
        self.inner.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn replace_distances(&self, distances: HashMap<String, u32>) {
        let size = distances.len();
        let mut stored = self
            .inner
            .distances
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *stored = distances;

        if let Some(wot) = self.wot() {
            tracing::debug!(
                pubkeys = size,
                max_depth = wot.max_depth,
                seed = %wot.seed_pubkey.0,
                "rebuilt the wot graph"
            );
        }
    }

    /// The follows of one pubkey: the cached set when it is non-empty, else the newest
    /// kind-3 event's `p` tags (`getFollows`, `:187-211`).
    async fn get_follows(&self, pubkey: &str) -> Result<Vec<String>, ServicesError> {
        {
            let follows = self
                .inner
                .follows
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            if let Some(cached) = follows.get(pubkey).filter(|cached| !cached.is_empty()) {
                return Ok(cached.clone());
            }
        }

        let filter = Filter {
            kinds: Some(vec![Kind::CONTACT_LIST]),
            authors: Some(vec![pubkey.to_owned()]),
            limit: Some(1),
            ..Filter::default()
        };

        let filters = [filter];
        let mut stream = self.inner.events.find_by_filters(&filters).await?;
        let Some(record) = stream.next().await else {
            return Ok(Vec::new());
        };
        let record = record?;

        let follows: Vec<String> = record
            .event
            .tags
            .iter()
            .filter(|tag| {
                tag.first().map(String::as_str) == Some("p")
                    && tag.get(1).is_some_and(|value| !value.is_empty())
            })
            .filter_map(|tag| tag.get(1).cloned())
            .collect();

        if !follows.is_empty() {
            self.inner
                .follows
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(pubkey.to_owned(), follows.clone());
        }

        Ok(follows)
    }
}

impl WotGraph for WotGraphService {
    fn update_follow_list<'a>(
        &'a self,
        pubkey: &'a Pubkey,
        follows: &'a [String],
    ) -> WotFuture<'a, ()> {
        Box::pin(async move {
            if !self.is_enabled() {
                return Ok(());
            }

            let key = pubkey.to_string();
            {
                let mut cached = self
                    .inner
                    .follows
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                cached.remove(&key);

                if !follows.is_empty() {
                    cached.insert(key.clone(), follows.to_vec());
                }
            }

            // A pubkey outside the graph cannot change anyone's distance from the seed, so
            // only a seed or a known member schedules a rebuild.
            let is_member = self
                .seed()
                .is_some_and(|seed| seed.eq_ignore_ascii_case(&key))
                || self
                    .inner
                    .distances
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .contains_key(&key);

            if is_member {
                self.trigger();
            }

            Ok(())
        })
    }

    fn get_distance<'a>(&'a self, pubkey: &'a Pubkey) -> WotFuture<'a, Option<u32>> {
        Box::pin(async move {
            if !self.is_enabled() {
                return Ok(None);
            }

            let key = pubkey.to_string();

            if self
                .seed()
                .is_some_and(|seed| seed.eq_ignore_ascii_case(&key))
            {
                return Ok(Some(0));
            }

            self.ensure_built().await;

            Ok(self
                .inner
                .distances
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&key)
                .copied())
        })
    }
}

/// `SEED_PUBKEY_PATTERN`: 64 hex characters, either case.
fn is_seed_pubkey(value: &str) -> bool {
    value.len() == SEED_LENGTH && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
