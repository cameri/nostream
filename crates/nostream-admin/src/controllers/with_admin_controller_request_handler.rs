//! `withAdminController`: a handler's error becomes `500 {"error":"Internal Server Error"}`.
//!
//! Every controller returns [`HandlerResult`]; the wrapper is the [`IntoResponse`] of
//! [`HandlerError`], so no controller writes the failure body itself.

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::error::AdminError;

/// A controller failure, rendered as the capture's 500.
#[derive(Debug)]
pub struct HandlerError(pub AdminError);

impl From<AdminError> for HandlerError {
    fn from(error: AdminError) -> Self {
        Self(error)
    }
}

impl From<nostream_config::ConfigError> for HandlerError {
    fn from(error: nostream_config::ConfigError) -> Self {
        Self(AdminError::Config(error))
    }
}

impl From<nostream_storage::StorageError> for HandlerError {
    fn from(error: nostream_storage::StorageError) -> Self {
        Self(AdminError::Storage(error))
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        tracing::error!(error = %self.0, "admin request failed");
        error_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
    }
}

/// A controller result.
pub type HandlerResult = Result<Response, HandlerError>;

/// `{"error": "<message>"}` with `content-type: application/json`.
pub fn error_message(status: StatusCode, message: &str) -> Response {
    json_response(status, &json!({ "error": message }))
}

/// A JSON body with `content-type: application/json`.
pub fn json_response(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

/// A JSON body with `content-type: application/json` and one extra header.
pub fn json_response_with_header(
    status: StatusCode,
    body: &Value,
    name: header::HeaderName,
    value: &str,
) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json"), (name, value)],
        body.to_string(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_capture_s_messages_are_the_bodies() {
        let response = error_message(StatusCode::UNAUTHORIZED, "Unauthorized");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }
}
