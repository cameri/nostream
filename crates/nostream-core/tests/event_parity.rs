//! Parity with `test/unit/utils/event.spec.ts` (105 mocha cases, measured green at the
//! capture commit `242a3001`).
//!
//! | mocha case | Rust test |
//! |---|---|
//! | `NIP-01 > serializeEvent > returns serialized event given a Nostr event` | `serialize_event_...` |
//! | `NIP-01 > isEventMatchingFilter > …` (26) | `is_event_matching_filter_...` |
//! | `NIP-01 > NIP-50: search filter > …` (9) | `search_...` |
//! | `NIP-01 > isEventSignatureValid > …` (2) | `is_event_signature_valid_...` |
//! | `NIP-01 > isEventIdValid > …` (2) | `is_event_id_valid_...` |
//! | `NIP-12 > #d/#r/#g filter` (7) | `nip12_...` |
//! | `NIP-02 > isContactListEvent` (2) | `is_contact_list_event_...` |
//! | `NIP-16 > isReplaceableEvent/isEphemeralEvent/isDvmJobRequestEvent` (10) | `nip16_...` |
//! | `NIP-17 > …` (9) | `nip17_...` |
//! | `Marmot Protocol > …` (8) | `marmot_...` |
//! | `NIP-09 > isDeleteEvent` (2) | `is_delete_event_...` |
//! | `NIP-62 > isRequestToVanishEvent` (7) | `is_request_to_vanish_event_...` |
//! | `NIP-33 > isParameterizedReplaceableEvent` (2) | `nip33_...` |
//! | `NIP-40 > getEventExpiration/isExpiredEvent` (12) | `nip40_...` |
//! | `NIP-70 > isProtectedEvent` (6) | `nip70_...` |
//!
//! Two re-expression notes from the spec: `event.spec.ts:29-48` builds its input with
//! `pubkey: 'pubkey'`, which the typed `Event` cannot hold, so that case uses a real 64-hex
//! pubkey and asserts the same six-element shape; and `isExpiredEvent` reads the wall clock
//! in the capture, while [`nostream_core::expiration::is_expired_event`] takes `now`, so
//! each case supplies a fixed instant that decides the same way.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::Kind;
use nostream_core::crypto::{compute_event_id, verify_event_signature};
use nostream_core::event::{Event, EventId, Pubkey, Signature, canonical_json};
use nostream_core::filter::Filter;
use serde_json::json;

const ID: &str = "6b3cdd0302ded8068ad3f0269c74423ca4fee460f800f3d90103b63f14400407";
const PUBKEY: &str = "22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793";
const SIG: &str = "b37adfed0e6398546d623536f9ddc92b95b7dc71927e1123266332659253ecd0ffa91ddf2c0a82a8426c5b363139d28534d6cac893b8a810149557a3f6d36768";
const KNOWN_ID: &str = "b1601d26958e6508b7b9df0af609c652346c09392b6534d93aead9819a51b4ef";
const KNOWN_SIG: &str = "ec8b2bc640c8c7e92fbc0e0a6f539da2635068a99809186f15106174d727456132977c78f3371d0ab01c108173df75750f33d8e04c4d7980bbb3fb70ba1e3848";

/// The `NIP-01 > isEventMatchingFilter` fixture (`event.spec.ts:51-67`).
fn fixture_event() -> Event {
    Event {
        id: ID.parse().unwrap(),
        pubkey: PUBKEY.parse().unwrap(),
        created_at: 1_648_351_380,
        kind: Kind::TEXT_NOTE,
        tags: vec![
            vec![
                "p".to_owned(),
                "8355095016fddbe31fcf1453b26f613553e9758cf2263e190eac8fd96a3d3de9".to_owned(),
                "wss://nostr-pub.wellorder.net".to_owned(),
            ],
            vec![
                "e".to_owned(),
                "7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96".to_owned(),
                "wss://nostr-relay.untethr.me".to_owned(),
            ],
        ],
        content: "I've set up mirroring between relays: https://i.imgur.com/HxCDipB.png".to_owned(),
        sig: SIG.parse().unwrap(),
    }
}

/// An event carrying only what a kind predicate reads.
fn event_of_kind(kind: u64) -> Event {
    Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at: 0,
        kind: Kind(kind),
        tags: Vec::new(),
        content: String::new(),
        sig: Signature::from_byte_array([0; 64]),
    }
}

fn event_with_tags(tags: Vec<Vec<&str>>) -> Event {
    Event {
        tags: tags
            .into_iter()
            .map(|tag| tag.into_iter().map(str::to_owned).collect())
            .collect(),
        ..event_of_kind(1)
    }
}

fn matches(filter: serde_json::Value, event: &Event) -> bool {
    serde_json::from_value::<Filter>(filter)
        .unwrap()
        .matches(event)
}

// --- NIP-01 > serializeEvent (1) ---------------------------------------------------------

#[test]
fn serialize_event_returns_serialized_event_given_a_nostr_event() {
    let mut event = event_of_kind(1);
    event.pubkey = PUBKEY.parse().unwrap();
    event.created_at = 1000;
    event.tags = vec![vec!["tag name".to_owned(), "tag content".to_owned()]];
    event.content = "content".to_owned();

    assert_eq!(
        canonical_json(&event).unwrap(),
        format!("[0,\"{PUBKEY}\",1000,1,[[\"tag name\",\"tag content\"]],\"content\"]")
    );
}

// --- NIP-01 > isEventMatchingFilter (26) -------------------------------------------------

#[test]
fn is_event_matching_filter_returns_true_if_filter_is_empty() {
    assert!(matches(json!({}), &fixture_event()));
}

#[test]
fn ids_returns_false_if_ids_filter_is_empty() {
    assert!(!matches(json!({"ids": []}), &fixture_event()));
}

#[test]
fn ids_returns_true_if_ids_filter_contains_event_id() {
    assert!(matches(json!({"ids": [ID]}), &fixture_event()));
}

#[test]
fn ids_returns_false_if_ids_filter_does_not_contains_event_id() {
    assert!(!matches(
        json!({"ids": ["something else"]}),
        &fixture_event()
    ));
}

#[test]
fn ids_returns_true_if_ids_with_prefix_matches_event() {
    let mut event = event_of_kind(1);
    event.id = "7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96"
        .parse()
        .unwrap();

    assert!(matches(json!({"ids": ["7377fa81fc6c"]}), &event));
}

#[test]
fn ids_returns_false_if_ids_with_prefix_does_not_matches_event() {
    let mut event = event_of_kind(1);
    event.id = "7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96"
        .parse()
        .unwrap();

    assert!(!matches(json!({"ids": ["001122"]}), &event));
}

#[test]
fn authors_returns_false_if_authors_filter_is_empty() {
    assert!(!matches(json!({"authors": []}), &fixture_event()));
}

#[test]
fn authors_returns_true_if_authors_filter_contains_event_id() {
    assert!(matches(json!({"authors": [PUBKEY]}), &fixture_event()));
}

#[test]
fn authors_returns_false_if_authors_filter_does_not_contains_event_id() {
    assert!(!matches(
        json!({"authors": ["something else"]}),
        &fixture_event()
    ));
}

#[test]
fn authors_returns_true_if_authors_with_prefix_matches_event() {
    assert!(matches(json!({"authors": ["22e804d"]}), &fixture_event()));
}

#[test]
fn authors_returns_false_if_authors_with_prefix_does_not_matches_event() {
    assert!(!matches(json!({"authors": ["001122"]}), &fixture_event()));
}

#[test]
fn kinds_returns_false_if_kinds_filter_is_empty() {
    assert!(!matches(json!({"kinds": []}), &fixture_event()));
}

#[test]
fn kinds_returns_true_if_kinds_filter_contains_event_id() {
    assert!(matches(json!({"kinds": [1]}), &fixture_event()));
}

#[test]
fn kinds_returns_false_if_kinds_filter_does_not_contains_event_id() {
    assert!(!matches(json!({"kinds": [666]}), &fixture_event()));
}

#[test]
fn since_returns_true_if_since_lt_event_created_at() {
    assert!(matches(json!({"since": 1_648_351_379}), &fixture_event()));
}

#[test]
fn since_returns_true_if_since_eq_event_created_at() {
    assert!(matches(json!({"since": 1_648_351_380}), &fixture_event()));
}

#[test]
fn since_returns_false_if_since_gt_event_created_at() {
    assert!(!matches(json!({"since": 1_648_351_381}), &fixture_event()));
}

#[test]
fn until_returns_false_if_until_lt_event_created_at() {
    assert!(!matches(json!({"until": 1_648_351_379}), &fixture_event()));
}

#[test]
fn until_returns_true_if_until_eq_event_created_at() {
    assert!(matches(json!({"until": 1_648_351_380}), &fixture_event()));
}

#[test]
fn until_returns_true_if_until_gt_event_created_at() {
    assert!(matches(json!({"until": 1_648_351_381}), &fixture_event()));
}

#[test]
fn e_filter_returns_false_if_e_filter_is_empty() {
    assert!(!matches(json!({"#e": []}), &fixture_event()));
}

#[test]
fn e_filter_returns_true_if_e_filter_contains_e_tag_in_event() {
    assert!(matches(
        json!({"#e": ["7377fa81fc6c7ae7f7f4ef8938d4a603f7bf98183b35ab128235cc92d4bebf96"]}),
        &fixture_event()
    ));
}

#[test]
fn e_filter_returns_false_if_e_filter_does_not_contain_tag_in_event() {
    assert!(!matches(
        json!({"#e": ["something else"]}),
        &fixture_event()
    ));
}

#[test]
fn p_filter_returns_false_if_p_filter_is_empty() {
    assert!(!matches(json!({"#p": []}), &fixture_event()));
}

#[test]
fn p_filter_returns_true_if_p_filter_contains_p_tag_in_event() {
    assert!(matches(
        json!({"#p": ["8355095016fddbe31fcf1453b26f613553e9758cf2263e190eac8fd96a3d3de9"]}),
        &fixture_event()
    ));
}

#[test]
fn p_filter_returns_false_if_p_filter_does_not_contain_tag_in_event() {
    assert!(!matches(
        json!({"#p": ["something else"]}),
        &fixture_event()
    ));
}

// --- NIP-01 > NIP-50: search filter (9) --------------------------------------------------

fn search_event() -> Event {
    Event {
        content: "Bitcoin and Lightning Network are revolutionizing payments".to_owned(),
        ..fixture_event()
    }
}

#[test]
fn search_returns_true_if_search_matches_single_term_in_content() {
    assert!(matches(json!({"search": "bitcoin"}), &search_event()));
}

#[test]
fn search_returns_true_if_search_matches_multiple_terms_in_content() {
    assert!(matches(
        json!({"search": "bitcoin lightning"}),
        &search_event()
    ));
}

#[test]
fn search_returns_false_if_search_term_is_not_in_content() {
    assert!(!matches(json!({"search": "ethereum"}), &search_event()));
}

#[test]
fn search_returns_false_if_one_of_multiple_search_terms_is_missing() {
    assert!(!matches(
        json!({"search": "bitcoin ethereum"}),
        &search_event()
    ));
}

#[test]
fn search_is_case_insensitive() {
    assert!(matches(json!({"search": "BITCOIN"}), &search_event()));
}

#[test]
fn search_returns_true_if_search_is_undefined() {
    assert!(matches(json!({}), &search_event()));
}

#[test]
fn search_returns_true_if_search_is_an_empty_string() {
    assert!(matches(json!({"search": ""}), &search_event()));
}

#[test]
fn search_returns_false_if_search_is_whitespace_only() {
    assert!(!matches(json!({"search": "   "}), &search_event()));
}

#[test]
fn search_combines_with_other_filters() {
    assert!(matches(
        json!({"search": "bitcoin", "kinds": [1]}),
        &search_event()
    ));
    assert!(!matches(
        json!({"search": "bitcoin", "kinds": [2]}),
        &search_event()
    ));
}

// --- NIP-01 > isEventSignatureValid (2) --------------------------------------------------

fn known_vector_event() -> Event {
    Event {
        id: KNOWN_ID.parse().unwrap(),
        pubkey: PUBKEY.parse().unwrap(),
        created_at: 1_648_339_664,
        kind: Kind::TEXT_NOTE,
        tags: Vec::new(),
        content: "learning terraform rn!".to_owned(),
        sig: KNOWN_SIG.parse().unwrap(),
    }
}

#[test]
fn is_event_signature_valid_resolves_with_true_if_event_has_a_valid_signature() {
    assert!(verify_event_signature(&known_vector_event()).is_ok());
}

#[test]
fn is_event_signature_valid_resolves_with_false_if_event_has_a_valid_signature() {
    let mut event = known_vector_event();
    event.id = "1234567890123456789012345678901234567890123456789012345678901234"
        .parse()
        .unwrap();

    assert!(verify_event_signature(&event).is_err());
}

// --- NIP-01 > isEventIdValid (2) ---------------------------------------------------------

#[test]
fn is_event_id_valid_resolves_with_true_if_event_id_is_valid() {
    assert_eq!(
        compute_event_id(&known_vector_event()).unwrap().to_string(),
        KNOWN_ID
    );
}

#[test]
fn is_event_id_valid_resolves_with_false_if_event_id_is_not_valid() {
    let mut event = known_vector_event();
    event.content = "changed".to_owned();

    assert_ne!(compute_event_id(&event).unwrap().to_string(), KNOWN_ID);
}

// --- NIP-12 (#d, #r, #g) (7) -------------------------------------------------------------

fn nip12_event(tag: [&str; 2], kind: u64) -> Event {
    Event {
        tags: vec![tag.iter().map(|value| value.to_string()).collect()],
        ..event_of_kind(kind)
    }
}

#[test]
fn nip12_d_filter_returns_true_if_d_filter_contains_an_empty_tag_value_in_the_event() {
    let event = nip12_event(["d", ""], Kind::PARAMETERIZED_REPLACEABLE_START.0);

    assert!(matches(json!({"#d": [""]}), &event));
}

#[test]
fn nip12_r_filter_returns_false_if_r_filter_is_empty() {
    let event = nip12_event(["r", "https://fiatjaf.com"], 1);

    assert!(!matches(json!({"#r": []}), &event));
}

#[test]
fn nip12_r_filter_returns_true_if_r_filter_contains_p_tag_in_event() {
    let event = nip12_event(["r", "https://fiatjaf.com"], 1);

    assert!(matches(json!({"#r": ["https://fiatjaf.com"]}), &event));
}

#[test]
fn nip12_r_filter_returns_false_if_r_filter_does_not_contain_tag_in_event() {
    let event = nip12_event(["r", "https://fiatjaf.com"], 1);

    assert!(!matches(json!({"#r": ["something else"]}), &event));
}

#[test]
fn nip12_g_filter_returns_true_if_g_filter_contains_a_matching_geohash_prefix_wildcard() {
    let event = nip12_event(["g", "u4pruydqqvj"], 1);

    assert!(matches(json!({"#g": ["u4pruyd*"]}), &event));
}

#[test]
fn nip12_g_filter_returns_false_if_g_filter_contains_a_non_matching_geohash_prefix_wildcard() {
    let event = nip12_event(["g", "u4pruydqqvj"], 1);

    assert!(!matches(json!({"#g": ["u4pruz*"]}), &event));
}

#[test]
fn nip12_g_filter_keeps_g_filter_exact_when_criterion_has_no_wildcard() {
    let event = nip12_event(["g", "u4pruydqqvj"], 1);

    assert!(!matches(json!({"#g": ["u4pruyd"]}), &event));
    assert!(matches(json!({"#g": ["u4pruydqqvj"]}), &event));
}

// --- NIP-02 > isContactListEvent (2) -----------------------------------------------------

#[test]
fn is_contact_list_event_returns_true_if_event_is_a_contact_list() {
    assert!(event_of_kind(Kind::CONTACT_LIST.0).kind.is_contact_list());
}

#[test]
fn is_contact_list_event_returns_false_if_event_is_not_a_contact_list() {
    assert!(!event_of_kind(Kind::METADATA.0).kind.is_contact_list());
}

// --- NIP-16 (10) -------------------------------------------------------------------------

#[test]
fn is_replaceable_event_returns_true_if_event_is_replaceable() {
    assert!(
        event_of_kind(Kind::REPLACEABLE_START.0)
            .kind
            .is_replaceable()
    );
}

#[test]
fn is_replaceable_event_returns_true_if_event_is_set_metadata() {
    assert!(event_of_kind(Kind::METADATA.0).kind.is_replaceable());
}

#[test]
fn is_replaceable_event_returns_true_if_event_is_contact_list() {
    assert!(event_of_kind(Kind::CONTACT_LIST.0).kind.is_replaceable());
}

#[test]
fn is_replaceable_event_returns_false_if_event_is_not_replaceable() {
    assert!(
        !event_of_kind(Kind::REPLACEABLE_END.0 + 1)
            .kind
            .is_replaceable()
    );
}

#[test]
fn is_ephemeral_event_returns_true_if_event_is_replaceable() {
    assert!(event_of_kind(20_000).kind.is_ephemeral());
}

#[test]
fn is_ephemeral_event_returns_false_if_event_is_not_replaceable() {
    assert!(!event_of_kind(30_000).kind.is_ephemeral());
}

#[test]
fn is_dvm_job_request_event_returns_true_for_the_first_kind_in_the_dvm_job_request_range_5000() {
    assert!(event_of_kind(5_000).kind.is_dvm_job_request());
}

#[test]
fn is_dvm_job_request_event_returns_true_for_the_last_kind_in_the_dvm_job_request_range_5999() {
    assert!(event_of_kind(5_999).kind.is_dvm_job_request());
}

#[test]
fn is_dvm_job_request_event_returns_false_for_a_kind_below_the_dvm_job_request_range() {
    assert!(!event_of_kind(4_999).kind.is_dvm_job_request());
}

#[test]
fn is_dvm_job_request_event_returns_false_for_a_kind_above_the_dvm_job_request_range() {
    assert!(!event_of_kind(6_000).kind.is_dvm_job_request());
}

// --- NIP-17 (9) --------------------------------------------------------------------------

#[test]
fn is_gift_wrap_event_returns_true_for_kind_1059() {
    assert!(event_of_kind(1059).kind.is_gift_wrap());
}

#[test]
fn is_gift_wrap_event_returns_false_for_any_other_kind() {
    for kind in [1, 13, 14] {
        assert!(!event_of_kind(kind).kind.is_gift_wrap(), "kind {kind}");
    }
}

#[test]
fn is_seal_event_returns_true_for_kind_13() {
    assert!(event_of_kind(13).kind.is_seal());
}

#[test]
fn is_seal_event_returns_false_for_any_other_kind() {
    for kind in [1, 1059, 14] {
        assert!(!event_of_kind(kind).kind.is_seal(), "kind {kind}");
    }
}

#[test]
fn is_direct_message_event_returns_true_for_kind_14() {
    assert!(event_of_kind(14).kind.is_direct_message());
}

#[test]
fn is_direct_message_event_returns_false_for_kind_4_legacy_nip04_dm() {
    assert!(!event_of_kind(4).kind.is_direct_message());
}

#[test]
fn is_direct_message_event_returns_false_for_any_other_kind() {
    for kind in [1, 1059, 13] {
        assert!(!event_of_kind(kind).kind.is_direct_message(), "kind {kind}");
    }
}

#[test]
fn is_file_message_event_returns_true_for_kind_15() {
    assert!(event_of_kind(15).kind.is_file_message());
}

#[test]
fn is_file_message_event_returns_false_for_any_other_kind() {
    for kind in [1, 14, 1059] {
        assert!(!event_of_kind(kind).kind.is_file_message(), "kind {kind}");
    }
}

// --- Marmot Protocol (8) -----------------------------------------------------------------

#[test]
fn is_welcome_rumor_event_returns_true_for_kind_444() {
    assert!(event_of_kind(444).kind.is_welcome_rumor());
}

#[test]
fn is_welcome_rumor_event_returns_false_for_kind_445_group_event() {
    assert!(!event_of_kind(445).kind.is_welcome_rumor());
}

#[test]
fn is_welcome_rumor_event_returns_false_for_kind_1059_gift_wrap() {
    assert!(!event_of_kind(1059).kind.is_welcome_rumor());
}

#[test]
fn is_welcome_rumor_event_returns_false_for_any_unrelated_kind() {
    assert!(!event_of_kind(1).kind.is_welcome_rumor());
}

#[test]
fn is_marmot_group_event_returns_true_for_kind_445() {
    assert!(event_of_kind(445).kind.is_marmot_group_event());
}

#[test]
fn is_marmot_group_event_returns_false_for_kind_444_welcome_rumor() {
    assert!(!event_of_kind(444).kind.is_marmot_group_event());
}

#[test]
fn is_marmot_group_event_returns_false_for_kind_443_legacy_key_package() {
    assert!(!event_of_kind(443).kind.is_marmot_group_event());
}

#[test]
fn is_marmot_group_event_returns_false_for_any_unrelated_kind() {
    assert!(!event_of_kind(1).kind.is_marmot_group_event());
    assert!(!event_of_kind(1059).kind.is_marmot_group_event());
}

// --- NIP-09 (2) --------------------------------------------------------------------------

#[test]
fn is_delete_event_returns_true_if_event_is_kind_5() {
    assert!(event_of_kind(5).kind.is_delete());
}

#[test]
fn is_delete_event_returns_false_if_event_is_not_kind_5() {
    assert!(!event_of_kind(5 * 100_000).kind.is_delete());
}

// --- NIP-62 (7) --------------------------------------------------------------------------

#[test]
fn is_request_to_vanish_event_returns_true_if_event_is_kind_62() {
    assert!(event_of_kind(62).is_request_to_vanish(None));
}

#[test]
fn is_request_to_vanish_event_returns_false_if_event_is_not_kind_62() {
    assert!(!event_of_kind(1).is_request_to_vanish(None));
}

#[test]
fn is_request_to_vanish_event_returns_true_when_event_contains_the_relay_url() {
    let event = Event {
        kind: Kind::REQUEST_TO_VANISH,
        tags: vec![vec!["r".to_owned(), "relay_url".to_owned()]],
        ..event_of_kind(62)
    };

    assert!(event.is_request_to_vanish(Some("relay_url")));
}

#[test]
fn is_request_to_vanish_event_returns_true_when_event_contains_all_relays() {
    let event = Event {
        kind: Kind::REQUEST_TO_VANISH,
        tags: vec![vec!["r".to_owned(), "ALL_RELAYS".to_owned()]],
        ..event_of_kind(62)
    };

    assert!(event.is_request_to_vanish(Some("relay_url")));
}

#[test]
fn is_request_to_vanish_event_returns_false_when_relay_tag_does_not_match() {
    let event = Event {
        kind: Kind::REQUEST_TO_VANISH,
        tags: vec![vec!["r".to_owned(), "other_relay_url".to_owned()]],
        ..event_of_kind(62)
    };

    assert!(!event.is_request_to_vanish(Some("relay_url")));
}

#[test]
fn is_request_to_vanish_event_returns_false_when_there_are_no_relay_tags() {
    let event = Event {
        kind: Kind::REQUEST_TO_VANISH,
        tags: Vec::new(),
        ..event_of_kind(62)
    };

    assert!(!event.is_request_to_vanish(Some("relay_url")));
}

#[test]
fn is_request_to_vanish_event_returns_false_when_relay_url_is_provided_for_non_kind_62_event() {
    let event = Event {
        kind: Kind::TEXT_NOTE,
        tags: vec![vec!["r".to_owned(), "relay_url".to_owned()]],
        ..event_of_kind(1)
    };

    assert!(!event.is_request_to_vanish(Some("relay_url")));
}

// --- NIP-33 (2) --------------------------------------------------------------------------

#[test]
fn nip33_returns_true_if_event_is_a_parameterized_replaceable_event() {
    assert!(event_of_kind(30_000).kind.is_parameterized_replaceable());
}

#[test]
fn nip33_returns_false_if_event_is_a_parameterized_replaceable_event() {
    assert!(!event_of_kind(40_000).kind.is_parameterized_replaceable());
}

// --- NIP-40 (12) -------------------------------------------------------------------------

fn nip40_event(tags: Vec<Vec<&str>>) -> Event {
    Event {
        id: "a080fd288b60ac2225ff2e2d815291bd730911e583e177302cc949a15dc2b2dc"
            .parse()
            .unwrap(),
        pubkey: "62903b1ff41559daf9ee98ef1ae67cc52f301bb5ce26d14baba3052f649c3f49"
            .parse()
            .unwrap(),
        created_at: 1_660_896_109,
        tags: tags
            .into_iter()
            .map(|tag| tag.into_iter().map(str::to_owned).collect())
            .collect(),
        ..event_of_kind(1)
    }
}

#[test]
fn nip40_get_event_expiration_returns_true_if_expiration_is_a_safe_integer() {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "160000000"
        ]])),
        Some(160_000_000)
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_event_does_not_have_expiration_tag() {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(Vec::new())),
        None
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_expiration_is_unsafe_integer() {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "160000000000000000000"
        ]])),
        None
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_expiration_is_malformed_data() {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "a"
        ]])),
        None
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_expiration_is_0() {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "0"
        ]])),
        None
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_expiration_exceeds_the_postgres_int4_column_max() {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "10000000000"
        ]])),
        None
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_expiration_is_the_maximum_representable_unix_seconds_timestamp()
 {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "253402300799"
        ]])),
        None
    );
}

#[test]
fn nip40_get_event_expiration_returns_true_if_expiration_is_the_maximum_value_the_expires_at_column_can_store()
 {
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "2147483647"
        ]])),
        Some(2_147_483_647)
    );
}

#[test]
fn nip40_get_event_expiration_returns_false_if_expiration_looks_like_a_millisecond_scale_timestamp()
{
    assert_eq!(
        nostream_core::expiration::get_event_expiration(&nip40_event(vec![vec![
            "expiration",
            "1700000000000"
        ]])),
        None
    );
}

#[test]
fn nip40_is_expired_event_returns_false_if_event_does_not_have_tags() {
    assert!(!nostream_core::expiration::is_expired_event(
        &nip40_event(Vec::new()),
        1_700_000_000
    ));
}

#[test]
fn nip40_is_expired_event_returns_false_if_event_does_not_have_expiration_tags() {
    assert!(!nostream_core::expiration::is_expired_event(
        &nip40_event(vec![vec![
            "delegation",
            "86f0689bd48dcd19c67a19d994f938ee34f251d8c39976290955ff585f2db42e",
        ]]),
        1_700_000_000
    ));
}

#[test]
fn nip40_is_expired_event_returns_true_if_event_is_expired() {
    assert!(nostream_core::expiration::is_expired_event(
        &nip40_event(vec![vec!["expiration", "100000"]]),
        1_700_000_000
    ));
}

// --- NIP-70 (6) --------------------------------------------------------------------------

#[test]
fn nip70_is_protected_event_returns_true_if_event_has_a_tag() {
    assert!(event_with_tags(vec![vec!["-"]]).is_protected());
}

#[test]
fn nip70_is_protected_event_returns_true_if_protected_tag_has_extra_values() {
    assert!(event_with_tags(vec![vec!["-", "some-reason"]]).is_protected());
}

#[test]
fn nip70_is_protected_event_returns_false_if_event_has_no_tags() {
    assert!(!event_with_tags(Vec::new()).is_protected());
}

#[test]
fn nip70_is_protected_event_returns_false_if_event_has_unrelated_tags() {
    assert!(!event_with_tags(vec![vec!["e", "7377fa81fc6c"], vec!["p", "22e804d"]]).is_protected());
}

#[test]
fn nip70_is_protected_event_returns_false_if_appears_as_a_tag_value_not_a_tag_name() {
    assert!(!event_with_tags(vec![vec!["e", "-"]]).is_protected());
}

#[test]
fn nip70_is_protected_event_returns_true_when_protected_tag_is_among_other_tags() {
    assert!(
        event_with_tags(vec![
            vec!["e", "7377fa81fc6c"],
            vec!["-"],
            vec!["p", "22e804d"]
        ])
        .is_protected()
    );
}
