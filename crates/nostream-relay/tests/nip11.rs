//! AC4 — the NIP-11 document's decided field set, one case per decision.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_key_set_is_the_decided_one` | the nine always-present keys, the four kept-when-set keys, and every dropped key absent |
//! | `supported_nips_is_the_advertised_set_filtered_by_what_runs` | 43/50 follow their switches, 77 never appears, and the order is `SUPPORTED_NIPS`'s |
//! | `the_limitation_block_reports_the_enforced_limits` | the enforced numbers, and a configured `0` omitted |
//! | `restricted_writes_folds_the_arms_the_event_handler_enforces` | each arm alone flips it; the all-off fixture is false; a subscription plan alone does not |
//! | `fees_reports_enabled_schedules_in_msats` | enabled schedules only, `publication` only when configured, empty under `payments.enabled: false` |
//! | `self_is_the_configured_pubkey_or_the_signing_one` | configured hex wins, an `npub` decodes, an unparsable value falls back, neither is absent |
//! | `the_version_and_software_are_the_callers` | the version argument, the workspace repository, and a hex `pubkey` |
//!
//! The fixture is the shipped `resources/default-settings.yaml`, typed through the settings
//! loader: its numbers are the ones AC4 names.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use nostream_config::settings::{EventIdLimits, FeeSchedule, Settings, SubscriptionPlan};
use nostream_core::constants::SUPPORTED_NIPS;
use nostream_core::{Kind, KindSelector, Pubkey, SettingsPubkey};
use nostream_relay::nip11;
use serde_json::{Value, json};

/// The fixture pair the NIP-19 decoder's own tests use.
const NPUB: &str = "npub1yt5qf5nw694k3k6jt8ncgj0fdk4463jv3arshk37kxnsgeljc7fsmhwffw";
const HEX: &str = "22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793";
/// A second key, so "the configured value wins" is distinguishable from "the signing key".
const OTHER: &str = "9d1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";

fn shipped() -> Settings {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/default-settings.yaml");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("the shipped defaults {}: {error}", path.display()));
    let document: serde_yaml::Value = serde_yaml::from_str(&raw).expect("the defaults are YAML");
    nostream_config::fit(&document, &document).expect("the shipped defaults fit their own schema")
}

/// The shipped settings with the four conditional top-level keys unset.
fn minimal() -> Settings {
    let mut settings = shipped();
    settings.info.banner = None;
    settings.info.icon = None;
    settings.info.self_ = None;
    settings.info.terms_of_service = None;
    settings
}

fn value(settings: &Settings, version: &str, signing_pubkey: Option<Pubkey>) -> Value {
    serde_json::to_value(nip11::document(settings, version, signing_pubkey)).expect("a document")
}

fn advertised(document: &Value) -> Vec<u16> {
    document["supported_nips"]
        .as_array()
        .expect("an array")
        .iter()
        .map(|nip| u16::try_from(nip.as_u64().expect("a number")).expect("a NIP id"))
        .collect()
}

#[test]
fn the_key_set_is_the_decided_one() {
    let document = value(&minimal(), "0.1.0", None);
    let mut keys: Vec<&str> = document
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "contact",
            "description",
            "fees",
            "limitation",
            "name",
            "pubkey",
            "software",
            "supported_nips",
            "version",
        ],
        "the nine always-present keys: {document}"
    );

    let mut supplied = minimal();
    supplied.info.banner = Some("https://example.com/banner.png".to_owned());
    supplied.info.icon = Some("https://example.com/icon.png".to_owned());
    supplied.info.terms_of_service = Some("https://example.com/terms".to_owned());
    let document = value(&supplied, "0.1.0", Some(OTHER.parse().unwrap()));

    for key in ["banner", "icon", "self", "terms_of_service"] {
        assert!(
            document.get(key).is_some(),
            "{key} is present when the fixture supplies it: {document}"
        );
    }

    for key in [
        "supported_nip_extensions",
        "supported_mips",
        "payments_url",
        "peering",
    ] {
        assert!(document.get(key).is_none(), "{key} is dropped: {document}");
    }
    for key in ["max_event_tags", "min_prefix"] {
        assert!(
            document["limitation"].get(key).is_none(),
            "limitation.{key} is dropped: {document}"
        );
    }
    assert!(
        document["fees"].get("subscription").is_none(),
        "fees.subscription is dropped: {document}"
    );
}

#[test]
fn supported_nips_is_the_advertised_set_filtered_by_what_runs() {
    let mut settings = shipped();
    settings.nip43.as_mut().expect("the shipped nip43").enabled = true;
    settings.nip50.as_mut().expect("the shipped nip50").enabled = Some(true);

    let document = value(&settings, "0.1.0", None);
    let list = advertised(&document);
    assert!(list.contains(&43), "43 runs: {list:?}");
    assert!(list.contains(&50), "50 runs: {list:?}");
    assert!(!list.contains(&77), "77 is a stub and never advertised");
    let expected: Vec<u16> = SUPPORTED_NIPS
        .iter()
        .copied()
        .filter(|nip| *nip != 77)
        .collect();
    assert_eq!(
        list, expected,
        "the advertised list keeps SUPPORTED_NIPS's order"
    );

    let mut settings = shipped();
    settings.nip43.as_mut().expect("the shipped nip43").enabled = false;
    settings.nip50.as_mut().expect("the shipped nip50").enabled = Some(false);

    let document = value(&settings, "0.1.0", None);
    let list = advertised(&document);
    assert!(!list.contains(&43), "43 does not run: {list:?}");
    assert!(!list.contains(&50), "50 does not run: {list:?}");
    assert!(list.contains(&11) && list.contains(&98), "{list:?}");
    let expected: Vec<u16> = SUPPORTED_NIPS
        .iter()
        .copied()
        .filter(|nip| !matches!(nip, 43 | 50 | 77))
        .collect();
    assert_eq!(list, expected);
}

#[test]
fn the_limitation_block_reports_the_enforced_limits() {
    let settings = shipped();
    let document = value(&settings, "0.1.0", None);
    let limitation = &document["limitation"];

    assert_eq!(
        limitation["max_message_length"],
        json!(nostream_relay::transport::max_payload_size(&settings) as u64),
        "the number the transport enforces, not a second constant"
    );
    assert_eq!(limitation["max_message_length"], json!(524_288));
    assert_eq!(limitation["max_subscriptions"], json!(10));
    assert_eq!(limitation["max_filters"], json!(10));
    assert_eq!(limitation["max_filter_values"], json!(2_500));
    assert_eq!(limitation["max_limit"], json!(5_000));
    assert_eq!(limitation["max_subid_length"], json!(256));
    assert_eq!(limitation["max_content_length"], json!(102_400));
    assert_eq!(limitation["default_limit"], json!(500));
    assert_eq!(limitation["auth_required"], json!(false));
    assert_eq!(limitation["search_supported"], json!(false));
    assert!(
        limitation.get("min_pow_difficulty").is_none(),
        "a zero floor is not advertised: {limitation}"
    );

    let mut zeroed = shipped();
    zeroed
        .limits
        .as_mut()
        .unwrap()
        .client
        .as_mut()
        .unwrap()
        .subscription
        .as_mut()
        .unwrap()
        .max_filters = Some(0);
    let document = value(&zeroed, "0.1.0", None);
    assert!(
        document["limitation"].get("max_filters").is_none(),
        "0 means no cap to the checks that read it, so it is omitted: {document}"
    );
}

/// The shipped defaults with every write-restriction arm off.
fn all_arms_off() -> Settings {
    let mut settings = shipped();
    let event = settings.limits.as_mut().unwrap().event.as_mut().unwrap();
    event.event_id = Some(EventIdLimits {
        min_leading_zero_bits: Some(0),
    });
    let pubkey = event.pubkey.as_mut().unwrap();
    pubkey.min_leading_zero_bits = 0;
    pubkey.whitelist = Some(Vec::new());
    pubkey.blacklist = Some(Vec::new());
    let kind = event.kind.as_mut().unwrap();
    kind.whitelist = Some(Vec::new());
    kind.blacklist = Some(Vec::new());
    event.pow.as_mut().unwrap().enabled = false;
    settings
}

#[test]
fn restricted_writes_folds_the_arms_the_event_handler_enforces() {
    assert!(
        !nip11::restricted_writes(&all_arms_off()),
        "the all-off fixture restricts nothing"
    );

    let mut arms: Vec<(&str, Settings)> = Vec::new();

    let mut admission = all_arms_off();
    {
        let payments = admission.payments.as_mut().unwrap();
        payments.enabled = true;
        payments.fee_schedules.admission[0].enabled = true;
    }
    arms.push(("an enabled admission fee under payments.enabled", admission));

    let mut nip43 = all_arms_off();
    nip43.nip43.as_mut().unwrap().enabled = true;
    arms.push(("nip43.enabled", nip43));

    let mut auth = all_arms_off();
    auth.nip42.as_mut().unwrap().auth_required = Some(true);
    arms.push(("nip42.authRequired", auth));

    let mut event_id = all_arms_off();
    event_id
        .limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .event_id = Some(EventIdLimits {
        min_leading_zero_bits: Some(1),
    });
    arms.push(("eventId.minLeadingZeroBits", event_id));

    let mut pubkey_bits = all_arms_off();
    pubkey_bits
        .limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .pubkey
        .as_mut()
        .unwrap()
        .min_leading_zero_bits = 1;
    arms.push(("pubkey.minLeadingZeroBits", pubkey_bits));

    let mut pow = all_arms_off();
    pow.limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .pow
        .as_mut()
        .unwrap()
        .enabled = true;
    arms.push(("pow.enabled", pow));

    let mut pubkey_whitelist = all_arms_off();
    pubkey_whitelist
        .limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .pubkey
        .as_mut()
        .unwrap()
        .whitelist = Some(vec![SettingsPubkey("abc123".to_owned())]);
    arms.push(("pubkey.whitelist", pubkey_whitelist));

    let mut pubkey_blacklist = all_arms_off();
    pubkey_blacklist
        .limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .pubkey
        .as_mut()
        .unwrap()
        .blacklist = Some(vec![SettingsPubkey("abc123".to_owned())]);
    arms.push(("pubkey.blacklist", pubkey_blacklist));

    let mut kind_whitelist = all_arms_off();
    kind_whitelist
        .limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .kind
        .as_mut()
        .unwrap()
        .whitelist = Some(vec![KindSelector::Single(Kind(1))]);
    arms.push(("kind.whitelist", kind_whitelist));

    let mut kind_blacklist = all_arms_off();
    kind_blacklist
        .limits
        .as_mut()
        .unwrap()
        .event
        .as_mut()
        .unwrap()
        .kind
        .as_mut()
        .unwrap()
        .blacklist = Some(vec![KindSelector::Single(Kind(4))]);
    arms.push(("kind.blacklist", kind_blacklist));

    for (name, settings) in arms {
        assert!(
            nip11::restricted_writes(&settings),
            "{name} alone restricts writes"
        );
    }

    // The capture's subscription arm is not ported: nothing here enforces subscriptions.
    let mut plans = all_arms_off();
    {
        let payments = plans.payments.as_mut().unwrap();
        payments.enabled = true;
        payments.subscription_plans = Some(vec![SubscriptionPlan {
            id: "basic".to_owned(),
            description: None,
            amount: 1_000,
            interval_seconds: 2_592_000,
            grace_seconds: 0,
            limits: None,
        }]);
    }
    assert!(
        !nip11::restricted_writes(&plans),
        "a configured subscription plan alone does not restrict writes"
    );
}

#[test]
fn fees_reports_enabled_schedules_in_msats() {
    let mut settings = shipped();
    {
        let payments = settings.payments.as_mut().unwrap();
        payments.enabled = true;
        payments.fee_schedules.admission = vec![
            FeeSchedule {
                enabled: true,
                description: None,
                amount: 100,
                whitelists: None,
            },
            FeeSchedule {
                enabled: false,
                description: None,
                amount: 200,
                whitelists: None,
            },
        ];
        payments.fee_schedules.publication = None;
    }

    let document = value(&settings, "0.1.0", None);
    assert_eq!(
        document["fees"],
        json!({ "admission": [{ "amount": 100, "unit": "msats" }] }),
        "the enabled schedule only, and no publication key"
    );

    settings
        .payments
        .as_mut()
        .unwrap()
        .fee_schedules
        .publication = Some(vec![FeeSchedule {
        enabled: true,
        description: None,
        amount: 50,
        whitelists: None,
    }]);
    let document = value(&settings, "0.1.0", None);
    assert_eq!(
        document["fees"]["publication"],
        json!([{ "amount": 50, "unit": "msats" }]),
        "publication appears when the settings carry it"
    );

    settings.payments.as_mut().unwrap().enabled = false;
    let document = value(&settings, "0.1.0", None);
    assert_eq!(
        document["fees"],
        json!({ "admission": [] }),
        "payments off: an empty admission array and nothing else"
    );
}

#[test]
fn self_is_the_configured_pubkey_or_the_signing_one() {
    let signing: Pubkey = OTHER.parse().unwrap();
    let expected: Pubkey = HEX.parse().unwrap();

    let mut settings = minimal();
    settings.info.self_ = Some(HEX.to_owned());
    assert_eq!(
        value(&settings, "0.1.0", Some(signing))["self"],
        json!(HEX),
        "the configured hex wins over the signing key"
    );

    settings.info.self_ = Some(NPUB.to_owned());
    assert_eq!(
        value(&settings, "0.1.0", Some(signing))["self"],
        json!(expected.to_string()),
        "an npub decodes to the same hex"
    );

    settings.info.self_ = Some("not-a-key".to_owned());
    assert_eq!(
        value(&settings, "0.1.0", Some(signing))["self"],
        json!(OTHER),
        "an unparsable value falls back to the signing key"
    );

    settings.info.self_ = None;
    assert!(
        value(&settings, "0.1.0", None).get("self").is_none(),
        "neither configured nor supplied: the key is absent"
    );
}

#[test]
fn the_version_and_software_are_the_callers() {
    let document = value(&shipped(), "9.9.9", None);
    assert_eq!(document["version"], json!("9.9.9"));
    assert_eq!(document["software"], json!(env!("CARGO_PKG_REPOSITORY")));

    let mut settings = minimal();
    settings.info.pubkey = NPUB.to_owned();
    let document = value(&settings, "0.1.0", None);
    assert_eq!(
        document["pubkey"],
        json!(HEX),
        "an npub1… info.pubkey is advertised as hex"
    );
}
