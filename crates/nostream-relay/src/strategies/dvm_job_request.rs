//! The `dvm-job-request` event strategy. Mirrors
//! `src/handlers/event-strategies/dvm-job-request-event-strategy.ts`.
//!
//! A NIP-90 job request is stored and broadcast like any other event, and then the job row is
//! written so a worker can pick it up. That second write is best-effort: the event is already
//! stored and broadcast correctly, so a repository failure there must not reject a valid request.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `dvm_job_request` arm.
#[derive(Debug, Clone, Copy, Default)]
pub struct DvmJobRequestStrategy;

impl EventStrategy for DvmJobRequestStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let record = event_record(event, context);
            let count = context.stores.events.create(&record).await?;

            context.send_ok(event.id, true, if count > 0 { "" } else { "duplicate:" }, None);

            if count == 0 {
                return Ok(());
            }

            let _ = context.broadcast.send(Arc::new(event.clone()));

            if let Err(error) = context
                .stores
                .dvm_jobs
                .create(&event.id, &event.pubkey, event.kind)
                .await
            {
                tracing::error!(error = %error, event = %event.id, "unable to record dvm job");
            }

            Ok(())
        })
    }
}
