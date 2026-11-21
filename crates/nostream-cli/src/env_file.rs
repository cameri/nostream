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
//!
//! **Known divergences from `node --env-file`, both safe.** The *line* is the capture's
//! `ENV_LINE_REGEX` (`src/cli/utils/env-config.ts:16`) and only the *value* is node's: node also
//! honours `export A=1` and keys like `A.B` or `A B` (measured on this host with v24.22.1), and
//! this parser skips all three. Nothing the CLI reads is such a key — every consumer goes through
//! [`SUPPORTED_KEYS`], which holds none of them — so the only exposure is a line node would honour
//! and the port would not, such as `export NOSTR_CONFIG_DIR=…`; an operator writing it gets the
//! capture's behaviour only. Node's multi-line values are likewise not reproduced: an unterminated
//! quote swallows the rest of the file there, while this parser reads line by line, as the
//! capture's own reader does. Both answers are wrong for malformed input, and the line-by-line one
//! is the capture's.

use std::collections::BTreeMap;
use std::path::Path;

/// The environment one command sees: the process's variables, then the `.env` file's.
///
/// One file, **two views**, exactly as the capture has them: node parses the environment it
/// launches with (quotes and inline comments are syntax there), while the capture's own
/// `parseEnvFile` keeps the value raw for `config env list`, `get`, `validate` and `set`
/// (`src/cli/utils/env-config.ts:16,75-112`). `layer` is the first and answers [`Self::get`];
/// `file` is the second and answers [`Self::file`]/[`Self::file_values`]. Collapsing them made
/// `config env set DB_PASSWORD 'p#ss'` write a line its own `get` read back as `p`.
#[derive(Debug, Clone, Default)]
pub struct Environment {
    /// The `.env` layer as node reads it: the values a launched process would see.
    layer: BTreeMap<String, String>,
    /// The file's own values, raw — what the `config env` commands report, validate and write.
    file: BTreeMap<String, String>,
}

impl Environment {
    /// Reads `<cwd>/.env` when it exists; a missing file is an empty layer.
    pub fn load(cwd: &Path) -> Self {
        let path = cwd.join(".env");
        match std::fs::read_to_string(&path) {
            Ok(content) => Self {
                layer: parse_values(&content),
                file: parse_raw(&content),
            },
            Err(_) => Self::default(),
        }
    }

    /// An environment with no file layer, which is what unit tests build.
    pub fn empty() -> Self {
        Self::default()
    }

    /// An environment whose file layer is the given table, in both views — a table that came from
    /// one parse has nothing for the other to differ on.
    pub fn from_values(file: BTreeMap<String, String>) -> Self {
        Self {
            layer: file.clone(),
            file,
        }
    }

    /// One value: the process's, else the **node-parsed** file layer's. This is the view a launched
    /// process would see, and it is what `store::open`, `import`, `migrate` and the rest of the
    /// commands read.
    pub fn get(&self, key: &str) -> Option<String> {
        std::env::var(key)
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| self.layer.get(key).cloned())
    }

    /// One **raw** file value, which is what `config env get` prints.
    pub fn file(&self, key: &str) -> Option<&str> {
        self.file.get(key).map(String::as_str)
    }

    /// The **raw** file table, for `config env list` and `config env validate`: the capture's
    /// commands describe the file, not the environment a parse of it would produce.
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

/// The `KEY=VALUE` pairs a `.env` document holds, in file order collapsed to key order, with each
/// value read as [`parse_value`] reads it — node's rule, which is the **environment** view.
pub fn parse_values(content: &str) -> BTreeMap<String, String> {
    parse_lines(content, parse_value)
}

/// The same pairs with each value **raw**: everything after the first `=`, trimmed, exactly what
/// the capture's `parseEnvFile` keeps in `match[2]` (`src/cli/utils/env-config.ts:75-112`). This is
/// the **file** view — what `config env list`, `get` and `validate` report and what
/// [`upsert_value`] writes back — so a value written by `config env set` reads back unchanged.
pub fn parse_raw(content: &str) -> BTreeMap<String, String> {
    parse_lines(content, |value| value.trim().to_owned())
}

/// The lines both views agree on: a comment line and a line that is not `KEY=…` are skipped,
/// exactly as the capture's `ENV_LINE_REGEX` parse does, and the split is on the first `=`.
fn parse_lines(content: &str, value: impl Fn(&str) -> String) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();

    for line in content.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
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
        values.insert(key.to_owned(), value(raw));
    }

    values
}

/// One value as `node --env-file` reads it — the oracle this module's header names, measured on
/// this host (v24.22.1) over `A="hello world"`, `B=plain # trailing`, `C='single'`,
/// `` D=`tick` ``, `E=unquoted#nospace` and `DB_PASSWORD="p@ss#word"`: one balanced pair of
/// surrounding quotes — `'`, `"` **or a backtick**, which node also strips — is removed, and an
/// **unquoted** `#` starts a comment (no space needed before it, as `E` shows). A `#` inside the
/// quotes is part of the value. The split on the first `=` is the caller's, so `KEY=a=b` keeps
/// `a=b`.
fn parse_value(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut characters = trimmed.chars();
    if let Some(quote @ ('\'' | '"' | '`')) = characters.next() {
        let rest = characters.as_str();
        if let Some(end) = rest.find(quote) {
            return rest[..end].to_owned();
        }
    }

    match trimmed.find('#') {
        Some(at) => trimmed[..at].trim_end().to_owned(),
        None => trimmed.to_owned(),
    }
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

    /// `node --env-file` is the oracle the module header names, and it strips a surrounding quote
    /// pair — `'`, `"` or a backtick — and an inline comment: measured on this host (node
    /// v24.22.1) over these six lines, `node --env-file=probe.env -e …` answers
    /// `["hello world","plain","single","tik","unquoted","p@ss#word"]`. A `#` inside quotes
    /// therefore stays, an unquoted one starts a comment with or without a space before it, and
    /// the split on the first `=` is untouched (`SECRET=abc=def` above). The line forms node
    /// accepts and this parser does not (`export A=1`, `A.B`, `A B`) are the module doc's
    /// documented divergence.
    #[test]
    fn the_parse_strips_quotes_and_comments_as_node_does() {
        let values = parse_values(
            "A=\"hello world\"\nB=plain # trailing\nC='single'\nD=`tik`\nE=unquoted#nospace\n\
             DB_PASSWORD=\"p@ss#word\"\n",
        );
        assert_eq!(values.get("A").map(String::as_str), Some("hello world"));
        assert_eq!(values.get("B").map(String::as_str), Some("plain"));
        assert_eq!(values.get("C").map(String::as_str), Some("single"));
        assert_eq!(values.get("D").map(String::as_str), Some("tik"));
        assert_eq!(values.get("E").map(String::as_str), Some("unquoted"));
        assert_eq!(
            values.get("DB_PASSWORD").map(String::as_str),
            Some("p@ss#word")
        );
    }
}
