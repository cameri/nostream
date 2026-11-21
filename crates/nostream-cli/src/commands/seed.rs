//! `seed.ts` and the knex seed it shells to: the 463-event fixture, or `--count` synthetic ones.
//!
//! The capture shells `pnpm run db:seed`, which deletes every row of `events` and inserts either
//! `seeds/events.json` verbatim or `N` copies expanded by the seed's own rule
//! (`seeds/0000-events.js:73-124`). The port writes through the store instead, which is what
//! lets `seed` read and write one store under a `--data-dir`; `NOSTREAM_SEED_COUNT` is no longer
//! read (V15, Behaviour today).
//!
//! The synthetic identity is the seed's: the secret key `'1'.repeat(64)` — 32 bytes of `0x11` —
//! a content suffix ` [seed:<n>]`, and a `created_at` of the base event's plus the index (V52).

use std::path::PathBuf;

use nostream_core::crypto::sign_event;
use nostream_core::{Event, EventId, Kind, Pubkey, Signature};
use nostream_storage::repositories::EventRecord;

use crate::app::Context;
use crate::bootstrap::project_path;
use crate::config::CommandOutput;
use crate::error::CliError;
use crate::store;

/// The seed's own secret key: 32 bytes of `0x11` (`'1'.repeat(64)`,
/// `seeds/0000-events.js:6`).
pub const SYNTHETIC_SEED_KEY: [u8; 32] = [0x11; 32];

/// The parsed `seed` flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeedOptions {
    /// The raw `--count` value, validated here: the capture's message is its own.
    pub count: Option<String>,
    pub data_dir: Option<PathBuf>,
}

/// Runs `seed` on a runtime the command owns.
pub fn run(context: &Context, options: &SeedOptions) -> Result<CommandOutput, CliError> {
    let count = count(&options.count)?;
    context.block_on(seed(context, options, count))
}

/// `--count` must be a positive integer, thrown at exit 1 (`seed.ts:10-14`).
fn count(raw: &Option<String>) -> Result<Option<usize>, CliError> {
    let Some(raw) = raw else {
        return Ok(None);
    };

    let digits = raw
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| raw.parse::<usize>().ok())
        .flatten()
        .filter(|value| *value >= 1);

    digits
        .map(Some)
        .ok_or_else(|| CliError::command("--count must be a positive integer"))
}

/// `exports.seed`: delete every event, then write the fixture or its expansion.
async fn seed(
    context: &Context,
    options: &SeedOptions,
    count: Option<usize>,
) -> Result<CommandOutput, CliError> {
    let settings = crate::config::effective_settings(&crate::config::resolve_paths(
        &context.cwd,
        None,
        &context.env,
    ))
    .map_err(|error| CliError::command(error.to_string()))?;
    let fixture = read_fixture(&context.cwd)?;
    let events = match count {
        Some(count) => expand(&fixture, count)?,
        None => fixture,
    };

    let opened = store::open(&settings, options.data_dir.as_deref(), &context.env).await?;
    let events_store = opened.events();

    events_store
        .delete_all_events()
        .await
        .map_err(|error| CliError::command(error.to_string()))?;

    let records: Vec<EventRecord> = events
        .into_iter()
        .map(|event| EventRecord {
            row_id: None,
            event,
            first_seen: None,
            deleted_at: None,
            expires_at: None,
            event_deduplication: None,
            remote_address: None,
        })
        .collect();

    events_store
        .create_many(&records)
        .await
        .map_err(|error| CliError::command(error.to_string()))?;

    Ok(CommandOutput::print(vec![match count {
        Some(count) => format!("Seed completed with {count} events requested"),
        None => "Seed completed".to_owned(),
    }]))
}

/// `require('./events.json')`: the fixture the repository ships, read from the working
/// directory as `resources/` is (Assumption 16).
fn read_fixture(cwd: &std::path::Path) -> Result<Vec<Event>, CliError> {
    let path = project_path(cwd, &["seeds", "events.json"]);
    let content = std::fs::read_to_string(&path).map_err(|error| {
        CliError::command(format!("unable to read {}: {error}", path.display()))
    })?;

    serde_json::from_str(&content)
        .map_err(|error| CliError::command(format!("unable to parse {}: {error}", path.display())))
}

/// `expandSeedEvents` + `createSyntheticEvent`: `count` events cycled from the fixture's, each
/// re-timed, re-suffixed and signed by the synthetic key.
pub fn expand(fixture: &[Event], count: usize) -> Result<Vec<Event>, CliError> {
    if fixture.is_empty() {
        return Err(CliError::command(
            "the seed fixture holds no events to expand",
        ));
    }

    let mut events = Vec::with_capacity(count);

    for index in 0..count {
        let base = &fixture[index % fixture.len()];
        let mut event = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at: base.created_at + index as i64,
            kind: Kind(base.kind.0),
            tags: base.tags.clone(),
            content: format!("{} [seed:{}]", base.content, index + 1),
            sig: Signature::from_byte_array([0; 64]),
        };

        sign_event(&SYNTHETIC_SEED_KEY, &mut event)
            .map_err(|error| CliError::command(error.to_string()))?;

        events.push(event);
    }

    Ok(events)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use nostream_core::crypto::verify_event_signature;

    fn base(created_at: i64, content: &str) -> Event {
        let mut event = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at,
            kind: Kind(1),
            tags: Vec::new(),
            content: content.to_owned(),
            sig: Signature::from_byte_array([0; 64]),
        };
        sign_event(&[0x22; 32], &mut event).expect("the fixture event signs");
        event
    }

    #[test]
    fn the_count_must_be_a_positive_integer() {
        assert_eq!(count(&None).unwrap(), None);
        assert_eq!(count(&Some("3".to_owned())).unwrap(), Some(3));

        for bad in ["0", "-1", "abc", ""] {
            let error = count(&Some(bad.to_owned())).expect_err("refused");
            assert_eq!(error.to_string(), "--count must be a positive integer");
        }
    }

    /// AC28's three fields: the suffix, the timing, and the synthetic signature.
    #[test]
    fn the_expansion_carries_the_seeds_three_fields() {
        let fixture = vec![base(1_700_000_000, "first"), base(1_700_000_100, "second")];
        let events = expand(&fixture, 3).expect("the expansion runs");

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].created_at, 1_700_000_000);
        assert_eq!(events[1].created_at, 1_700_000_100 + 1);
        assert_eq!(events[2].created_at, 1_700_000_000 + 2);

        assert_eq!(events[0].content, "first [seed:1]");
        assert_eq!(events[2].content, "first [seed:3]");

        for event in &events {
            verify_event_signature(event).expect("the synthetic key signed it");
        }
    }
}
