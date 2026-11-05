//! The real NIP-47 transport: opens the relay named in `NWC_URL`, publishes a kind-23194
//! request (NIP-04 encrypted, which is what NIP-47 specifies), and waits for the
//! kind-23195 reply correlated by the request's id.
//!
//! The reply's encryption follows the same NIP-04 the capture's `@getalby/sdk` client uses
//! (ADR 0010's assumption A23).

use std::pin::Pin;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use nostream_core::crypto::{compute_event_id, sign_event, verify_event_signature};
use nostream_core::event::{Event, EventId, Kind, Pubkey, Signature};
use nostream_core::nip04;
use nostream_core::random::{RandomSource, SystemRandom};

use crate::error::ServicesError;
use crate::payments::processors::nwc::{Nip47Request, Nip47Response, Nip47Transport};
use crate::payments::uuid_v4;

/// Kind 23194, a NIP-47 request (`EventKinds.NWC_REQUEST`).
const NWC_REQUEST_KIND: Kind = Kind(23_194);

/// The transport a configured `NWC_URL` builds.
pub struct NwcRelayTransport {
    relay: String,
    wallet: Pubkey,
    secret: [u8; 32],
    random: Arc<dyn RandomSource>,
}

impl NwcRelayTransport {
    /// Parses `nostr+walletconnect://<wallet pubkey>?relay=<url>&secret=<hex>`.
    pub fn new(nwc_url: &str) -> Result<Self, ServicesError> {
        let rest = nwc_url
            .strip_prefix("nostr+walletconnect://")
            .or_else(|| nwc_url.strip_prefix("nostrwalletconnect://"))
            .ok_or_else(|| {
                ServicesError::Configuration(
                    "NWC_URL must be a valid nostr+walletconnect:// or nostrwalletconnect:// URI."
                        .to_owned(),
                )
            })?;
        let (wallet, query) = rest.split_once('?').ok_or_else(|| {
            ServicesError::Configuration("NWC_URL is not parseable as a URL.".to_owned())
        })?;

        let wallet = wallet
            .trim_end_matches('/')
            .parse::<Pubkey>()
            .map_err(|error| ServicesError::Configuration(format!("NWC_URL wallet: {error}")))?;

        let mut relay = None;
        let mut secret = None;

        for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
            match name.as_ref() {
                "relay" => relay = Some(value.into_owned()),
                "secret" => secret = Some(value.into_owned()),
                _ => {}
            }
        }

        let relay = relay.ok_or_else(|| {
            ServicesError::Configuration("NWC_URL has no relay parameter.".to_owned())
        })?;
        let secret = secret.ok_or_else(|| {
            ServicesError::Configuration("NWC_URL has no secret parameter.".to_owned())
        })?;
        let secret: [u8; 32] = hex::decode(secret)
            .map_err(|error| ServicesError::Configuration(format!("NWC_URL secret: {error}")))?
            .try_into()
            .map_err(|secret: Vec<u8>| {
                ServicesError::Configuration(format!(
                    "NWC_URL secret must be 32 bytes, got {}",
                    secret.len()
                ))
            })?;

        Ok(Self {
            relay,
            wallet,
            secret,
            random: Arc::new(SystemRandom),
        })
    }
}

/// Whether the reply's id is the one its own fields hash to and the wallet's signature is over
/// it. A relay can restate `pubkey`; only the signature binds the event to the wallet.
fn is_authentic(event: &Event) -> bool {
    compute_event_id(event).is_ok_and(|id| id == event.id) && verify_event_signature(event).is_ok()
}

impl Nip47Transport for NwcRelayTransport {
    fn request<'a>(
        &'a self,
        request: &'a Nip47Request,
    ) -> Pin<Box<dyn Future<Output = Result<Nip47Response, ServicesError>> + Send + 'a>> {
        Box::pin(async move {
            let (mut socket, _) = tokio_tungstenite::connect_async(self.relay.as_str())
                .await
                .map_err(|error| {
                    ServicesError::Payment(format!("NWC relay connect failed: {error}"))
                })?;

            let subscription_id = uuid_v4(self.random.as_ref())?;
            let payload = serde_json::json!({
                "method": request.method,
                "params": request.params,
            });
            let iv: [u8; 16] = self
                .random
                .bytes(16)
                .map_err(|error| ServicesError::Payment(error.to_string()))?
                .try_into()
                .map_err(|_| ServicesError::Payment("NWC iv".to_owned()))?;
            let content = nip04::encrypt(&self.secret, &self.wallet, &payload.to_string(), &iv)
                .map_err(|error| ServicesError::Payment(error.to_string()))?;

            let mut event = Event {
                id: EventId::from_byte_array([0; 32]),
                pubkey: self.wallet,
                created_at: chrono::Utc::now().timestamp(),
                kind: NWC_REQUEST_KIND,
                tags: vec![vec!["p".to_owned(), self.wallet.to_string()]],
                content,
                sig: Signature::from_byte_array([0; 64]),
            };
            sign_event(&self.secret, &mut event)
                .map_err(|error| ServicesError::Payment(error.to_string()))?;

            // The reply's link back to this request: NIP-47 answers with an `e` tag, and the
            // decrypted payload carries no id of its own.
            let request_id = event.id.to_string();
            let subscription = format!("nwc-{subscription_id}");
            let event_frame = serde_json::json!(["EVENT", event]);
            let subscription_filter = serde_json::json!({
                "kinds": [23_195],
                "authors": [self.wallet.to_string()],
                "#e": [request_id.as_str()],
                "limit": 1,
            });
            let request_frame = serde_json::json!(["REQ", subscription, subscription_filter]);

            for frame in [event_frame, request_frame] {
                socket
                    .send(Message::Text(frame.to_string().into()))
                    .await
                    .map_err(|error| {
                        ServicesError::Payment(format!("NWC relay write failed: {error}"))
                    })?;
            }

            loop {
                let Some(message) = socket.next().await else {
                    return Err(ServicesError::Payment(
                        "NWC relay closed before a reply".to_owned(),
                    ));
                };
                let message = message.map_err(|error| {
                    ServicesError::Payment(format!("NWC relay read failed: {error}"))
                })?;
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    Message::Close(_) => {
                        return Err(ServicesError::Payment(
                            "NWC relay closed before a reply".to_owned(),
                        ));
                    }
                    Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                };
                let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let Some(parts) = frame.as_array() else {
                    continue;
                };

                match parts.first().and_then(serde_json::Value::as_str) {
                    Some("EVENT") => {
                        let Some(reply) = parts.get(2) else {
                            continue;
                        };
                        let Ok(reply) = serde_json::from_value::<Event>(reply.clone()) else {
                            continue;
                        };
                        // `pubkey` is a field the relay writes, and `Event` deserializes
                        // unchecked: without this, a relay can restate the wallet and replay
                        // an earlier ciphertext under the current request's `e` tag. A genuine
                        // reply is signed by the wallet, and its id covers its own tags.
                        if reply.pubkey != self.wallet || !is_authentic(&reply) {
                            continue;
                        }

                        // NIP-47 correlates the reply by the request's `e` tag: the decrypted
                        // payload carries `result_type`, `result` and `error`, never an `id`.
                        // `@getalby/sdk` matches the same tag.
                        let correlated = reply.tags.iter().any(|tag| {
                            tag.first().map(String::as_str) == Some("e")
                                && tag.get(1).is_some_and(|value| *value == request_id)
                        });

                        if !correlated {
                            continue;
                        }

                        let decrypted = nip04::decrypt(&self.secret, &self.wallet, &reply.content)
                            .map_err(|error| ServicesError::Payment(error.to_string()))?;
                        let document: serde_json::Value = serde_json::from_str(&decrypted)
                            .map_err(|error| ServicesError::Payment(error.to_string()))?;

                        if let Some(error) = document.get("error").filter(|error| !error.is_null())
                        {
                            let message = error
                                .get("message")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("wallet error");
                            let code = error
                                .get("code")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("");
                            return Err(ServicesError::Payment(format!("{code}: {message}")));
                        }

                        let result = document.get("result").cloned().ok_or_else(|| {
                            ServicesError::Payment("NWC reply has no result".to_owned())
                        })?;

                        return Ok(Nip47Response { result });
                    }
                    Some("CLOSED") => {
                        return Err(ServicesError::Payment(
                            "NWC relay closed the subscription".to_owned(),
                        ));
                    }
                    Some("NOTICE") => {
                        let message = parts
                            .get(1)
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("relay notice");
                        return Err(ServicesError::Payment(message.to_owned()));
                    }
                    _ => continue,
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const WALLET_SECRET: [u8; 32] = [7; 32];
    const OTHER_SECRET: [u8; 32] = [8; 32];

    fn reply() -> Event {
        let mut event = Event {
            id: EventId::from_byte_array([0; 32]),
            pubkey: Pubkey::from_byte_array([0; 32]),
            created_at: 1_700_000_000,
            kind: Kind(23_195),
            tags: vec![vec!["e".to_owned(), "00".repeat(32)]],
            content: "ciphertext".to_owned(),
            sig: Signature::from_byte_array([0; 64]),
        };
        sign_event(&WALLET_SECRET, &mut event).expect("the wallet signs");

        event
    }

    #[test]
    fn an_authentic_reply_is_accepted() {
        assert!(is_authentic(&reply()));
    }

    /// The relay writes the `pubkey` field; only the signature binds the event to the wallet.
    #[test]
    fn a_reply_that_only_claims_the_wallet_is_refused() {
        let mut restated = reply();
        restated.pubkey = nostream_core::crypto::public_key(&OTHER_SECRET).expect("a pubkey");

        assert!(!is_authentic(&restated));
    }

    /// The id can be right while the signature is somebody else's, so the signature check has
    /// to run on its own: this is the replay a hostile relay would build.
    #[test]
    fn a_reply_with_the_right_id_and_a_foreign_signature_is_refused() {
        let authentic = reply();
        let mut foreign = authentic.clone();
        foreign.tags = Vec::new();
        sign_event(&OTHER_SECRET, &mut foreign).expect("another key signs");

        let mut forged = authentic.clone();
        forged.sig = foreign.sig;

        assert_eq!(
            compute_event_id(&forged).expect("the id hashes"),
            forged.id,
            "the id is this event's own, so only the signature can reject it"
        );
        assert!(!is_authentic(&forged));
    }
}
