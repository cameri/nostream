//! Client and relay wire messages. Mirrors `src/@types/messages.ts`,
//! `src/utils/messages.ts` and `src/schemas/message-schema.ts`.
//!
//! The wire form is a positional JSON array whose first element is the verb. [`decode`]
//! parses the five client kinds and reports the schema's message when a frame is malformed;
//! [`RelayMessage::to_text`] is the single encoder every server→client frame goes through,
//! and its bytes are the capture's `JSON.stringify` output.
//!
//! The positional decoder replaces the capture's `attemptValidation(messageSchema)` call
//! (`src/adapters/web-socket-adapter.ts:199`). The zod messages it reports are reproduced
//! from `src/schemas/{message,event,filter}-schema.ts`. This list is the decoder's own
//! statement of where it differs from the capture, and which of those the tree decided.
//!
//! Decided, so reproducing it is the job:
//!
//! - The detail after `invalid: ` for unparseable JSON, where V8's `JSON.parse` diagnosis is
//!   not reproducible (tolerance T1, ADR 0004 records it).
//! - A `kind` — an event's, or a filter's `kinds` element — or a filter's `limit` that no `u64`
//!   can hold is refused rather than accepted: the capture admits it and this cannot represent
//!   it, so the refusal is decided, not borrowed. `filter::U64_RANGE_END` bounds both values;
//!   `filter::KIND_DOES_NOT_FIT` and `validate_limit` own the two wordings (ADR 0002,
//!   `docs/rewrite/decisions/0002-core-crypto-and-negentropy.md:125-136`).
//!
//! Open, so the capture is authoritative and this decoder is the defect (`CLAUDE.md`
//! §"Porting discipline"): zod separates a branch that aborted from one that recorded an
//! issue, and this decoder reports the issue either way. Where a member of the capture's
//! `z.union` (`src/schemas/message-schema.ts:61`) aborts, the union reports one
//! `invalid_union` issue whose message is `Invalid input`, and this decoder reports the
//! field's own message instead; a frame that is both over-long and carries a dirty element
//! likewise answers the element's message here and the tuple's `Array must contain at most N
//! element(s)` there (`["CLOSE","","junk"]`). Tracked in #979.

use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

use crate::event::{Event, EventId, Pubkey};
use crate::filter::{Filter, KIND_DOES_NOT_FIT, SubscriptionId, U64_RANGE_END, validate_filter};
use crate::validation::CREATED_AT_LIMIT;

/// The wire message kinds (`src/@types/messages.ts` `MessageType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum MessageType {
    Req,
    Event,
    Close,
    Notice,
    Eose,
    Ok,
    Count,
    Closed,
    Auth,
}

/// `["REQ", <subscription id>, <filters…>]` (`src/@types/messages.ts` `SubscribeMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscribeMessage {
    pub subscription_id: SubscriptionId,
    pub filters: Vec<Filter>,
}

/// `["COUNT", <subscription id>, <filters…>]` (`src/@types/messages.ts` `CountMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountMessage {
    pub subscription_id: SubscriptionId,
    pub filters: Vec<Filter>,
}

/// `["CLOSE", <subscription id>]` (`src/@types/messages.ts` `UnsubscribeMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsubscribeMessage {
    pub subscription_id: SubscriptionId,
}

/// `["AUTH", <event>]` (`src/@types/messages.ts` `AuthMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthMessage {
    pub event: Event,
}

/// `["NOTICE", <message>]` (`src/@types/messages.ts` `NoticeMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeMessage {
    pub message: String,
}

/// `["OK", <event id>, <accepted>, <message>, <params>?]` (`src/@types/messages.ts`
/// `CommandResult`). `params` is the NIP-01 optional slot the `rate-limited` backoff fills
/// (`createCommandResult`, `src/utils/messages.ts:31-37`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    pub event_id: EventId,
    pub accepted: bool,
    pub message: String,
    pub params: Option<String>,
}

/// `["CLOSED", <subscription id>, <message>, <params>?]` (`src/@types/messages.ts`
/// `ClosedMessage`), with the same optional slot (`createClosedMessage`,
/// `src/utils/messages.ts:45-47`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClosedMessage {
    pub subscription_id: SubscriptionId,
    pub message: String,
    pub params: Option<String>,
}

/// `["EOSE", <subscription id>]` (`src/@types/messages.ts` `EndOfStoredEventsNotice`,
/// NIP-15).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EoseMessage {
    pub subscription_id: SubscriptionId,
}

/// `["EVENT", <subscription id>, <event>]` (`src/@types/messages.ts` `OutgoingEventMessage`).
///
/// The event is shared: the hub hands one `Arc` to every connection and each matching
/// subscription clones the pointer, not the event, so a fan-out costs one increment per
/// receiver rather than a copy of the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingEventMessage {
    pub subscription_id: SubscriptionId,
    pub event: std::sync::Arc<Event>,
}

/// `["COUNT", <subscription id>, {"count": <number>}]` (`src/@types/messages.ts`
/// `CountResultMessage`, NIP-45).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CountResultMessage {
    pub subscription_id: SubscriptionId,
    pub count: u64,
}

/// The NIP-42 challenge a relay sends on connect (`src/@types/messages.ts`
/// `AuthChallengeMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthChallengeMessage {
    pub challenge: String,
}

/// A relay-signed event published by another relay (`src/@types/messages.ts` `IncomingRelayedEventMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayedEvent {
    pub event: Event,
    pub source: Pubkey,
}

/// A message a client sends, decoded (`src/@types/messages.ts` `IncomingMessage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    Event(Event),
    Subscribe(SubscribeMessage),
    Count(CountMessage),
    Unsubscribe(UnsubscribeMessage),
    Auth(AuthMessage),
}

impl ClientMessage {
    /// The verb's name, as the capture's `message[0]` switch reads it.
    pub fn message_type(&self) -> MessageType {
        match self {
            Self::Event(_) => MessageType::Event,
            Self::Subscribe(_) => MessageType::Req,
            Self::Count(_) => MessageType::Count,
            Self::Unsubscribe(_) => MessageType::Close,
            Self::Auth(_) => MessageType::Auth,
        }
    }
}

/// A message the relay sends (`src/@types/messages.ts` `OutgoingMessage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayMessage {
    Notice(NoticeMessage),
    Ok(CommandResult),
    Closed(ClosedMessage),
    Eose(EoseMessage),
    Event(OutgoingEventMessage),
    Count(CountResultMessage),
    Auth(AuthChallengeMessage),
}

impl RelayMessage {
    /// The frame's wire text: `JSON.stringify(message)` for the matching constructor of
    /// `src/utils/messages.ts:20-51`, byte for byte.
    pub fn to_text(&self) -> String {
        match self {
            Self::Notice(message) => frame("NOTICE", &[&quote(&message.message)]),
            Self::Ok(result) => match &result.params {
                Some(params) => frame(
                    "OK",
                    &[
                        &quote(&result.event_id.to_string()),
                        &result.accepted.to_string(),
                        &quote(&result.message),
                        &quote(params),
                    ],
                ),
                None => frame(
                    "OK",
                    &[
                        &quote(&result.event_id.to_string()),
                        &result.accepted.to_string(),
                        &quote(&result.message),
                    ],
                ),
            },
            Self::Closed(message) => match &message.params {
                Some(params) => frame(
                    "CLOSED",
                    &[
                        &quote(&message.subscription_id),
                        &quote(&message.message),
                        &quote(params),
                    ],
                ),
                None => frame(
                    "CLOSED",
                    &[&quote(&message.subscription_id), &quote(&message.message)],
                ),
            },
            Self::Eose(message) => frame("EOSE", &[&quote(&message.subscription_id)]),
            Self::Event(message) => event_frame(message),
            Self::Count(message) => frame(
                "COUNT",
                &[
                    &quote(&message.subscription_id),
                    &format!("{{\"count\":{}}}", message.count),
                ],
            ),
            Self::Auth(message) => frame("AUTH", &[&quote(&message.challenge)]),
        }
    }

    /// The message-level rate-limit frame (`createRateLimitedMessage`,
    /// `src/adapters/web-socket-adapter.ts:284-307`): reads are `CLOSED` with the backoff,
    /// everything else is the plain notice.
    pub fn rate_limited(
        verb: Option<MessageType>,
        subscription_id: Option<&str>,
        retry_after_ms: u64,
    ) -> Self {
        match (verb, subscription_id) {
            (Some(MessageType::Req | MessageType::Count), Some(subscription_id)) => {
                Self::Closed(ClosedMessage {
                    subscription_id: subscription_id.to_owned(),
                    message: "rate-limited: slow down".to_owned(),
                    params: Some(retry_after_ms.to_string()),
                })
            }
            _ => Self::Notice(NoticeMessage {
                message: "rate limited".to_owned(),
            }),
        }
    }
}

impl From<CommandResult> for RelayMessage {
    fn from(result: CommandResult) -> Self {
        Self::Ok(result)
    }
}

impl From<ClosedMessage> for RelayMessage {
    fn from(message: ClosedMessage) -> Self {
        Self::Closed(message)
    }
}

impl From<NoticeMessage> for RelayMessage {
    fn from(message: NoticeMessage) -> Self {
        Self::Notice(message)
    }
}

/// `["EVENT", <id>, <event>]` in one pass: the tuple serializes straight into the frame's
/// buffer, so the event's JSON is written once instead of into a `String` and then copied
/// into the frame.
fn event_frame(message: &OutgoingEventMessage) -> String {
    // Sized for one write: the fixed fields and both hex halves, the content as it stands
    // (escaping can grow it, and then the buffer grows once), and about one tag element.
    let mut buffer: Vec<u8> =
        Vec::with_capacity(512 + message.event.content.len() + 96 * message.event.tags.len());

    let written = serde_json::to_writer(
        &mut buffer,
        &("EVENT", &message.subscription_id, &*message.event),
    );

    match written {
        Ok(()) => String::from_utf8(buffer)
            .unwrap_or_else(|_| frame("EVENT", &[&quote(&message.subscription_id), "null"])),
        Err(_) => frame("EVENT", &[&quote(&message.subscription_id), "null"]),
    }
}

fn frame(verb: &str, parts: &[&str]) -> String {
    let mut text = format!("[{}", quote(verb));

    for part in parts {
        text.push(',');
        text.push_str(part);
    }

    text.push(']');
    text
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Why a client frame could not be decoded. The capture's adapter logs the message and
/// answers `["NOTICE", "invalid: <message>"]` (`web-socket-adapter.ts:234-240`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// `JSON.parse` rejected the text. V8's diagnosis is not reproducible; only the
    /// `invalid: ` prefix is compared (tolerance T1, ADR 0004).
    Json(String),
    /// The frame parsed but failed `messageSchema`; the message is the schema's first issue.
    Validation(String),
}

impl WireError {
    /// The text after `invalid: `.
    pub fn detail(&self) -> &str {
        match self {
            Self::Json(detail) | Self::Validation(detail) => detail,
        }
    }

    /// The NOTICE the capture sends (`invalid: ${error.message}`).
    pub fn notice(&self) -> String {
        format!("invalid: {}", self.detail())
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.detail())
    }
}

/// Decodes one client frame: `attemptValidation(messageSchema)(JSON.parse(text))`
/// (`src/schemas/message-schema.ts:46`, `web-socket-adapter.ts:199`).
pub fn decode(text: &str) -> Result<ClientMessage, WireError> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| WireError::Json(error.to_string()))?;

    let Value::Array(items) = value else {
        return Err(WireError::Validation("Invalid input".to_owned()));
    };

    let verb = items.first().and_then(Value::as_str);

    match verb {
        Some("EVENT") => {
            let event = items.get(1).ok_or_else(|| invalid("Invalid input"))?;
            let event = validate_event_value(event)?;

            exactly(&items, 2)?;

            Ok(ClientMessage::Event(event))
        }
        Some("REQ") => {
            let (subscription_id, filters) = decode_request(&items, "REQ")?;

            Ok(ClientMessage::Subscribe(SubscribeMessage {
                subscription_id,
                filters,
            }))
        }
        Some("COUNT") => {
            let (subscription_id, filters) = decode_request(&items, "COUNT")?;

            Ok(ClientMessage::Count(CountMessage {
                subscription_id,
                filters,
            }))
        }
        Some("CLOSE") => {
            let Value::String(subscription_id) = items.get(1).unwrap_or(&Value::Null) else {
                return Err(invalid("Invalid input"));
            };

            if subscription_id.is_empty() {
                return Err(invalid("String must contain at least 1 character(s)"));
            }

            exactly(&items, 2)?;

            Ok(ClientMessage::Unsubscribe(UnsubscribeMessage {
                subscription_id: subscription_id.clone(),
            }))
        }
        Some("AUTH") => {
            let event = items.get(1).ok_or_else(|| invalid("Invalid input"))?;
            let event = validate_event_value(event)?;

            exactly(&items, 2)?;

            Ok(ClientMessage::Auth(AuthMessage { event }))
        }
        _ => Err(invalid("Invalid input")),
    }
}

/// A fixed-arity client verb refuses a frame longer than its tuple: `EVENT`, `AUTH` and
/// `CLOSE` are `z.tuple`s with no `.rest()` (`src/schemas/message-schema.ts:8,56,59`), and
/// zod reports the tuple's `too_big` issue, whose message is this one. The lower bound stays
/// each arm's own `Invalid input` — what an aborted union answers for a missing element — so
/// this never reports one.
///
/// Call it after the arm's element checks: an element's own message answers before the length
/// one, which is what the capture's aborted union does, so `["CLOSE",42,"junk"]` stays
/// `Invalid input` while `["CLOSE","c1","junk"]` is refused here.
fn exactly(items: &[Value], expected: usize) -> Result<(), WireError> {
    if items.len() > expected {
        return Err(invalid(&format!(
            "Array must contain at most {expected} element(s)"
        )));
    }

    Ok(())
}

/// `reqMessageSchema`/`countMessageSchema`: the id, then one to eleven filters.
fn decode_request(items: &[Value], verb: &str) -> Result<(String, Vec<Filter>), WireError> {
    let Value::String(subscription_id) = items.get(1).unwrap_or(&Value::Null) else {
        return Err(invalid("Invalid input"));
    };

    let length = subscription_id.chars().count();

    if length == 0 {
        return Err(invalid("String must contain at least 1 character(s)"));
    }

    if length > 256 {
        return Err(invalid("String must contain at most 256 character(s)"));
    }

    if items.len() < 3 {
        return Err(invalid(&format!(
            "{verb} message must contain at least one filter"
        )));
    }

    if items.len() > 12 {
        return Err(invalid(&format!(
            "{verb} message must contain at most 12 elements"
        )));
    }

    let mut filters = Vec::with_capacity(items.len() - 2);

    for value in &items[2..] {
        match validate_filter(value) {
            Ok(filter) => filters.push(filter),
            Err(issues) => {
                let message = issues
                    .first()
                    .map(|issue| issue.message.clone())
                    .unwrap_or_else(|| "Invalid input".to_owned());

                return Err(invalid(&message));
            }
        }
    }

    Ok((subscription_id.clone(), filters))
}

/// `z.number().int().min(0)` for an event's numeric fields (`src/schemas/base-schema.ts:17`),
/// in zod's order: a fractional value answers `Expected integer, received float`, then a
/// negative one answers `Number must be greater than or equal to 0`. A zero-fraction float
/// spelling is the integer it denotes — JavaScript has no float/int distinction after
/// `JSON.parse`, so the capture admits `1700000000.0` — and a value that is not a number
/// aborts the union with `Invalid input`.
///
/// The value comes back as an `f64`; each caller bounds its own domain and casts only after
/// that check, which is what keeps the cast exact.
fn integer_value(number: &Number) -> Result<f64, WireError> {
    let Some(value) = number.as_f64() else {
        return Err(invalid("Invalid input"));
    };

    if value.fract() != 0.0 {
        return Err(invalid("Expected integer, received float"));
    }

    if value < 0.0 {
        return Err(invalid("Number must be greater than or equal to 0"));
    }

    Ok(value)
}

/// `eventSchema.parse` at the value level: the shape checks in field order, the `.strict()`
/// rule, and the kind-7/17/10002/geohash refinements of `src/schemas/event-schema.ts`.
///
/// The typed [`Event`] carries part of this in its field types (hex length and alphabet);
/// this pass reports the schema's own message for whatever is left, which is what the
/// NOTICE carries.
pub fn validate_event_value(value: &Value) -> Result<Event, WireError> {
    let Value::Object(object) = value else {
        return Err(invalid(&format!(
            "Expected object, received {}",
            json_type(value)
        )));
    };

    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "id" | "pubkey" | "created_at" | "kind" | "tags" | "content" | "sig"
        ) {
            return Err(invalid(&format!("Unrecognized key(s) in object: '{key}'")));
        }
    }

    validate_hex_field(object.get("id"), 64)?;
    validate_hex_field(object.get("pubkey"), 64)?;
    validate_hex_field(object.get("sig"), 128)?;

    // `id` and `pubkey` come back as `Result`s above; `sig` too. Rebuild the typed event
    // only once every field has a schema-clean value.
    let Some(id) = object.get("id").and_then(Value::as_str) else {
        return Err(invalid("Invalid input"));
    };
    let Some(pubkey) = object.get("pubkey").and_then(Value::as_str) else {
        return Err(invalid("Invalid input"));
    };
    let Some(sig) = object.get("sig").and_then(Value::as_str) else {
        return Err(invalid("Invalid input"));
    };
    let Some(content) = object.get("content").and_then(Value::as_str) else {
        return Err(invalid(&format!(
            "Expected string, received {}",
            json_type(object.get("content").unwrap_or(&Value::Null))
        )));
    };

    let created_at = match object.get("created_at") {
        Some(Value::Number(number)) => {
            let value = integer_value(number)?;

            if value >= CREATED_AT_LIMIT as f64 {
                return Err(invalid("Invalid timestamp"));
            }

            value as i64
        }
        other => {
            return Err(invalid(&format!(
                "Expected number, received {}",
                json_type(other.unwrap_or(&Value::Null))
            )));
        }
    };

    let kind = match object.get("kind") {
        Some(Value::Number(number)) => match number.as_u64() {
            Some(value) => crate::event::Kind(value),
            None => {
                let value = integer_value(number)?;

                if value >= U64_RANGE_END {
                    return Err(invalid(KIND_DOES_NOT_FIT));
                }

                crate::event::Kind(value as u64)
            }
        },
        other => {
            return Err(invalid(&format!(
                "Expected number, received {}",
                json_type(other.unwrap_or(&Value::Null))
            )));
        }
    };

    let tags = validate_tags(object.get("tags"))?;

    let event = Event {
        id: id
            .parse()
            .map_err(|error: crate::error::CoreError| invalid(&error.to_string()))?,
        pubkey: pubkey
            .parse()
            .map_err(|error: crate::error::CoreError| invalid(&error.to_string()))?,
        created_at,
        kind,
        tags,
        content: content.to_owned(),
        sig: sig
            .parse()
            .map_err(|error: crate::error::CoreError| invalid(&error.to_string()))?,
    };

    crate::validation::validate_event(&event)
        .map_err(|error| invalid(&strip_invalid_event(&error.to_string())))?;

    Ok(event)
}

fn validate_hex_field(value: Option<&Value>, length: usize) -> Result<(), WireError> {
    let Some(Value::String(text)) = value else {
        return Err(invalid(&format!(
            "Expected string, received {}",
            json_type(value.unwrap_or(&Value::Null))
        )));
    };

    if !text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        || text.is_empty()
    {
        return Err(invalid("Invalid"));
    }

    if text.chars().count() != length {
        return Err(invalid(&format!(
            "String must contain exactly {length} character(s)"
        )));
    }

    Ok(())
}

fn validate_tags(value: Option<&Value>) -> Result<Vec<Vec<String>>, WireError> {
    let Some(Value::Array(tags)) = value else {
        return Err(invalid(&format!(
            "Expected array, received {}",
            json_type(value.unwrap_or(&Value::Null))
        )));
    };

    let mut parsed = Vec::with_capacity(tags.len());

    for tag in tags {
        let Value::Array(elements) = tag else {
            return Err(invalid(&format!(
                "Expected array, received {}",
                json_type(tag)
            )));
        };

        if elements.is_empty() {
            return Err(invalid("Array must contain at least 1 element(s)"));
        }

        let mut parsed_tag = Vec::with_capacity(elements.len());

        for (index, element) in elements.iter().enumerate() {
            let Value::String(text) = element else {
                return Err(invalid(&format!(
                    "Expected string, received {}",
                    json_type(element)
                )));
            };

            if index == 0 && text.is_empty() {
                return Err(invalid("String must contain at least 1 character(s)"));
            }

            parsed_tag.push(text.clone());
        }

        parsed.push(parsed_tag);
    }

    Ok(parsed)
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `CoreError::InvalidEvent`'s prefix is an internal spelling; the schema message is the
/// text after it.
fn strip_invalid_event(message: &str) -> String {
    message
        .strip_prefix("invalid event: ")
        .unwrap_or(message)
        .to_owned()
}

fn invalid(message: &str) -> WireError {
    WireError::Validation(message.to_owned())
}
