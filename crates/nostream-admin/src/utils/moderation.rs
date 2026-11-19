//! Moderator limits: reading them, applying an action, and persisting the result through the
//! settings store. Mirrors `src/utils/admin-moderation.ts`.
//!
//! Values are read from and written to the settings **document**, because that is what the
//! capture does (`applyLimitsToUserSettings`) and what keeps the kind rules — numbers or
//! `[start, end]` pairs — byte-identical through a round trip.
//!
//! **A narrowing, recorded rather than hidden:** pubkeys are accepted in the 64-character hex
//! form only. shortcut: hex pubkeys only, upgrade when `nostream-core` grows a bech32 decoder.
//! The capture also accepts an `npub`, and this tree has no bech32 decoder
//! (`crates/nostream-relay/src/handlers/subscribe.rs:152-153` refuses the same form for the
//! same reason). An `npub` is a `400` here, never silently stored.

use std::net::IpAddr;
use std::str::FromStr;

use nostream_config::{Issue, validate_document};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AdminError;

/// One side of a pubkey or kind list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pair<T> {
    #[serde(default)]
    pub blacklist: Vec<T>,
    #[serde(default)]
    pub whitelist: Vec<T>,
}

/// The rate-limit bypass lists.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassLists {
    #[serde(default)]
    pub pubkeys: Vec<String>,
    #[serde(default)]
    pub ip_addresses: Vec<String>,
}

/// `GET /moderation/limits` (`AdminModerationLimits`, `src/utils/admin-moderation.ts:11-20`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationLimits {
    pub pubkey: Pair<String>,
    /// A kind rule is a number or a `[start, end]` pair, kept as it was written.
    pub kind: Pair<Value>,
    pub rate_limit_bypass: BypassLists,
}

/// The six actions `POST /moderation/actions` accepts (`AdminModerationAction`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationAction {
    BanPubkey,
    UnbanPubkey,
    WhitelistPubkey,
    UnwhitelistPubkey,
    WhitelistIp,
    UnwhitelistIp,
}

impl ModerationAction {
    /// The wire name.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ban-pubkey" => Some(Self::BanPubkey),
            "unban-pubkey" => Some(Self::UnbanPubkey),
            "whitelist-pubkey" => Some(Self::WhitelistPubkey),
            "unwhitelist-pubkey" => Some(Self::UnwhitelistPubkey),
            "whitelist-ip" => Some(Self::WhitelistIp),
            "unwhitelist-ip" => Some(Self::UnwhitelistIp),
            _ => None,
        }
    }

    /// The action's audit name (`moderation.action`'s `detail.action`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BanPubkey => "ban-pubkey",
            Self::UnbanPubkey => "unban-pubkey",
            Self::WhitelistPubkey => "whitelist-pubkey",
            Self::UnwhitelistPubkey => "unwhitelist-pubkey",
            Self::WhitelistIp => "whitelist-ip",
            Self::UnwhitelistIp => "unwhitelist-ip",
        }
    }
}

/// Why a moderation write could not be applied.
#[derive(Debug)]
pub enum ModerationError {
    /// A `400 {"error": …}` answer.
    Message(String),
    /// A `400 {"error":"Validation failed","issues":[…]}` answer.
    Validation(Vec<Issue>),
}

impl From<ModerationError> for AdminError {
    fn from(error: ModerationError) -> Self {
        match error {
            ModerationError::Message(message) => AdminError::Invalid(message),
            ModerationError::Validation(issues) => AdminError::Invalid(
                issues
                    .iter()
                    .map(|issue| issue.to_string())
                    .collect::<Vec<String>>()
                    .join("; "),
            ),
        }
    }
}

/// The capture's two pubkey messages.
const PUBKEY_REQUIRED: &str = "pubkey is required and must be a 64-character hex pubkey or npub";
const IP_REQUIRED: &str = "ip is required and must be a valid IPv4 or IPv6 address";

fn strings_at(value: Option<&serde_yaml::Value>) -> Vec<String> {
    match value {
        Some(serde_yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| match item {
                serde_yaml::Value::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn kind_rules_at(value: Option<&serde_yaml::Value>) -> Vec<Value> {
    match value {
        Some(serde_yaml::Value::Sequence(items)) => items
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect(),
        _ => Vec::new(),
    }
}

/// Reads the limits from a merged settings document (`readAdminModerationLimits`).
pub fn read_limits(document: &serde_yaml::Value) -> ModerationLimits {
    let event_limits = document
        .get("limits")
        .and_then(|limits| limits.get("event"));
    let pubkey = event_limits.and_then(|event| event.get("pubkey"));
    let kind = event_limits.and_then(|event| event.get("kind"));
    let whitelists = event_limits.and_then(|event| event.get("whitelists"));

    ModerationLimits {
        pubkey: Pair {
            blacklist: strings_at(pubkey.and_then(|limits| limits.get("blacklist"))),
            whitelist: strings_at(pubkey.and_then(|limits| limits.get("whitelist"))),
        },
        kind: Pair {
            blacklist: kind_rules_at(kind.and_then(|limits| limits.get("blacklist"))),
            whitelist: kind_rules_at(kind.and_then(|limits| limits.get("whitelist"))),
        },
        rate_limit_bypass: BypassLists {
            pubkeys: strings_at(whitelists.and_then(|lists| lists.get("pubkeys"))),
            ip_addresses: strings_at(whitelists.and_then(|lists| lists.get("ipAddresses"))),
        },
    }
}

/// Writes the limits into a user settings document (the capture's
/// `applyLimitsToUserSettings`), leaving every other key alone.
pub fn write_limits(user: &serde_yaml::Value, limits: &ModerationLimits) -> serde_yaml::Value {
    let mut document = user.clone();
    if !document.is_mapping() {
        document = serde_yaml::Value::Mapping(Default::default());
    }

    let sequences = |values: &[String]| {
        serde_yaml::Value::Sequence(
            values
                .iter()
                .map(|value| serde_yaml::Value::String(value.clone()))
                .collect(),
        )
    };
    let kind_sequences = |values: &[Value]| {
        serde_yaml::Value::Sequence(
            values
                .iter()
                .filter_map(|value| serde_yaml::from_str(&value.to_string()).ok())
                .collect(),
        )
    };
    let set = |document: &mut serde_yaml::Value, path: &str, value: serde_yaml::Value| {
        if let Ok(next) = nostream_config::path::set_by_path(document, path, value) {
            *document = next;
        }
    };

    set(
        &mut document,
        "limits.event.pubkey.blacklist",
        sequences(&limits.pubkey.blacklist),
    );
    set(
        &mut document,
        "limits.event.pubkey.whitelist",
        sequences(&limits.pubkey.whitelist),
    );
    set(
        &mut document,
        "limits.event.kind.blacklist",
        kind_sequences(&limits.kind.blacklist),
    );
    set(
        &mut document,
        "limits.event.kind.whitelist",
        kind_sequences(&limits.kind.whitelist),
    );
    set(
        &mut document,
        "limits.event.whitelists.pubkeys",
        sequences(&limits.rate_limit_bypass.pubkeys),
    );
    set(
        &mut document,
        "limits.event.whitelists.ipAddresses",
        sequences(&limits.rate_limit_bypass.ip_addresses),
    );
    document
}

/// A 64-character lowercase-hex pubkey (`isHexPubkey`).
pub fn is_hex_pubkey(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn require_pubkey(fields: &ActionFields) -> Result<String, ModerationError> {
    match fields.pubkey.as_deref() {
        Some(pubkey) if is_hex_pubkey(pubkey) => Ok(pubkey.to_owned()),
        _ => Err(ModerationError::Message(PUBKEY_REQUIRED.to_owned())),
    }
}

/// `normalizeModerationIpAddress`: parse and re-render the address so two spellings compare
/// equal.
pub fn normalize_ip_address(raw: &str) -> Result<String, ModerationError> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err(ModerationError::Message(IP_REQUIRED.to_owned()));
    }
    IpAddr::from_str(candidate)
        .map(|address| address.to_string())
        .map_err(|_| ModerationError::Message(IP_REQUIRED.to_owned()))
}

fn require_ip(fields: &ActionFields) -> Result<String, ModerationError> {
    match fields.ip.as_deref() {
        Some(ip) => normalize_ip_address(ip),
        None => Err(ModerationError::Message(IP_REQUIRED.to_owned())),
    }
}

/// The fields a moderation action carries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActionFields {
    pub pubkey: Option<String>,
    pub ip: Option<String>,
}

fn without_value(list: Vec<String>, value: &str) -> Vec<String> {
    list.into_iter().filter(|entry| entry != value).collect()
}

/// `applyAdminModerationAction`: the six actions, each refusing a malformed target.
pub fn apply_action(
    current: &ModerationLimits,
    action: ModerationAction,
    fields: &ActionFields,
) -> Result<ModerationLimits, ModerationError> {
    let mut next = current.clone();
    match action {
        ModerationAction::BanPubkey => {
            let pubkey = require_pubkey(fields)?;
            let mut blacklist: Vec<String> = next
                .pubkey
                .blacklist
                .iter()
                .map(|entry| entry.to_lowercase())
                .collect();
            if !blacklist.contains(&pubkey) {
                blacklist.push(pubkey);
            }
            next.pubkey.blacklist = blacklist;
        }
        ModerationAction::UnbanPubkey => {
            let pubkey = require_pubkey(fields)?;
            let blacklist: Vec<String> = next
                .pubkey
                .blacklist
                .iter()
                .map(|entry| entry.to_lowercase())
                .collect();
            next.pubkey.blacklist = without_value(blacklist, &pubkey);
        }
        ModerationAction::WhitelistPubkey => {
            let pubkey = require_pubkey(fields)?;
            let mut pubkeys: Vec<String> = next
                .rate_limit_bypass
                .pubkeys
                .iter()
                .map(|entry| entry.to_lowercase())
                .collect();
            if !pubkeys.contains(&pubkey) {
                pubkeys.push(pubkey);
            }
            next.rate_limit_bypass.pubkeys = pubkeys;
        }
        ModerationAction::UnwhitelistPubkey => {
            let pubkey = require_pubkey(fields)?;
            let pubkeys: Vec<String> = next
                .rate_limit_bypass
                .pubkeys
                .iter()
                .map(|entry| entry.to_lowercase())
                .collect();
            next.rate_limit_bypass.pubkeys = without_value(pubkeys, &pubkey);
        }
        ModerationAction::WhitelistIp => {
            let ip = require_ip(fields)?;
            if !next.rate_limit_bypass.ip_addresses.contains(&ip) {
                next.rate_limit_bypass.ip_addresses.push(ip);
            }
        }
        ModerationAction::UnwhitelistIp => {
            let ip = require_ip(fields)?;
            next.rate_limit_bypass.ip_addresses.retain(|stored| {
                normalize_ip_address(stored).map_or_else(
                    |_| !stored.trim().eq_ignore_ascii_case(&ip),
                    |normalized| normalized != ip,
                )
            });
        }
    }
    Ok(next)
}

/// Normalizes every list the way `persistAdminModerationLimits` does before saving.
pub fn normalize(limits: &ModerationLimits) -> Result<ModerationLimits, ModerationError> {
    let normalize_pubkeys =
        |values: &[String], label: &str| -> Result<Vec<String>, ModerationError> {
            let mut normalized = Vec::new();
            for raw in values {
                if !is_hex_pubkey(raw) {
                    return Err(ModerationError::Message(format!(
                        "{label} must contain 64-character hex pubkeys or npubs"
                    )));
                }
                if !normalized.contains(raw) {
                    normalized.push(raw.clone());
                }
            }
            Ok(normalized)
        };

    let mut ip_addresses = Vec::new();
    for raw in &limits.rate_limit_bypass.ip_addresses {
        let ip = normalize_ip_address(raw).map_err(|_| {
            ModerationError::Message(
                "rate-limit bypass IP list must contain valid IPv4 or IPv6 addresses".to_owned(),
            )
        })?;
        if !ip_addresses.contains(&ip) {
            ip_addresses.push(ip);
        }
    }

    Ok(ModerationLimits {
        pubkey: Pair {
            blacklist: normalize_pubkeys(&limits.pubkey.blacklist, "pubkey blacklist")?,
            whitelist: normalize_pubkeys(&limits.pubkey.whitelist, "pubkey whitelist")?,
        },
        kind: limits.kind.clone(),
        rate_limit_bypass: BypassLists {
            pubkeys: normalize_pubkeys(
                &limits.rate_limit_bypass.pubkeys,
                "rate-limit bypass pubkeys",
            )?,
            ip_addresses,
        },
    })
}

/// The merged document's validation issues (`Validation failed`'s `issues`).
pub fn validation_issues(merged: &serde_yaml::Value, defaults: &serde_yaml::Value) -> Vec<Issue> {
    validate_document(merged, defaults)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn a_banned_pubkey_appears_in_the_read_limits() {
        let document: serde_yaml::Value = serde_yaml::from_str(
            "limits:\n  event:\n    pubkey:\n      blacklist:\n        - abc\n      whitelist: []\n    kind:\n      blacklist:\n        - 4\n      whitelist:\n        - [1000, 1999]\n    whitelists:\n      pubkeys:\n        - def\n      ipAddresses:\n        - 1.2.3.4\n",
        )
        .unwrap();
        let limits = read_limits(&document);
        assert_eq!(limits.pubkey.blacklist, vec!["abc".to_owned()]);
        assert_eq!(limits.kind.whitelist, vec![serde_json::json!([1000, 1999])]);
        assert_eq!(limits.rate_limit_bypass.ip_addresses, vec!["1.2.3.4"]);
    }

    #[test]
    fn an_action_needs_its_target() {
        let limits = ModerationLimits::default();
        let error = apply_action(
            &limits,
            ModerationAction::BanPubkey,
            &ActionFields::default(),
        )
        .unwrap_err();
        assert!(
            matches!(error, ModerationError::Message(message) if message.starts_with("pubkey is required"))
        );
        let error = apply_action(
            &limits,
            ModerationAction::WhitelistIp,
            &ActionFields::default(),
        )
        .unwrap_err();
        assert!(
            matches!(error, ModerationError::Message(message) if message.starts_with("ip is required"))
        );
    }

    #[test]
    fn an_ip_is_normalized_before_it_is_stored() {
        let action = apply_action(
            &ModerationLimits::default(),
            ModerationAction::WhitelistIp,
            &ActionFields {
                ip: Some(" 2001:DB8:0:0:0:0:0:1 ".to_owned()),
                ..ActionFields::default()
            },
        )
        .unwrap();
        assert_eq!(
            action.rate_limit_bypass.ip_addresses,
            vec!["2001:db8::1".to_owned()]
        );
    }

    #[test]
    fn writing_limits_leaves_other_keys_alone() {
        let user: serde_yaml::Value = serde_yaml::from_str("info:\n  name: Example\n").unwrap();
        let mut limits = ModerationLimits::default();
        limits.pubkey.blacklist.push("ab".repeat(32));
        let written = write_limits(&user, &limits);
        assert_eq!(
            written["info"]["name"],
            serde_yaml::Value::String("Example".to_owned())
        );
        assert_eq!(
            written["limits"]["event"]["pubkey"]["blacklist"][0],
            serde_yaml::Value::String("ab".repeat(32))
        );
    }
}
