//! Shared domain primitives. Mirrors `src/@types/event.ts`, `src/@types/base.ts`,
//! `src/@types/subscription.ts` and `src/constants/base.ts` at the capture commit.

use std::fmt;
use std::str::FromStr;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::constants::ALL_RELAYS;
use crate::error::CoreError;

/// One 32-byte or 64-byte value carried on the wire as lowercase hex.
///
/// The length and character checks are the capture's schema checks
/// (`src/schemas/base-schema.ts`: `idSchema`/`pubkeySchema` are 64 hex characters,
/// `signatureSchema` 128, all `^[0-9a-f]+$`), carried by the type so `validate_event`
/// does not have to repeat them.
macro_rules! hex_newtype {
    ($(#[$meta:meta])* $name:ident, $bytes:expr, $field:literal) => {
        $(#[$meta])*
        #[derive(Copy, Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name([u8; $bytes]);

        impl $name {
            /// The raw bytes.
            pub const fn as_bytes(&self) -> &[u8; $bytes] {
                &self.0
            }

            /// Wraps a byte array.
            pub const fn from_byte_array(bytes: [u8; $bytes]) -> Self {
                Self(bytes)
            }

            /// Parses the wire form: exact lowercase hex.
            fn parse(value: &str) -> Result<Self, CoreError> {
                const HEX_LEN: usize = $bytes * 2;

                if value.len() != HEX_LEN {
                    return Err(CoreError::InvalidEvent(format!(
                        "{}: expected {HEX_LEN} lowercase hex characters, got {}",
                        $field,
                        value.len()
                    )));
                }

                if !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                {
                    return Err(CoreError::InvalidEvent(format!(
                        "{}: must be lowercase hexadecimal",
                        $field
                    )));
                }

                let mut bytes = [0u8; $bytes];
                hex::decode_to_slice(value, &mut bytes).map_err(|error| {
                    CoreError::InvalidEvent(format!("{}: {error}", $field))
                })?;

                Ok(Self(bytes))
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                const HEX_LEN: usize = $bytes * 2;

                let mut buffer = [0u8; HEX_LEN];
                hex::encode_to_slice(self.0, &mut buffer).map_err(|_| fmt::Error)?;

                match std::str::from_utf8(&buffer) {
                    Ok(text) => formatter.write_str(text),
                    Err(_) => Err(fmt::Error),
                }
            }
        }

        impl FromStr for $name {
            type Err = CoreError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::parse(value)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = CoreError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                const HEX_LEN: usize = $bytes * 2;

                let mut buffer = [0u8; HEX_LEN];
                hex::encode_to_slice(self.0, &mut buffer).map_err(serde::ser::Error::custom)?;

                let text =
                    std::str::from_utf8(&buffer).map_err(serde::ser::Error::custom)?;

                serializer.serialize_str(text)
            }
        }

        // Borrowed `&'de str` in, fixed array out: no intermediate `String` or `Vec` on
        // the accepting path.
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct HexVisitor;

                impl Visitor<'_> for HexVisitor {
                    type Value = $name;

                    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                        const HEX_LEN: usize = $bytes * 2;
                        write!(formatter, "{HEX_LEN} lowercase hex characters")
                    }

                    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                        $name::parse(value).map_err(E::custom)
                    }
                }

                deserializer.deserialize_str(HexVisitor)
            }
        }
    };
}

hex_newtype!(
    /// A 32-byte event id, lowercase hex on the wire (`src/@types/base.ts` `EventId`).
    EventId,
    32,
    "id"
);

hex_newtype!(
    /// A 32-byte x-only public key, lowercase hex on the wire
    /// (`src/@types/base.ts` `Pubkey`).
    Pubkey,
    32,
    "pubkey"
);

hex_newtype!(
    /// A 64-byte BIP-340 Schnorr signature, 128 lowercase hex characters on the wire
    /// (`src/schemas/base-schema.ts` `signatureSchema`).
    Signature,
    64,
    "sig"
);

/// A public key as an operator writes it in settings (`wot.seedPubkey`,
/// `limits.event.pubkey.whitelist`, …).
///
/// The capture's settings validator never checks pubkey format
/// (`src/utils/settings-config.ts` has no `pubkey` rule), so this type carries no
/// validation: the default is `""` and a user document may hold `abc123`. `Pubkey`
/// stays the validated wire type. The two are deliberately distinct, because one
/// type cannot be both lenient and 32 bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SettingsPubkey(pub String);

impl fmt::Display for SettingsPubkey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for SettingsPubkey {
    type Err = std::convert::Infallible;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(Self(value.to_owned()))
    }
}

/// A Nostr event kind (`src/constants/base.ts` `EventKinds`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Kind(pub u64);

impl Kind {
    /// Kind 0, `EventKinds.SET_METADATA`.
    pub const METADATA: Self = Self(0);
    /// Kind 1, `EventKinds.TEXT_NOTE`.
    pub const TEXT_NOTE: Self = Self(1);
    /// Kind 3, `EventKinds.CONTACT_LIST`.
    pub const CONTACT_LIST: Self = Self(3);
    /// Kind 5, `EventKinds.DELETE`.
    pub const DELETE: Self = Self(5);
    /// Kind 13, `EventKinds.SEAL` (NIP-17).
    pub const SEAL: Self = Self(13);
    /// Kind 14, `EventKinds.DIRECT_MESSAGE` (NIP-17).
    pub const DIRECT_MESSAGE: Self = Self(14);
    /// Kind 15, `EventKinds.FILE_MESSAGE` (NIP-17).
    pub const FILE_MESSAGE: Self = Self(15);
    /// Kind 41, `EventKinds.CHANNEL_METADATA`.
    pub const CHANNEL_METADATA: Self = Self(41);
    /// Kind 62, `EventKinds.REQUEST_TO_VANISH` (NIP-62).
    pub const REQUEST_TO_VANISH: Self = Self(62);
    /// Kind 443, `EventKinds.MARMOT_KEY_PACKAGE_LEGACY`.
    pub const MARMOT_KEY_PACKAGE_LEGACY: Self = Self(443);
    /// Kind 444, `EventKinds.MARMOT_WELCOME_RUMOR`.
    pub const MARMOT_WELCOME_RUMOR: Self = Self(444);
    /// Kind 445, `EventKinds.MARMOT_GROUP_EVENT`.
    pub const MARMOT_GROUP_EVENT: Self = Self(445);
    /// Kind 1059, `EventKinds.GIFT_WRAP` (NIP-17).
    pub const GIFT_WRAP: Self = Self(1059);
    /// Kind 1984, `EventKinds.REPORT` (NIP-56).
    pub const REPORT: Self = Self(1984);
    /// First DVM job request kind, `EventKinds.DVM_JOB_REQUEST_FIRST` (NIP-90).
    pub const DVM_JOB_REQUEST_START: Self = Self(5_000);
    /// Last DVM job request kind, `EventKinds.DVM_JOB_REQUEST_LAST` (NIP-90).
    pub const DVM_JOB_REQUEST_END: Self = Self(5_999);
    /// First replaceable kind, `EventKinds.REPLACEABLE_FIRST` (NIP-16).
    pub const REPLACEABLE_START: Self = Self(10_000);
    /// Last replaceable kind, `EventKinds.REPLACEABLE_LAST` (NIP-16).
    pub const REPLACEABLE_END: Self = Self(19_999);
    /// First ephemeral kind, `EventKinds.EPHEMERAL_FIRST` (NIP-16).
    pub const EPHEMERAL_START: Self = Self(20_000);
    /// Last ephemeral kind, `EventKinds.EPHEMERAL_LAST` (NIP-16).
    pub const EPHEMERAL_END: Self = Self(29_999);
    /// First parameterized replaceable kind,
    /// `EventKinds.PARAMETERIZED_REPLACEABLE_FIRST` (NIP-33).
    pub const PARAMETERIZED_REPLACEABLE_START: Self = Self(30_000);
    /// Last parameterized replaceable kind,
    /// `EventKinds.PARAMETERIZED_REPLACEABLE_LAST` (NIP-33).
    pub const PARAMETERIZED_REPLACEABLE_END: Self = Self(39_999);

    /// Whether the event replaces the previous event of its key (`isReplaceableEvent`,
    /// `src/utils/event.ts:203-210`): kinds 0, 3, 41, 10000..=19999.
    pub fn is_replaceable(self) -> bool {
        matches!(
            self,
            Self::METADATA | Self::CONTACT_LIST | Self::CHANNEL_METADATA
        ) || (self >= Self::REPLACEABLE_START && self <= Self::REPLACEABLE_END)
    }

    /// Whether the event is relayed but never stored (`isEphemeralEvent`,
    /// `src/utils/event.ts:212-214`).
    pub fn is_ephemeral(self) -> bool {
        self >= Self::EPHEMERAL_START && self <= Self::EPHEMERAL_END
    }

    /// Whether the event is addressable by its `d` tag
    /// (`isParameterizedReplaceableEvent`, `src/utils/event.ts:220-224`).
    pub fn is_parameterized_replaceable(self) -> bool {
        self >= Self::PARAMETERIZED_REPLACEABLE_START && self <= Self::PARAMETERIZED_REPLACEABLE_END
    }

    /// Whether the event is a NIP-90 job request (`isDvmJobRequestEvent`,
    /// `src/utils/event.ts:216-218`).
    pub fn is_dvm_job_request(self) -> bool {
        self >= Self::DVM_JOB_REQUEST_START && self <= Self::DVM_JOB_REQUEST_END
    }

    /// Whether the event is a NIP-02 contact list (`isContactListEvent`,
    /// `src/utils/event.ts:199-201`).
    pub fn is_contact_list(self) -> bool {
        self == Self::CONTACT_LIST
    }

    /// Whether the event is a NIP-09 deletion request (`isDeleteEvent`,
    /// `src/utils/event.ts:226-228`).
    pub fn is_delete(self) -> bool {
        self == Self::DELETE
    }

    /// Whether the event is a NIP-17 gift wrap (`isGiftWrapEvent`,
    /// `src/utils/event.ts:288-290`).
    pub fn is_gift_wrap(self) -> bool {
        self == Self::GIFT_WRAP
    }

    /// Whether the event is a NIP-17 seal (`isSealEvent`, `src/utils/event.ts:292-294`).
    pub fn is_seal(self) -> bool {
        self == Self::SEAL
    }

    /// Whether the event is a NIP-17 direct message (`isDirectMessageEvent`,
    /// `src/utils/event.ts:296-298`).
    pub fn is_direct_message(self) -> bool {
        self == Self::DIRECT_MESSAGE
    }

    /// Whether the event is a NIP-17 file message (`isFileMessageEvent`,
    /// `src/utils/event.ts:300-302`).
    pub fn is_file_message(self) -> bool {
        self == Self::FILE_MESSAGE
    }

    /// Whether the event is a Marmot welcome rumor (`isWelcomeRumorEvent`,
    /// `src/utils/event.ts:311-313`).
    pub fn is_welcome_rumor(self) -> bool {
        self == Self::MARMOT_WELCOME_RUMOR
    }

    /// Whether the event is a Marmot group event (`isMarmotGroupEvent`,
    /// `src/utils/event.ts:315-317`).
    pub fn is_marmot_group_event(self) -> bool {
        self == Self::MARMOT_GROUP_EVENT
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// One kind or an inclusive `[first, last]` range (`src/@types/settings.ts` `EventKindsRange`).
///
/// Two callers: settings criteria (`isEventKindOrRangeMatch`, `src/utils/event.ts:34-37`)
/// and the storage retention whitelist (`EventRetentionOptions::kind_whitelist`, the capture's
/// `(EventKinds | EventKindsRange)[]`). A subscription filter's `kinds` holds numbers only, so
/// a range element never matches there and is unrepresentable in `Filter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KindSelector {
    Range([Kind; 2]),
    Single(Kind),
}

/// A tag: the wire shape is a positional string array.
pub type Tag = Vec<String>;

/// A Nostr event (`src/@types/event.ts`).
///
/// Unknown fields are rejected, matching `eventSchema.strict()`
/// (`src/schemas/event-schema.ts:41`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: EventId,
    pub pubkey: Pubkey,
    pub created_at: i64,
    pub kind: Kind,
    pub tags: Vec<Tag>,
    pub content: String,
    pub sig: Signature,
}

impl Event {
    /// Whether the event asks this relay to delete the requester's data
    /// (`isRequestToVanishEvent`, `src/utils/event.ts:230-242`).
    ///
    /// With no relay URL, any kind-62 event qualifies. With one, the event must name at
    /// least one `r` tag and every one of them must be this relay or [`ALL_RELAYS`].
    pub fn is_request_to_vanish(&self, relay_url: Option<&str>) -> bool {
        if self.kind != Kind::REQUEST_TO_VANISH {
            return false;
        }

        let Some(relay_url) = relay_url else {
            return true;
        };

        let relays: Vec<&str> = self
            .tags
            .iter()
            .filter(|tag| tag.len() >= 2 && tag[0] == "r")
            .map(|tag| tag[1].as_str())
            .collect();

        !relays.is_empty()
            && relays
                .iter()
                .all(|relay| *relay == relay_url || *relay == ALL_RELAYS)
    }

    /// Whether the event carries the NIP-70 `["-"]` tag (`isProtectedEvent`,
    /// `src/utils/event.ts:321-323`). The tag name is what counts, at any arity.
    pub fn is_protected(&self) -> bool {
        self.tags
            .iter()
            .any(|tag| tag.first().is_some_and(|name| name == "-"))
    }
}

/// The six-element array the event id is hashed over (`serializeEvent`,
/// `src/utils/event.ts:15-22`, `src/@types/event.ts` `CanonicalEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CanonicalEvent<'a>(
    pub u8,
    pub String,
    pub i64,
    pub u64,
    pub &'a [Tag],
    pub &'a str,
);

/// Builds the canonical array for an event: `[0, pubkey, created_at, kind, tags, content]`.
pub fn serialize_event(event: &Event) -> CanonicalEvent<'_> {
    CanonicalEvent(
        0,
        event.pubkey.to_string(),
        event.created_at,
        event.kind.0,
        &event.tags,
        &event.content,
    )
}

/// The exact bytes `JSON.stringify(serializeEvent(event))` would produce, which the id
/// is the SHA-256 of (`getEventHash`, `src/utils/event.ts:121-125`).
pub fn canonical_json(event: &Event) -> Result<String, CoreError> {
    serde_json::to_string(&serialize_event(event))
        .map_err(|error| CoreError::InvalidEvent(format!("canonical serialization: {error}")))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const ID: &str = "b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef";
    const PUBKEY: &str = "22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793";
    const SIG: &str = "ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848";

    fn event() -> Event {
        Event {
            id: ID.parse().unwrap(),
            pubkey: PUBKEY.parse().unwrap(),
            created_at: 1_648_339_664,
            kind: Kind::TEXT_NOTE,
            tags: Vec::new(),
            content: "learning terraform rn!".to_owned(),
            sig: SIG.parse().unwrap(),
        }
    }

    fn parse_id(value: &str) -> Result<EventId, CoreError> {
        EventId::try_from(value)
    }

    #[test]
    fn id_round_trips_through_hex() {
        let id: EventId = ID.parse().unwrap();

        assert_eq!(id.to_string(), ID);
        assert_eq!(id.as_bytes().len(), 32);
        assert_eq!(id, EventId::from_byte_array(*id.as_bytes()));
        assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{ID}\""));
    }

    #[test]
    fn id_rejects_uppercase_hex() {
        let error = parse_id(&ID.to_uppercase()).unwrap_err();

        assert!(error.to_string().contains("lowercase"), "{error}");
    }

    #[test]
    fn id_rejects_63_and_65_character_values() {
        assert!(parse_id(&ID[..63]).is_err());
        assert!(parse_id(&format!("{ID}0")).is_err());
        assert!(parse_id(&ID[..64 - 1]).is_err());
    }

    #[test]
    fn id_rejects_a_non_hex_character() {
        let mutated = format!("{}z", &ID[..63]);

        assert!(parse_id(&mutated).is_err());
    }

    #[test]
    fn signature_rejects_127_and_129_character_values() {
        assert!(parse_id(&SIG[..127]).is_err());
        assert!(Signature::try_from(format!("{SIG}0").as_str()).is_err());
        assert!(Signature::try_from(&SIG[..127]).is_err());
    }

    #[test]
    fn hex_newtypes_reject_a_json_number() {
        let document = "{\"id\": 12, \"pubkey\": 13, \"sig\": 14}".to_owned();

        #[derive(Debug, Deserialize)]
        #[allow(dead_code)]
        struct Holder {
            id: EventId,
            pubkey: Pubkey,
            sig: Signature,
        }

        let error = serde_json::from_str::<Holder>(&document).unwrap_err();

        assert!(error.to_string().contains("invalid type"), "{error}");
    }

    #[test]
    fn ids_are_serialised_from_a_borrowed_str_buffer() {
        let document = format!("{{\"id\":\"{ID}\"}}");
        let parsed: EventId = serde_json::from_str::<serde_json::Value>(&document)
            .map(|value| serde_json::from_value(value["id"].clone()).unwrap())
            .unwrap();

        assert_eq!(parsed.to_string(), ID);
    }

    #[test]
    fn event_rejects_an_unknown_field() {
        let document = format!(
            "{{\"id\":\"{ID}\",\"pubkey\":\"{PUBKEY}\",\"created_at\":1,\"kind\":1,\"tags\":[],\"content\":\"\",\"sig\":\"{SIG}\",\"extra\":true}}"
        );

        let error = serde_json::from_str::<Event>(&document).unwrap_err();

        assert!(error.to_string().contains("unknown field"), "{error}");
    }

    #[test]
    fn event_round_trips_its_seven_fields_in_order() {
        let document = serde_json::to_string(&event()).unwrap();
        let rebuilt: Event = serde_json::from_str(&document).unwrap();

        assert_eq!(rebuilt, event());
        assert!(document.starts_with(&format!(
            "{{\"id\":\"{ID}\",\"pubkey\":\"{PUBKEY}\",\"created_at\""
        )));
    }

    #[test]
    fn canonical_json_matches_json_stringify_bytes() {
        let mut event = event();
        event.pubkey = PUBKEY.parse().unwrap();
        event.created_at = 1000;
        event.kind = Kind::TEXT_NOTE;
        event.tags = vec![vec!["e".to_owned(), "AA".to_owned()]];
        event.content = "a\u{1}b\u{1f}c\"d\\e\u{7f}f\u{2028}g😀h\n\t".to_owned();

        assert_eq!(
            canonical_json(&event).unwrap(),
            "[0,\"22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793\",1000,1,[[\"e\",\"AA\"]],\"a\\u0001b\\u001fc\\\"d\\\\e\u{7f}f\u{2028}g😀h\\n\\t\"]"
        );
    }

    #[test]
    fn canonical_json_emits_the_six_element_array() {
        let mut event = event();
        event.tags = vec![vec!["tag name".to_owned(), "tag content".to_owned()]];

        assert_eq!(
            canonical_json(&event).unwrap(),
            "[0,\"22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793\",1648339664,1,[[\"tag name\",\"tag content\"]],\"learning terraform rn!\"]"
        );
    }

    #[test]
    fn kind_constants_match_the_capture_enum() {
        assert_eq!(Kind::METADATA.0, 0);
        assert_eq!(Kind::TEXT_NOTE.0, 1);
        assert_eq!(Kind::CONTACT_LIST.0, 3);
        assert_eq!(Kind::DELETE.0, 5);
        assert_eq!(Kind::SEAL.0, 13);
        assert_eq!(Kind::DIRECT_MESSAGE.0, 14);
        assert_eq!(Kind::FILE_MESSAGE.0, 15);
        assert_eq!(Kind::CHANNEL_METADATA.0, 41);
        assert_eq!(Kind::REQUEST_TO_VANISH.0, 62);
        assert_eq!(Kind::MARMOT_KEY_PACKAGE_LEGACY.0, 443);
        assert_eq!(Kind::MARMOT_WELCOME_RUMOR.0, 444);
        assert_eq!(Kind::MARMOT_GROUP_EVENT.0, 445);
        assert_eq!(Kind::GIFT_WRAP.0, 1059);
        assert_eq!(Kind::REPORT.0, 1984);
        assert_eq!(Kind::DVM_JOB_REQUEST_START.0, 5000);
        assert_eq!(Kind::DVM_JOB_REQUEST_END.0, 5999);
        assert_eq!(Kind::REPLACEABLE_START.0, 10_000);
        assert_eq!(Kind::REPLACEABLE_END.0, 19_999);
        assert_eq!(Kind::EPHEMERAL_START.0, 20_000);
        assert_eq!(Kind::EPHEMERAL_END.0, 29_999);
        assert_eq!(Kind::PARAMETERIZED_REPLACEABLE_START.0, 30_000);
        assert_eq!(Kind::PARAMETERIZED_REPLACEABLE_END.0, 39_999);
    }

    #[test]
    fn kind_range_predicates_stop_at_the_boundaries() {
        assert!(Kind::REPLACEABLE_START.is_replaceable());
        assert!(Kind::REPLACEABLE_END.is_replaceable());
        assert!(!Kind(9_999).is_replaceable());
        assert!(!Kind(20_000).is_replaceable());

        assert!(Kind(20_000).is_ephemeral());
        assert!(Kind(29_999).is_ephemeral());
        assert!(!Kind(30_000).is_ephemeral());

        assert!(Kind(30_000).is_parameterized_replaceable());
        assert!(Kind(39_999).is_parameterized_replaceable());
        assert!(!Kind(40_000).is_parameterized_replaceable());

        assert!(Kind(5_000).is_dvm_job_request());
        assert!(Kind(5_999).is_dvm_job_request());
        assert!(!Kind(4_999).is_dvm_job_request());
        assert!(!Kind(6_000).is_dvm_job_request());
    }

    #[test]
    fn settings_pubkey_keeps_operator_text() {
        let parsed: SettingsPubkey = "abc123".parse().unwrap();

        assert_eq!(parsed.to_string(), "abc123");
        assert_eq!(serde_json::to_string(&parsed).unwrap(), "\"abc123\"");
        assert_eq!(SettingsPubkey::default().0, "");
    }
}
