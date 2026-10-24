//! The `count-message-handler.ts` handler (NIP-45).

use nostream_core::filter::{count_filter_values, dedupe_filters};
use nostream_core::messages::CountResultMessage;
use nostream_core::nip42;
use nostream_core::{Filter, messages::CountMessage};

use crate::handlers::HandlerContext;

/// The handler's entry point (`handleMessage`, `:19-50`).
pub async fn handle(message: CountMessage, context: &HandlerContext) {
    let query_id = message.subscription_id;
    let count_enabled = context
        .settings
        .nip45
        .as_ref()
        .and_then(|nip45| nip45.enabled)
        .unwrap_or(true);

    if !count_enabled {
        context.send_closed(&query_id, "COUNT is disabled by relay configuration", None);
        return;
    }

    // Some clients send the same filter more than once.
    let filters = dedupe_filters(message.filters);

    if let Some(reason) = can_count(&query_id, &filters, context) {
        context.send_closed(&query_id, &reason, None);
        return;
    }

    match context.stores.events.count_by_filters(&filters).await {
        Ok(count) => {
            context
                .sink
                .send(&nostream_core::messages::RelayMessage::Count(
                    CountResultMessage {
                        subscription_id: query_id,
                        count,
                    },
                ));
        }
        Err(error) => {
            tracing::debug!(error = %error, "count request failed");
            // Keep this message generic so internal errors are not leaked to clients.
            context.send_closed(&query_id, "error: unable to count events", None);
        }
    }
}

/// `canCount` (`:54-78`).
fn can_count(query_id: &str, filters: &[Filter], context: &HandlerContext) -> Option<String> {
    let limits = context
        .settings
        .limits
        .as_ref()
        .and_then(|limits| limits.client.as_ref())
        .and_then(|client| client.subscription.as_ref());

    let max_filters = limits.and_then(|limits| limits.max_filters).unwrap_or(0);

    if max_filters > 0 && filters.len() as u64 > max_filters {
        return Some(format!(
            "Too many filters: Number of filters per count query must be less than or equal to {max_filters}"
        ));
    }

    let max_filter_values = limits
        .and_then(|limits| limits.max_filter_values)
        .unwrap_or(0);

    if max_filter_values > 0
        && filters
            .iter()
            .any(|filter| count_filter_values(filter) as u64 > max_filter_values)
    {
        return Some(format!(
            "Too many filter values: Number of values per filter must be less than or equal to {max_filter_values}"
        ));
    }

    if let Some(max_id_length) = limits.and_then(|limits| limits.max_subscription_id_length)
        && query_id.len() as u64 > max_id_length
    {
        return Some(format!(
            "Query ID too long: Query ID must be less than or equal to {max_id_length}"
        ));
    }

    // NIP-42: restricted-kind counts must be scoped to the client's own pubkeys.
    if !nip42::is_count_authorized(
        &context.restricted_read_kinds(),
        filters,
        &context.authenticated_pubkeys(),
    ) {
        return Some(
            "auth-required: authentication is required to count these event kinds".to_owned(),
        );
    }

    None
}
