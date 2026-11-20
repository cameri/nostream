//! The `.env` file, and the environment as the CLI reads it.
//!
//! Mirrors `src/cli/utils/env-config.ts` (the key tables, the validators, the secret mask and
//! the upsert) and the one behaviour the capture gets from its entry points rather than its
//! code: every `pnpm run cli` runs under `node --env-file-if-exists=.env`
//! (`package.json:58`), so a value in `.env` is in the environment unless the process already
//! set it. That order — process first, file second — is what [`Environment::get`] answers.
//!
//! The file is read, never written through the environment: this crate cannot call
//! `std::env::set_var` (it is `unsafe` in edition 2024 and the workspace denies unsafe code), so
//! the `.env` layer is a lookup every caller goes through instead of a mutation.

use std::collections::BTreeMap;
use std::path::Path;

/// The environment one command sees: the process's variables, then the `.env` file's.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    file: BTreeMap<String, String>,
}

impl Environment {
    /// Reads `<cwd>/.env` when it exists; a missing file is an empty layer.
    pub fn load(cwd: &Path) -> Self {
        let path = cwd.join(".env");
        match std::fs::read_to_string(&path) {
            Ok(content) => Self {
                file: parse_values(&content),
            },
            Err(_) => Self::default(),
        }
    }

    /// An environment with no file layer, which is what unit tests build.
    pub fn empty() -> Self {
        Self::default()
    }

    /// An environment whose file layer is the given table.
    pub fn from_values(file: BTreeMap<String, String>) -> Self {
        Self { file }
    }

    /// One value: the process's, else the file's.
    pub fn get(&self, key: &str) -> Option<String> {
        std::env::var(key)
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| self.file.get(key).cloned())
    }

    /// One value from the file layer alone, ignoring the process environment.
    pub fn file(&self, key: &str) -> Option<&str> {
        self.file.get(key).map(String::as_str)
    }

    /// The file layer, for `config env list` and `validate`.
    pub fn file_values(&self) -> &BTreeMap<String, String> {
        &self.file
    }
}

/// The key tables (`src/cli/utils/env-config.ts:18-73`).
const SUPPORTED_KEYS: &[&str] = &[
    "SECRET",
    "RELAY_PORT",
    "RELAY_PRIVATE_KEY",
    "MONITOR_PRIVATE_KEY",
    "WORKER_COUNT",
    "DB_URI",
    "DB_HOST",
    "DB_PORT",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "DB_MIN_POOL_SIZE",
    "DB_MAX_POOL_SIZE",
    "DB_ACQUIRE_CONNECTION_TIMEOUT",
    "READ_REPLICA_ENABLED",
    "READ_REPLICAS",
    "TOR_HOST",
    "TOR_CONTROL_PORT",
    "TOR_PASSWORD",
    "HIDDEN_SERVICE_PORT",
    "REDIS_URI",
    "REDIS_HOST",
    "REDIS_PORT",
    "REDIS_USER",
    "REDIS_PASSWORD",
    "NOSTR_CONFIG_DIR",
    "DEBUG",
    "ZEBEDEE_API_KEY",
    "NODELESS_API_KEY",
    "NODELESS_WEBHOOK_SECRET",
    "OPENNODE_API_KEY",
    "LNBITS_API_KEY",
    "LOG_LEVEL",
];

const INTEGER_KEYS: &[&str] = &[
    "RELAY_PORT",
    "WORKER_COUNT",
    "DB_PORT",
    "DB_MIN_POOL_SIZE",
    "DB_MAX_POOL_SIZE",
    "DB_ACQUIRE_CONNECTION_TIMEOUT",
    "READ_REPLICAS",
    "TOR_CONTROL_PORT",
    "HIDDEN_SERVICE_PORT",
    "REDIS_PORT",
];

const BOOLEAN_KEYS: &[&str] = &["READ_REPLICA_ENABLED"];

/// `RR\d+_DB_(…)` — the read-replica family, which the key table accepts by shape.
fn is_replica_key(key: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "HOST",
        "PORT",
        "USER",
        "PASSWORD",
        "NAME",
        "MIN_POOL_SIZE",
        "MAX_POOL_SIZE",
        "ACQUIRE_CONNECTION_TIMEOUT",
    ];
    let Some(rest) = key.strip_prefix("RR") else {
        return false;
    };
    let Some((index, suffix)) = rest.split_once("_DB_") else {
        return false;
    };
    !index.is_empty()
        && index.bytes().all(|byte| byte.is_ascii_digit())
        && SUFFIXES.contains(&suffix)
}

fn is_replica_integer_key(key: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "PORT",
        "MIN_POOL_SIZE",
        "MAX_POOL_SIZE",
        "ACQUIRE_CONNECTION_TIMEOUT",
    ];
    let Some(rest) = key.strip_prefix("RR") else {
        return false;
    };
    let Some((index, suffix)) = rest.split_once("_DB_") else {
        return false;
    };
    !index.is_empty()
        && index.bytes().all(|byte| byte.is_ascii_digit())
        && SUFFIXES.contains(&suffix)
}

/// Whether `config env` may read or write this key.
pub fn is_supported_key(key: &str) -> bool {
    SUPPORTED_KEYS.contains(&key) || is_replica_key(key)
}

/// Whether the key's value is a secret the list and get commands mask.
pub fn is_secret_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY"]
        .iter()
        .any(|needle| upper.contains(needle))
}

/// The masked form `config env` prints: two characters either side, `***` between; a short value
/// is all stars, and an empty one is `***` (`maskSecretValue`, `src/cli/utils/env-config.ts:206-216`).
pub fn mask_secret_value(value: &str) -> String {
    if value.is_empty() {
        return "***".to_owned();
    }

    let characters: Vec<char> = value.chars().collect();
    if characters.len() <= 4 {
        return "*".repeat(characters.len());
    }

    let head: String = characters[..2].iter().collect();
    let tail: String = characters[characters.len() - 2..].iter().collect();
    format!("{head}***{tail}")
}

/// `toCategoryLabel` (`src/utils/settings-config.ts:189-195`): the first letter of each
/// `_`/`-`/`.`-separated part raised, then joined with spaces.
pub fn category_label(key: &str) -> String {
    key.split(['_', '-', '.'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut characters = part.chars();
            match characters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The value checks one key answers, or `None` when the pair is valid
/// (`validateEnvPair`, `src/cli/utils/env-config.ts:138-152`).
pub fn validate_pair(key: &str, value: &str) -> Option<String> {
    if !is_supported_key(key) {
        return Some(format!("{key} is not a supported environment setting"));
    }

    if INTEGER_KEYS.contains(&key) || is_replica_integer_key(key) {
        let trimmed = value.trim();
        let digits = trimmed.strip_prefix('-').unwrap_or(trimmed);
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return Some(format!("{key} must be an integer"));
        }
        if trimmed.parse::<i64>().is_err() {
            return Some(format!("{key} must be a safe integer"));
        }
        return None;
    }

    if BOOLEAN_KEYS.contains(&key) {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized != "true" && normalized != "false" {
            return Some(format!("{key} must be true or false"));
        }
    }

    None
}

/// Every invalid pair in a `.env` table, in key order.
pub fn validate_values(values: &BTreeMap<String, String>) -> Vec<(String, String)> {
    values
        .iter()
        .filter_map(|(key, value)| validate_pair(key, value).map(|message| (key.clone(), message)))
        .collect()
}

/// The `KEY=VALUE` pairs a `.env` document holds, in file order collapsed to key order.
///
/// A comment line and a line that is not `KEY=…` are skipped, exactly as the capture's
/// `ENV_LINE_REGEX` parse does; the value keeps everything after the first `=`.
pub fn parse_values(content: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();

    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        {
            continue;
        }
        if !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            continue;
        }
        values.insert(key.to_owned(), value.trim().to_owned());
    }

    values
}

/// `upsertEnvValue`: replaces the key's first line, or appends `KEY=VALUE` after a blank line,
/// and leaves the document newline-terminated (`src/cli/utils/env-config.ts:165-182`).
pub fn upsert_value(content: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = content.split('\n').map(str::to_owned).collect();
    let replacement = format!("{key}={value}");

    let existing = lines.iter().position(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with('#')
            && trimmed
                .split_once('=')
                .is_some_and(|(candidate, _)| candidate.trim() == key)
    });

    match existing {
        Some(index) => lines[index] = replacement,
        None => {
            if lines.last().is_some_and(|line| !line.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(replacement);
        }
    }

    let mut joined = lines.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn a_secret_is_masked_two_characters_either_side() {
        assert_eq!(mask_secret_value("abcdef"), "ab***ef");
        assert_eq!(mask_secret_value("abcd"), "****");
        assert_eq!(mask_secret_value(""), "***");
    }

    #[test]
    fn the_value_checks_are_the_captures() {
        assert_eq!(
            validate_pair("FOO", "bar").as_deref(),
            Some("FOO is not a supported environment setting")
        );
        assert_eq!(
            validate_pair("RELAY_PORT", "x").as_deref(),
            Some("RELAY_PORT must be an integer")
        );
        assert_eq!(
            validate_pair("READ_REPLICA_ENABLED", "yes").as_deref(),
            Some("READ_REPLICA_ENABLED must be true or false")
        );
        assert_eq!(validate_pair("RELAY_PORT", "8008"), None);
        assert_eq!(validate_pair("RR1_DB_HOST", "replica"), None);
        assert_eq!(
            validate_pair("RR1_DB_PORT", "not-a-port").as_deref(),
            Some("RR1_DB_PORT must be an integer")
        );
        assert!(is_supported_key("RR12_DB_MAX_POOL_SIZE"));
        assert!(!is_supported_key("RR_DB_HOST"));
    }

    #[test]
    fn the_category_label_raises_only_the_first_letter() {
        assert_eq!(category_label("FOO"), "FOO");
        // `toCategoryLabel` uppercases each part's first letter and keeps the rest
        // (`src/utils/settings-config.ts:190-196`): a part is never lowercased.
        assert_eq!(category_label("RR1_DB_HOST"), "RR1 DB HOST");
    }

    #[test]
    fn an_upsert_replaces_the_key_or_appends_it() {
        assert_eq!(
            upsert_value("SECRET=abcdef\nFOO=bar\n", "FOO", "baz"),
            "SECRET=abcdef\nFOO=baz\n"
        );
        assert_eq!(
            upsert_value("SECRET=abcdef\n", "RELAY_PORT", "8008"),
            "SECRET=abcdef\n\nRELAY_PORT=8008\n"
        );
    }

    #[test]
    fn the_parse_skips_comments_and_keeps_the_value_whole() {
        let values = parse_values("# a comment\nSECRET=abc=def\n\nnot a pair\nFOO=bar\n");
        assert_eq!(values.get("SECRET").map(String::as_str), Some("abc=def"));
        assert_eq!(values.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(values.len(), 2);
    }
}
