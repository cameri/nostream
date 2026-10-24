//! The `report` event strategy. Mirrors `src/handlers/event-strategies/report-event-strategy.ts`.
//!
//! A NIP-56 report is stored and broadcast like any other event; everything after that is one
//! best-effort block. When `nip56` is on, the reporter is scored — a trusted moderator at full
//! weight without consulting the graph at all, everyone else by web-of-trust distance — one row
//! is written per extracted target in a single batch, and a target a moderator's report makes
//! actionable is marked in the hidden-content mirror so existing subscribers stop receiving it.
//! A failure anywhere in that block never rejects the report.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use nostream_core::Event;
use nostream_core::nip56::extract_report_targets;
use nostream_core::report_scoring::score_reporter;
use nostream_storage::repositories::{ActionableTarget, NewReport};

use crate::error::RelayError;
use crate::handlers::HandlerContext;
use crate::strategies::{EventStrategy, event_record};

/// The `report` arm: kind 1984.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReportStrategy;

impl EventStrategy for ReportStrategy {
    fn execute<'a>(
        &'a self,
        event: &'a Event,
        context: &'a HandlerContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), RelayError>> + Send + 'a>> {
        Box::pin(async move {
            let record = event_record(event, context);
            let count = context.stores.events.create(&record).await?;

            context.send_ok(
                event.id,
                true,
                if count > 0 { "" } else { "duplicate:" },
                None,
            );

            if count == 0 {
                return Ok(());
            }

            let _ = context.broadcast.send(Arc::new(event.clone()));

            if let Err(error) = record_report(event, context).await {
                tracing::error!(
                    error = %error,
                    event = %event.id,
                    "unable to record report"
                );
            }

            Ok(())
        })
    }
}

/// The NIP-56 block (`report-event-strategy.ts:41-95`), best-effort as one unit.
async fn record_report(event: &Event, context: &HandlerContext) -> Result<(), RelayError> {
    let Some(nip56) = context
        .settings
        .nip56
        .as_ref()
        .filter(|nip56| nip56.enabled)
    else {
        return Ok(());
    };

    let pubkey = event.pubkey.to_string();
    let is_trusted_moderator = nip56
        .trusted_moderators
        .iter()
        .any(|moderator| moderator.0 == pubkey);

    // A moderator's weight does not depend on distance, and the lookup can trigger a full
    // graph rebuild, so it is skipped for them.
    let distance = if is_trusted_moderator {
        None
    } else {
        context.wot.get_distance(&event.pubkey).await?
    };

    let weight = score_reporter(distance, is_trusted_moderator).weight();

    let reports: Vec<NewReport> = extract_report_targets(&event.tags)
        .into_iter()
        .filter(|target| target.reported_pubkey.is_some() || target.reported_event_id.is_some())
        .map(|target| NewReport {
            event_id: event.id,
            reporter_pubkey: event.pubkey,
            reported_pubkey: target.reported_pubkey,
            reported_event_id: target.reported_event_id,
            report_type: target.report_type.into(),
            weight,
            actionable: is_trusted_moderator,
        })
        .collect();

    if reports.is_empty() {
        return Ok(());
    }

    context.stores.reports.create_many(&reports).await?;

    // Keeps the live fan-out in step with what a fresh REQ would now exclude.
    if is_trusted_moderator && nip56.hide_actionable_reports {
        for report in &reports {
            context.hidden.mark_actionable_target(&ActionableTarget {
                reported_pubkey: report.reported_pubkey,
                reported_event_id: report.reported_event_id,
            });
        }
    }

    Ok(())
}
