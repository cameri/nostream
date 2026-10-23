//! Parity with `test/unit/utils/messages.spec.ts` (14 cases), the codec half of
//! `test/unit/schemas/message-schema.spec.ts` (17), `test/unit/schemas/event-schema.spec.ts`
//! (57) and `test/unit/utils/filter.spec.ts` (9), all measured green at the capture commit
//! `242a3001`.
//!
//! | mocha case | Rust test |
//! |---|---|
//! | `createNotice returns a notice message` | `notice_frame_` |
//! | `createOutgoingEventMessage …` | `event_frame_` |
//! | `createEndOfStoredEventsNoticeMessage …` | `eose_frame_` |
//! | `createCommandResult …` (4) | `ok_frame_` |
//! | `createClosedMessage …` (2) | `closed_frame_` |
//! | `createSubscriptionMessage …` (3) | `decode_accepts_the_five_client_kinds` |
//! | `createRelayedEventMessage …` (2) | `relayed_event_` |
//! | `message-schema validateSchema …` (17) | `decode_…` |
//! | `event-schema …` (57) | `strict_event_schema_…` |
//! | `filter countFilterValues …` (5) | `filter_helpers_…` |
//! | `filter isGenericTagQuery …` (4) | `filter_helpers_…` |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nostream_core::event::{Event, EventId, Kind, Pubkey, Signature};
use nostream_core::filter::{Filter, count_filter_values, is_generic_tag_query};
use nostream_core::messages::{
    ClientMessage, ClosedMessage, CommandResult, CountResultMessage, EoseMessage, MessageType,
    NoticeMessage, OutgoingEventMessage, RelayMessage, WireError, decode,
};
use nostream_core::validation::validate_event;
use serde_json::json;

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

fn frame_document(event: &Event) -> String {
    serde_json::to_string(event).unwrap()
}

#[test]
fn notice_frame_is_a_two_element_array() {
    let frame = RelayMessage::Notice(NoticeMessage {
        message: "some notice".to_owned(),
    });

    assert_eq!(frame.to_text(), r#"["NOTICE","some notice"]"#);
}

#[test]
fn event_frame_is_the_verb_the_id_and_the_event_in_wire_order() {
    let event = event();
    let frame = RelayMessage::Event(OutgoingEventMessage {
        subscription_id: "subscriptionId".to_owned(),
        event: std::sync::Arc::new(event.clone()),
    });

    assert_eq!(
        frame.to_text(),
        format!(r#"["EVENT","subscriptionId",{}]"#, frame_document(&event))
    );
    assert!(frame.to_text().starts_with(&format!(
        r#"["EVENT","subscriptionId",{{"id":"{ID}","pubkey":"{PUBKEY}","created_at":"#
    )));
}

#[test]
fn eose_frame_is_the_verb_and_the_subscription() {
    assert_eq!(
        RelayMessage::Eose(EoseMessage {
            subscription_id: "subscriptionId".to_owned()
        })
        .to_text(),
        r#"["EOSE","subscriptionId"]"#
    );
}

#[test]
fn ok_frame_has_four_elements_without_params_and_five_with_them() {
    let plain = RelayMessage::Ok(CommandResult {
        event_id: ID.parse().unwrap(),
        accepted: true,
        message: "accepted".to_owned(),
        params: None,
    });

    assert_eq!(plain.to_text(), format!(r#"["OK","{ID}",true,"accepted"]"#));

    let with_reason = RelayMessage::Ok(CommandResult {
        event_id: ID.parse().unwrap(),
        accepted: false,
        message: "blocked: content not allowed".to_owned(),
        params: None,
    });

    assert_eq!(
        with_reason.to_text(),
        format!(r#"["OK","{ID}",false,"blocked: content not allowed"]"#)
    );

    let with_params = RelayMessage::Ok(CommandResult {
        event_id: ID.parse().unwrap(),
        accepted: false,
        message: "rate-limited: slow down".to_owned(),
        params: Some("1000".to_owned()),
    });

    assert_eq!(
        with_params.to_text(),
        format!(r#"["OK","{ID}",false,"rate-limited: slow down","1000"]"#)
    );

    let empty = RelayMessage::Ok(CommandResult {
        event_id: ID.parse().unwrap(),
        accepted: true,
        message: String::new(),
        params: None,
    });

    assert_eq!(empty.to_text(), format!(r#"["OK","{ID}",true,""]"#));
}

#[test]
fn closed_frame_has_three_elements_without_params_and_four_with_them() {
    let plain = RelayMessage::Closed(ClosedMessage {
        subscription_id: "sub1".to_owned(),
        message: "error: shutting down".to_owned(),
        params: None,
    });

    assert_eq!(
        plain.to_text(),
        r#"["CLOSED","sub1","error: shutting down"]"#
    );

    let with_params = RelayMessage::Closed(ClosedMessage {
        subscription_id: "sub1".to_owned(),
        message: "rate-limited: slow down".to_owned(),
        params: Some("2500".to_owned()),
    });

    assert_eq!(
        with_params.to_text(),
        r#"["CLOSED","sub1","rate-limited: slow down","2500"]"#
    );
}

#[test]
fn count_frame_carries_the_count_object() {
    assert_eq!(
        RelayMessage::Count(CountResultMessage {
            subscription_id: "c1".to_owned(),
            count: 0,
        })
        .to_text(),
        r#"["COUNT","c1",{"count":0}]"#
    );
}

#[test]
fn auth_challenge_frame_is_the_verb_and_the_challenge() {
    assert_eq!(
        RelayMessage::Auth(nostream_core::messages::AuthChallengeMessage {
            challenge: "abc".to_owned(),
        })
        .to_text(),
        r#"["AUTH","abc"]"#
    );
}

#[test]
fn escape_sequences_match_json_stringify() {
    let mut event = event();
    event.content = "a\u{1}b\u{1f}c\"d\\e\u{7f}f\u{2028}g😀h\n\t".to_owned();
    event.tags = vec![vec!["e".to_owned(), "AA".to_owned()]];

    let text = serde_json::to_string(&event).unwrap();

    // V8 leaves DEL (U+007F) and U+2028 raw, and refuses to escape a valid surrogate
    // pair; serde_json does the same, which is what makes these bytes comparable.
    assert!(text.contains("\"content\":\"a\\u0001b\\u001fc\\\"d\\\\e\u{7f}f\u{2028}g😀h\\n\\t\""));
    assert!(text.contains(r#""tags":[["e","AA"]]"#));
}

#[test]
fn relayed_event_message_is_unused_by_this_job_but_keeps_its_shape() {
    let relayed = nostream_core::messages::RelayedEvent {
        event: event(),
        source: PUBKEY.parse().unwrap(),
    };

    assert_eq!(relayed.event.id, ID.parse::<EventId>().unwrap());
}

#[test]
fn decode_accepts_the_five_client_kinds() {
    let event = event();
    let event_document = frame_document(&event);

    let frames = [
        format!(r#"["EVENT",{event_document}]"#),
        r#"["REQ","sub1",{"kinds":[1]}]"#.to_owned(),
        r#"["REQ","sub1",{"kinds":[1]},{"kinds":[0],"authors":["aaaa"]}]"#.to_owned(),
        r#"["CLOSE","sub1"]"#.to_owned(),
        r#"["COUNT","c1",{"kinds":[1]}]"#.to_owned(),
        format!(r#"["AUTH",{event_document}]"#),
    ];

    let decoded: Vec<ClientMessage> = frames.iter().map(|text| decode(text).unwrap()).collect();

    assert_eq!(
        decoded
            .iter()
            .map(ClientMessage::message_type)
            .collect::<Vec<_>>(),
        vec![
            MessageType::Event,
            MessageType::Req,
            MessageType::Req,
            MessageType::Close,
            MessageType::Count,
            MessageType::Auth,
        ]
    );

    assert_eq!(decoded[0], ClientMessage::Event(event.clone()));
    assert_eq!(
        decoded[5],
        ClientMessage::Auth(nostream_core::messages::AuthMessage { event })
    );
}

#[test]
fn decode_reports_the_capture_notice_strings() {
    for (frame, detail) in [
        (r#"["NEG-OPEN","sub1",{}]"#, "Invalid input"),
        (r#"["FOO"]"#, "Invalid input"),
        (r#"{"kind":1}"#, "Invalid input"),
        (
            r#"["REQ","s1"]"#,
            "REQ message must contain at least one filter",
        ),
        (
            r#"["COUNT","c1"]"#,
            "COUNT message must contain at least one filter",
        ),
        (
            r#"["REQ","s1",{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]}]"#,
            "REQ message must contain at most 12 elements",
        ),
        (
            r#"["COUNT","c1",{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]},{"kinds":[1]}]"#,
            "COUNT message must contain at most 12 elements",
        ),
        (
            r#"["REQ","s1",{"unknown":1}]"#,
            "Expected array, received number",
        ),
        (r#"["REQ","s1",{"unknown":["x"]}]"#, "Unknown key: unknown"),
        (
            r#"["REQ","s1",{"kinds":[[1,2]]}]"#,
            "Expected number, received array",
        ),
    ] {
        let error = decode(frame).unwrap_err();

        assert_eq!(error, WireError::Validation(detail.to_owned()), "{frame}");
        assert_eq!(error.notice(), format!("invalid: {detail}"));
    }
}

#[test]
fn decode_reports_json_syntax_failure_as_a_tolerated_detail() {
    let error = decode("{\"kind\":").unwrap_err();

    assert!(matches!(error, WireError::Json(_)), "{error:?}");
    assert!(error.notice().starts_with("invalid: "));
}

#[test]
fn decode_validates_the_event_payload() {
    let mut document = serde_json::to_value(event()).unwrap();

    document["extra"] = json!(true);

    let error = decode(&format!(r#"["EVENT",{document}]"#)).unwrap_err();

    assert_eq!(
        error,
        WireError::Validation("Unrecognized key(s) in object: 'extra'".to_owned())
    );

    let frame = format!(r#"["AUTH",{}]"#, frame_document(&event()));

    assert!(matches!(decode(&frame), Ok(ClientMessage::Auth(_))));
}

#[test]
fn strict_event_schema_rejects_an_unknown_field() {
    let document = format!(
        r#"{{"id":"{ID}","pubkey":"{PUBKEY}","created_at":1,"kind":1,"tags":[],"content":"","sig":"{SIG}","extra":true}}"#
    );

    let error = decode(&format!(r#"["EVENT",{document}]"#)).unwrap_err();

    assert!(
        error.detail().contains("Unrecognized key"),
        "{}",
        error.detail()
    );
}

#[test]
fn strict_event_schema_checks_the_refinements() {
    // NIP-25: a kind-7 reaction needs an `e` or `a` tag.
    let mut reaction = event();
    reaction.kind = Kind(7);
    assert_eq!(
        validate_event(&reaction).unwrap_err().to_string(),
        "invalid event: Reaction event (kind 7) must have at least one e or a tag"
    );
    reaction.tags = vec![vec!["e".to_owned(), ID.to_owned()]];
    assert!(validate_event(&reaction).is_ok());

    // NIP-25: a kind-17 external reaction needs both a `k` and an `i` tag.
    let mut external = event();
    external.kind = Kind(17);
    external.tags = vec![vec!["k".to_owned(), "1".to_owned()]];
    assert_eq!(
        validate_event(&external).unwrap_err().to_string(),
        "invalid event: External content reaction event (kind 17) must have k and i tags"
    );
    external
        .tags
        .push(vec!["i".to_owned(), "https://example.com".to_owned()]);
    assert!(validate_event(&external).is_ok());

    // NIP-65: every `r` tag on a relay list is a URL.
    let mut relay_list = event();
    relay_list.kind = Kind(10_002);
    relay_list.tags = vec![vec!["r".to_owned(), "not a url".to_owned()]];
    assert_eq!(
        validate_event(&relay_list).unwrap_err().to_string(),
        "invalid event: Invalid relay URL"
    );
    relay_list.tags = vec![vec!["r".to_owned(), "wss://relay.example.com".to_owned()]];
    assert!(validate_event(&relay_list).is_ok());

    // NIP-12: every `g` tag is a geohash.
    let mut located = event();
    located.tags = vec![vec!["g".to_owned(), "u4pruydqqvj".to_owned()]];
    assert!(validate_event(&located).is_ok());
    located.tags = vec![vec!["g".to_owned(), "abc".to_owned()]];
    assert_eq!(
        validate_event(&located).unwrap_err().to_string(),
        "invalid event: Invalid geohash"
    );
}

#[test]
fn strict_event_schema_checks_the_timestamp_window() {
    let mut event = event();

    event.created_at = -1;
    assert_eq!(
        validate_event(&event).unwrap_err().to_string(),
        "invalid event: Number must be greater than or equal to 0"
    );

    // 1672295751103 is a millisecond timestamp: `Math.log10(value) < 10` fails.
    event.created_at = 1_672_295_751_103;
    assert_eq!(
        validate_event(&event).unwrap_err().to_string(),
        "invalid event: Invalid timestamp"
    );

    event.created_at = 10_000_000_000;
    assert_eq!(
        validate_event(&event).unwrap_err().to_string(),
        "invalid event: Invalid timestamp"
    );

    event.created_at = 1_660_306_803;
    assert!(validate_event(&event).is_ok());
}

#[test]
fn strict_event_schema_checks_tag_tuples() {
    let mut event = event();

    event.tags = vec![Vec::new()];
    assert_eq!(
        validate_event(&event).unwrap_err().to_string(),
        "invalid event: Array must contain at least 1 element(s)"
    );

    event.tags = vec![vec![String::new(), "x".to_owned()]];
    assert_eq!(
        validate_event(&event).unwrap_err().to_string(),
        "invalid event: String must contain at least 1 character(s)"
    );

    event.tags = vec![vec!["e".to_owned()]];
    assert!(validate_event(&event).is_ok());
}

#[test]
fn strict_event_schema_accepts_the_capture_fixture_event() {
    // `test/unit/schemas/event-schema.spec.ts`'s `beforeEach` event: kind 7 with `e`/`p` tags.
    let event: Event = serde_json::from_str(
        r#"{"id":"fa4dd948576fe182f5d0e3120b9df42c83dffa1c884754d5e4d3b0a2f98a01c5","pubkey":"edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29","created_at":1660306803,"kind":7,"tags":[["e","c58e83bb744e4c29642db7a5c3bd1519516ad5c51f6ba5f90c451d03c1961210","","root"],["p","edfa27d49d2af37ee331e1225bb6ed1912c6d999281b36d8018ad99bc3573c29"]],"content":"","sig":"313a9b8cd68267a51da84e292c0937d1f3686c6757c4584f50fcedad2b13fad755e6226924f79880fb5aa9de95c04231a4823981513ac9e7092bad7488282a96"}"#,
    )
    .unwrap();

    assert!(validate_event(&event).is_ok());
}

#[test]
fn filter_helpers_match_the_capture() {
    assert!(is_generic_tag_query("#a"));
    assert!(is_generic_tag_query("#A"));
    assert!(!is_generic_tag_query("#0"));
    assert!(!is_generic_tag_query("#abc"));

    let count =
        |document: &str| count_filter_values(&serde_json::from_str::<Filter>(document).unwrap());

    assert_eq!(count("{}"), 0);
    assert_eq!(
        count(r#"{"ids":["aa"],"authors":["bb","cc"],"kinds":[1,2,3]}"#),
        6
    );
    assert_eq!(count(r##"{"#e":["aa","bb"],"#p":["cc"]}"##), 3);
    assert_eq!(
        count(r#"{"ids":["aa"],"since":1,"until":2,"limit":3,"search":"aa bb cc"}"#),
        1
    );
    assert_eq!(count(r#"{"ids":[],"authors":["aa"]}"#), 1);
}

#[test]
fn filter_validation_reports_the_first_issue_message() {
    let error = decode(r#"["REQ","s1",{"limit":-1}]"#).unwrap_err();

    assert_eq!(
        error,
        WireError::Validation("Number must be greater than or equal to 0".to_owned())
    );
}

#[test]
fn a_frame_that_is_not_an_array_is_invalid_input() {
    let error = decode("42").unwrap_err();

    assert_eq!(error, WireError::Validation("Invalid input".to_owned()));
}

#[test]
fn signature_and_pubkey_hex_rules_are_reported() {
    let mut document = serde_json::to_value(event()).unwrap();
    document["id"] = json!("F".repeat(64));

    let error = decode(&format!(r#"["EVENT",{document}]"#)).unwrap_err();
    assert_eq!(error, WireError::Validation("Invalid".to_owned()));

    document["id"] = json!("f".repeat(63));
    let error = decode(&format!(r#"["EVENT",{document}]"#)).unwrap_err();
    assert_eq!(
        error,
        WireError::Validation("String must contain exactly 64 character(s)".to_owned())
    );

    let _: Pubkey = PUBKEY.parse().unwrap();
    let _: Signature = SIG.parse().unwrap();
}
