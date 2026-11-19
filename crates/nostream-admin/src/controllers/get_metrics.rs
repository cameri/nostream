//! `GET <prefix>/admin/metrics`: the SSE stream D5 decides the payload of. Mirrors
//! `src/controllers/admin/get-metrics-controller.ts`'s transport — one frame immediately, then
//! one per interval until the client disconnects.

use std::convert::Infallible;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::stream::unfold;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::state::AdminState;

/// `data: <json>\n\n` — the frame the console's `EventSource` reads.
fn frame(snapshot: &serde_json::Value) -> Bytes {
    Bytes::from(format!("data: {snapshot}\n\n"))
}

async fn snapshot(state: &AdminState) -> Bytes {
    let health = crate::utils::health::collect(state).await;
    frame(&crate::utils::metrics::unavailable_snapshot(
        state.clock().now_ms(),
        &health,
    ))
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
) -> Response {
    let first = snapshot(&state).await;

    let stream = unfold(
        (Some(first), Arc::clone(&state)),
        |(pending, state)| async move {
            let bytes = match pending {
                Some(bytes) => bytes,
                None => {
                    tokio::time::sleep(state.metrics_interval()).await;
                    snapshot(&state).await
                }
            };
            Some((Ok::<Bytes, Infallible>(bytes), (None, state)))
        },
    );

    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "text/event-stream; charset=utf-8".to_owned(),
            ),
            (header::CACHE_CONTROL, "no-cache, no-transform".to_owned()),
            (header::CONNECTION, "keep-alive".to_owned()),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}
