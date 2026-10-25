//! The guided settings catalogue. Mirrors `src/utils/settings-guided-schema.ts` at the
//! capture commit (the oracle's `nip77` entries and `requireSafePositiveIntegerSettingValue`
//! are deferred with the five-file forward port; spec §6).

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// The editor control a field uses (`GuidedSettingFieldType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuidedSettingFieldType {
    Boolean,
    Number,
    #[serde(rename = "string")]
    Text,
    Select,
    StringArray,
}

/// A value validator (`GuidedSettingFieldValidator`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidedSettingValidator {
    NonEmpty,
    SafeNonNegativeInteger,
}

impl GuidedSettingValidator {
    /// Applies the validator, returning the capture's message on failure.
    pub fn validate(self, value: &str) -> Option<&'static str> {
        match self {
            Self::NonEmpty => require_non_empty_setting_value(value),
            Self::SafeNonNegativeInteger => require_safe_non_negative_integer_setting_value(value),
        }
    }
}

/// One editable field (`GuidedSettingField`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuidedSettingField {
    pub label: String,
    pub path: String,
    #[serde(rename = "type")]
    pub field_type: GuidedSettingFieldType,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub options: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validate: Option<GuidedSettingValidator>,
}

/// One editor category (`GuidedSettingCategory`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuidedSettingCategory {
    pub value: String,
    pub label: String,
    pub settings: Vec<GuidedSettingField>,
}

/// `Value is required` when the value is blank.
pub fn require_non_empty_setting_value(value: &str) -> Option<&'static str> {
    if value.trim().is_empty() {
        Some("Value is required")
    } else {
        None
    }
}

/// `^[0-9]+$`, then within `Number.MAX_SAFE_INTEGER`.
pub fn require_safe_non_negative_integer_setting_value(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return Some("Value must be a non-negative integer");
    }
    match trimmed.parse::<u128>() {
        Ok(number) if number <= 9_007_199_254_740_991 => None,
        Ok(_) => Some("Value must be a safe integer"),
        Err(_) => Some("Value must be a safe integer"),
    }
}

fn field(label: &str, path: &str, field_type: GuidedSettingFieldType) -> GuidedSettingField {
    GuidedSettingField {
        label: label.to_owned(),
        path: path.to_owned(),
        field_type,
        options: Vec::new(),
        placeholder: None,
        validate: None,
    }
}

fn validated(
    label: &str,
    path: &str,
    field_type: GuidedSettingFieldType,
    validator: GuidedSettingValidator,
) -> GuidedSettingField {
    GuidedSettingField {
        validate: Some(validator),
        ..field(label, path, field_type)
    }
}

fn text(label: &str, path: &str, placeholder: &str) -> GuidedSettingField {
    GuidedSettingField {
        placeholder: Some(placeholder.to_owned()),
        ..field(label, path, GuidedSettingFieldType::Text)
    }
}

fn validated_text(
    label: &str,
    path: &str,
    placeholder: &str,
    validator: GuidedSettingValidator,
) -> GuidedSettingField {
    GuidedSettingField {
        validate: Some(validator),
        ..text(label, path, placeholder)
    }
}

fn select(label: &str, path: &str, options: &[&str]) -> GuidedSettingField {
    GuidedSettingField {
        options: options.iter().map(|option| (*option).to_owned()).collect(),
        ..field(label, path, GuidedSettingFieldType::Select)
    }
}

fn string_array(label: &str, path: &str, placeholder: &str) -> GuidedSettingField {
    GuidedSettingField {
        placeholder: Some(placeholder.to_owned()),
        ..field(label, path, GuidedSettingFieldType::StringArray)
    }
}

fn category(value: &str, label: &str, settings: Vec<GuidedSettingField>) -> GuidedSettingCategory {
    GuidedSettingCategory {
        value: value.to_owned(),
        label: label.to_owned(),
        settings,
    }
}

fn build_categories() -> Vec<GuidedSettingCategory> {
    use GuidedSettingFieldType::{Boolean, Number};
    use GuidedSettingValidator::{NonEmpty, SafeNonNegativeInteger};

    vec![
        category(
            "relay-info",
            "Relay Info",
            vec![
                validated_text(
                    "Relay URL",
                    "info.relay_url",
                    "wss://relay.example.com",
                    NonEmpty,
                ),
                validated_text("Relay name", "info.name", "relay.example.com", NonEmpty),
                text(
                    "Description",
                    "info.description",
                    "A nostr relay written in Typescript.",
                ),
                text("Contact", "info.contact", "mailto:operator@your-domain.com"),
                text(
                    "Relay pubkey (hex)",
                    "info.pubkey",
                    "replace-with-your-pubkey-in-hex",
                ),
            ],
        ),
        category(
            "payments",
            "Payments",
            vec![
                field("Enable payments", "payments.enabled", Boolean),
                select(
                    "Payment processor",
                    "payments.processor",
                    &["zebedee", "lnbits", "lnurl", "nodeless", "opennode"],
                ),
                field(
                    "Admission fee enabled",
                    "payments.feeSchedules.admission[0].enabled",
                    Boolean,
                ),
                validated(
                    "Admission fee amount (msats)",
                    "payments.feeSchedules.admission[0].amount",
                    Number,
                    SafeNonNegativeInteger,
                ),
            ],
        ),
        category(
            "network",
            "Network",
            vec![
                validated(
                    "Max payload size",
                    "network.maxPayloadSize",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Frame memory budget (bytes, 0 means the default)",
                    "network.frameMemoryBudgetBytes",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Worker count",
                    "workers.count",
                    Number,
                    SafeNonNegativeInteger,
                ),
            ],
        ),
        category(
            "limits",
            "Limits",
            vec![
                select(
                    "Rate limiter strategy",
                    "limits.rateLimiter.strategy",
                    &["ewma", "sliding_window"],
                ),
                validated(
                    "Maximum event content length",
                    "limits.event.content[0].maxLength",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Minimum pubkey balance",
                    "limits.event.pubkey.minBalance",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Maximum future event time (seconds)",
                    "limits.event.createdAt.maxPositiveDelta",
                    Number,
                    SafeNonNegativeInteger,
                ),
                string_array(
                    "Pubkey blacklist",
                    "limits.event.pubkey.blacklist",
                    "One hex pubkey per line",
                ),
                string_array(
                    "Kind whitelist",
                    "limits.event.kind.whitelist",
                    "One kind or range per line, e.g. 1 or 10000-19999",
                ),
            ],
        ),
        category(
            "client",
            "Client",
            vec![
                validated(
                    "Max subscriptions per connection",
                    "limits.client.subscription.maxSubscriptions",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Max connections per IP (0 means the default)",
                    "limits.connection.maxConnectionsPerIp",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Max filters per subscription",
                    "limits.client.subscription.maxFilters",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Max filter values",
                    "limits.client.subscription.maxFilterValues",
                    Number,
                    SafeNonNegativeInteger,
                ),
                validated(
                    "Max REQ limit value",
                    "limits.client.subscription.maxLimit",
                    Number,
                    SafeNonNegativeInteger,
                ),
            ],
        ),
        category(
            "retention",
            "Retention",
            vec![field(
                "Event retention (days)",
                "limits.event.retention.maxDays",
                Number,
            )],
        ),
        category(
            "nip-features",
            "NIP Features",
            vec![
                select(
                    "NIP-05 mode",
                    "nip05.mode",
                    &["enabled", "passive", "disabled"],
                ),
                string_array(
                    "NIP-05 domain whitelist",
                    "nip05.domainWhitelist",
                    "One domain per line",
                ),
                string_array(
                    "NIP-05 domain blacklist",
                    "nip05.domainBlacklist",
                    "One domain per line",
                ),
                field("Enable NIP-45", "nip45.enabled", Boolean),
                field("Enable NIP-50", "nip50.enabled", Boolean),
                validated(
                    "NIP-50 max query length",
                    "nip50.maxQueryLength",
                    Number,
                    SafeNonNegativeInteger,
                ),
                field("Enable Web of Trust", "wot.enabled", Boolean),
                text(
                    "WoT seed pubkey (hex)",
                    "wot.seedPubkey",
                    "Relay owner pubkey in hex",
                ),
                validated(
                    "WoT minimum followers",
                    "wot.minimumFollowers",
                    Number,
                    SafeNonNegativeInteger,
                ),
                field("Enable NIP-56 content reporting", "nip56.enabled", Boolean),
                string_array(
                    "NIP-56 trusted moderator pubkeys (hex)",
                    "nip56.trustedModerators",
                    "One pubkey per line",
                ),
                field(
                    "Hide content matching actionable NIP-56 reports",
                    "nip56.hideActionableReports",
                    Boolean,
                ),
            ],
        ),
        category(
            "admin",
            "Admin",
            vec![
                field("Enable admin console", "admin.enabled", Boolean),
                validated(
                    "Session TTL (seconds)",
                    "admin.sessionTtlSeconds",
                    Number,
                    SafeNonNegativeInteger,
                ),
                field(
                    "Enable operator notifications",
                    "admin.notifications.enabled",
                    Boolean,
                ),
            ],
        ),
    ]
}

/// Every guided category, in the capture's order.
pub fn guided_setting_categories() -> &'static [GuidedSettingCategory] {
    static CATEGORIES: LazyLock<Vec<GuidedSettingCategory>> = LazyLock::new(build_categories);
    &CATEGORIES
}

/// Looks up a category by its `value`.
pub fn get_guided_setting_category(value: &str) -> Option<&'static GuidedSettingCategory> {
    guided_setting_categories()
        .iter()
        .find(|category| category.value == value)
}

/// Looks up one field of a category by its path.
pub fn get_guided_setting_field(
    category_value: &str,
    path: &str,
) -> Option<&'static GuidedSettingField> {
    get_guided_setting_category(category_value)?
        .settings
        .iter()
        .find(|field| field.path == path)
}
