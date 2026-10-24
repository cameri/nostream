//! The `unsubscribe-message-handler.ts` handler.
//!
//! A `CLOSE` removes the subscription, aborts its in-flight read, and emits **no frame**
//! (`:9-11`; measured: `CLOSE s1` → no frame).

use nostream_core::messages::UnsubscribeMessage;

use crate::handlers::HandlerContext;

/// The handler's entry point (`handleMessage`).
pub fn handle(message: UnsubscribeMessage, context: &HandlerContext) {
    context.connection.abort_read(&message.subscription_id);
    context.connection.unsubscribe(&message.subscription_id);
}
