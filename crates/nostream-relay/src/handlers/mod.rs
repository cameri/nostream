//! The five wire message handlers. Mirrors `src/handlers/*-message-handler.ts` at the capture
//! commit (the NIP-77 `neg-*` handlers are at the oracle, not here).

pub mod auth;
pub mod count;
pub mod event;
pub mod subscribe;
pub mod unsubscribe;

use nostream_core::Pubkey;

/// The context one socket shares across handlers (`src/@types/message-handlers.ts`).
#[derive(Debug, Clone, Default)]
pub struct HandlerContext {
    pub authenticated_pubkey: Option<Pubkey>,
    pub subscription_id: Option<String>,
}
