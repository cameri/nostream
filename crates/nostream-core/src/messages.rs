//! Client and relay wire messages. Mirrors `src/@types/messages.ts`.
//!
//! Phase 1 carries the typed payloads and the message-kind enum. Decoding a wire frame
//! (a positional array whose first element is the kind) is a Phase 2 concern: the parser
//! is a labelled stub, and no transport exists yet.

use serde::{Deserialize, Serialize};

use crate::event::{Event, EventId, Pubkey};
use crate::filter::{Filter, SubscriptionId};

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

/// `["OK", <event id>, <accepted>, <message>]` (`src/@types/messages.ts` `CommandResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandResult {
    pub event_id: EventId,
    pub accepted: bool,
    pub message: String,
}

/// `["CLOSED", <subscription id>, <message>]` (`src/@types/messages.ts` `ClosedMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClosedMessage {
    pub subscription_id: SubscriptionId,
    pub message: String,
}

/// A message a client sends (`src/@types/messages.ts` `IncomingMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ClientMessage {
    Event(Event),
    Subscribe(SubscribeMessage),
    Count(CountMessage),
    Close(UnsubscribeMessage),
    Auth(AuthMessage),
}

/// A message the relay sends (`src/@types/messages.ts` `OutgoingMessage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RelayMessage {
    Notice(NoticeMessage),
    Ok(CommandResult),
    Closed(ClosedMessage),
}

/// The NIP-42 challenge a relay sends on connect (`src/@types/messages.ts` `AuthChallengeMessage`).
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
