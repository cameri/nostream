//! NIP-56: reporting. Mirrors `src/utils/nip56.ts`.
//!
//! A report event names what it objects to in `p` and `e` tags whose third element is the
//! report type. The first `p` tag and the first `e` tag of the same type collapse into one
//! target; two explicit, different types become two targets; every further tag is its own
//! single-field target. A report naming nothing valid still yields one empty target, so the
//! caller can tell "nothing to act on" from "no tags at all".
//!
//! The 64-hex check is case-insensitive here (`HEX64_PATTERN`, `src/utils/nip56.ts:16`),
//! unlike the lowercase-only checks in the relay's delete, gift-wrap, group and timestamp
//! arms; the persistence path hex-decodes the value, so both cases name the same bytes. ADR
//! 0006 records why the asymmetry is kept rather than normalised.

use crate::event::{EventId, Pubkey, Tag};

/// The report types NIP-56 defines (`ReportType`, `src/@types/report.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReportType {
    Nudity,
    Malware,
    Profanity,
    Illegal,
    Spam,
    Impersonation,
    Other,
}

impl ReportType {
    /// The spelling the `reports.report_type` column holds (`src/@types/report.ts`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Nudity => "nudity",
            Self::Malware => "malware",
            Self::Profanity => "profanity",
            Self::Illegal => "illegal",
            Self::Spam => "spam",
            Self::Impersonation => "impersonation",
            Self::Other => "other",
        }
    }

    /// One of the seven spellings (`isValidReportType`, `src/utils/nip56.ts:13-14`). Anything
    /// else is not a report type, and the caller reads it as [`ReportType::Other`].
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "nudity" => Some(Self::Nudity),
            "malware" => Some(Self::Malware),
            "profanity" => Some(Self::Profanity),
            "illegal" => Some(Self::Illegal),
            "spam" => Some(Self::Spam),
            "impersonation" => Some(Self::Impersonation),
            "other" => Some(Self::Other),
            _ => None,
        }
    }
}

/// One thing a report event objects to (`ReportTarget`, `src/utils/nip56.ts:25-29`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportTarget {
    pub reported_pubkey: Option<Pubkey>,
    pub reported_event_id: Option<EventId>,
    pub report_type: ReportType,
}

/// How many targets one event may produce (`MAX_TARGETS_PER_EVENT`,
/// `src/utils/nip56.ts:38`).
pub const MAX_TARGETS_PER_EVENT: usize = 100;

/// The targets of a report event (`extractReportTargets`, `src/utils/nip56.ts:49-102`).
pub fn extract_report_targets(tags: &[Tag]) -> Vec<ReportTarget> {
    let pubkeys = hex64_tags(tags, "p");
    let event_ids = hex64_tags(tags, "e");

    if pubkeys.is_empty() && event_ids.is_empty() {
        return vec![ReportTarget {
            reported_pubkey: None,
            reported_event_id: None,
            report_type: ReportType::Other,
        }];
    }

    let mut targets = Vec::new();

    if let (Some(pubkey), Some(event_id)) = (pubkeys.first(), event_ids.first()) {
        let pubkey_type = report_type_of(pubkey.0);
        let event_type = report_type_of(event_id.0);

        // Only a genuine disagreement — both sides carrying an explicit, different type —
        // splits into two targets; one side omitting a type is not a conflict.
        match (pubkey_type, event_type) {
            (Some(pubkey_type), Some(event_type)) if pubkey_type != event_type => {
                targets.push(ReportTarget {
                    reported_pubkey: None,
                    reported_event_id: Some(EventId::from_byte_array(event_id.1)),
                    report_type: event_type,
                });
                targets.push(ReportTarget {
                    reported_pubkey: Some(Pubkey::from_byte_array(pubkey.1)),
                    reported_event_id: None,
                    report_type: pubkey_type,
                });
            }
            _ => targets.push(ReportTarget {
                reported_pubkey: Some(Pubkey::from_byte_array(pubkey.1)),
                reported_event_id: Some(EventId::from_byte_array(event_id.1)),
                report_type: event_type.or(pubkey_type).unwrap_or(ReportType::Other),
            }),
        }
    } else if let Some(event_id) = event_ids.first() {
        targets.push(ReportTarget {
            reported_pubkey: None,
            reported_event_id: Some(EventId::from_byte_array(event_id.1)),
            report_type: target_type_of(event_id.0),
        });
    } else if let Some(pubkey) = pubkeys.first() {
        targets.push(ReportTarget {
            reported_pubkey: Some(Pubkey::from_byte_array(pubkey.1)),
            reported_event_id: None,
            report_type: target_type_of(pubkey.0),
        });
    }

    for (tag, bytes) in pubkeys.iter().skip(1) {
        targets.push(ReportTarget {
            reported_pubkey: Some(Pubkey::from_byte_array(*bytes)),
            reported_event_id: None,
            report_type: target_type_of(tag),
        });
    }

    for (tag, bytes) in event_ids.iter().skip(1) {
        targets.push(ReportTarget {
            reported_pubkey: None,
            reported_event_id: Some(EventId::from_byte_array(*bytes)),
            report_type: target_type_of(tag),
        });
    }

    targets.truncate(MAX_TARGETS_PER_EVENT);

    targets
}

/// Every `name`-tagged tag whose value is 64 hex characters, with the value's bytes.
fn hex64_tags<'a>(tags: &'a [Tag], name: &str) -> Vec<(&'a Tag, [u8; 32])> {
    tags.iter()
        .filter(|tag| tag.len() >= 2 && tag[0] == name)
        .filter_map(|tag| hex64(&tag[1]).map(|bytes| (tag, bytes)))
        .collect()
}

/// The tag's declared report type, when it names one (`isValidReportType`).
fn report_type_of(tag: &Tag) -> Option<ReportType> {
    tag.get(2).and_then(|value| ReportType::parse(value))
}

/// The tag's report type, with an absent or unknown one read as `Other` (`targetTypeOf`).
fn target_type_of(tag: &Tag) -> ReportType {
    report_type_of(tag).unwrap_or(ReportType::Other)
}

/// The 32 bytes of a 64-hex-character value, in either case (`HEX64_PATTERN`,
/// `src/utils/nip56.ts:16`).
fn hex64(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }

    let mut bytes = [0u8; 32];
    hex::decode_to_slice(value, &mut bytes).ok()?;

    Some(bytes)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    fn pubkey_hex() -> String {
        "3".repeat(64)
    }

    fn event_id_hex() -> String {
        "4".repeat(64)
    }

    fn tag(parts: &[&str]) -> Tag {
        parts.iter().map(|part| (*part).to_owned()).collect()
    }

    #[test]
    fn the_first_p_and_e_tags_collapse_into_one_target() {
        let pubkey = pubkey_hex();
        let event_id = event_id_hex();
        let targets =
            extract_report_targets(&[tag(&["p", &pubkey, "spam"]), tag(&["e", &event_id, "spam"])]);

        assert_eq!(
            targets,
            vec![ReportTarget {
                reported_pubkey: Some(pubkey.parse().unwrap()),
                reported_event_id: Some(event_id.parse().unwrap()),
                report_type: ReportType::Spam,
            }]
        );
    }

    #[test]
    fn a_type_disagreement_splits_into_two_targets() {
        let pubkey = pubkey_hex();
        let event_id = event_id_hex();
        let targets = extract_report_targets(&[
            tag(&["p", &pubkey, "impersonation"]),
            tag(&["e", &event_id, "nudity"]),
        ]);

        assert_eq!(
            targets,
            vec![
                ReportTarget {
                    reported_pubkey: None,
                    reported_event_id: Some(event_id.parse().unwrap()),
                    report_type: ReportType::Nudity,
                },
                ReportTarget {
                    reported_pubkey: Some(pubkey.parse().unwrap()),
                    reported_event_id: None,
                    report_type: ReportType::Impersonation,
                },
            ]
        );
    }

    #[test]
    fn a_type_given_on_one_side_only_is_used_for_both_fields() {
        let pubkey = pubkey_hex();
        let event_id = event_id_hex();
        let targets =
            extract_report_targets(&[tag(&["p", &pubkey]), tag(&["e", &event_id, "malware"])]);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].report_type, ReportType::Malware);
    }

    #[test]
    fn extra_tags_are_single_field_targets() {
        let pubkey = pubkey_hex();
        let event_id = event_id_hex();
        let other_pubkey = "5".repeat(64);
        let targets = extract_report_targets(&[
            tag(&["p", &pubkey, "spam"]),
            tag(&["p", &other_pubkey]),
            tag(&["e", &event_id, "spam"]),
        ]);

        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[1].reported_pubkey,
            Some(other_pubkey.parse().unwrap())
        );
        assert_eq!(targets[1].reported_event_id, None);
        assert_eq!(targets[1].report_type, ReportType::Other);
    }

    #[test]
    fn an_unknown_report_type_is_other() {
        let pubkey = pubkey_hex();
        let targets = extract_report_targets(&[tag(&["p", &pubkey, "vibes"])]);

        assert_eq!(targets[0].report_type, ReportType::Other);
    }

    #[test]
    fn uppercase_hex_names_the_same_target() {
        let pubkey = pubkey_hex();
        let targets = extract_report_targets(&[tag(&["p", &pubkey.to_uppercase()])]);

        assert_eq!(targets[0].reported_pubkey, Some(pubkey.parse().unwrap()));
    }

    #[test]
    fn a_malformed_or_short_tag_is_not_a_target() {
        let not_hex = "g".repeat(64);
        let targets = extract_report_targets(&[
            tag(&["p"]),
            tag(&["p", "not-a-pubkey"]),
            tag(&["e", &not_hex]),
        ]);

        assert_eq!(
            targets,
            vec![ReportTarget {
                reported_pubkey: None,
                reported_event_id: None,
                report_type: ReportType::Other,
            }]
        );
    }

    #[test]
    fn the_target_cap_drops_the_rest() {
        let tags: Vec<Tag> = (0..(MAX_TARGETS_PER_EVENT + 10))
            .map(|index| tag(&["p", &format!("{index:064x}")]))
            .collect();

        assert_eq!(extract_report_targets(&tags).len(), MAX_TARGETS_PER_EVENT);
    }
}
