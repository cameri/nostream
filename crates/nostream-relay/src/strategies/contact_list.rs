//! The `contact-list` event strategy. Mirrors `src/handlers/event-strategies/contact-list-event-strategy.ts`.

use std::future::Future;
use std::pin::Pin;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::EventStrategy;

/// The `contact_list` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct ContactListStrategy;

impl EventStrategy for ContactListStrategy {
    /// Phase 2 stub — job 009; will upsert a kind-3 contact list and refresh the WoT graph (NIP-02); see `src/handlers/event-strategies/contact-list-event-strategy.ts`.
    fn execute<'a>(
        &'a self,
        _event: &'a Event,
        _context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async {
            Err(RelayError::NotImplemented {
                module: "relay::strategies::contact_list",
            })
        })
    }
}
