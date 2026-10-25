//! The `auth-message-handler.ts` handler (NIP-42).

use nostream_core::messages::AuthMessage;
use nostream_core::nip42;

use crate::handlers::HandlerContext;

/// The handler's entry point (`handleMessage`, `:22-70`).
///
/// The seven outcomes are `nip42::authenticate`'s failures in the capture's order, then the
/// replay check, then `["OK",<id>,true,""]`. The challenge is never rotated by AUTH
/// (`web-socket-adapter.ts:186-196`).
///
/// It contains no `.await`, so it runs whole as the message's prefix, on the connection loop:
/// a restricted `REQ` behind this `AUTH` in the stream is judged against the session it
/// records.
pub fn handle(message: AuthMessage, context: &HandlerContext) {
    let event = message.event;
    let now = context.now_secs();
    let challenge = context.connection.challenge();
    let relay_url = context.relay_url().to_owned();

    match nip42::authenticate(&event, &challenge, &relay_url, now) {
        Ok(pubkey) => {
            if !context.connection.authenticate(pubkey, event.id, now) {
                context.send_ok(event.id, false, "invalid: auth event already used", None);
                return;
            }

            context.send_ok(event.id, true, "", None);
        }
        Err(failure) => {
            let reason = format!("invalid: {}", failure.message());

            context.send_ok(event.id, false, &reason, None);
        }
    }
}
