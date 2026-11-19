//! The per-request context the controllers share: the settings (loaded once per request and
//! cached in the extensions), the merged document, and the client's address and scheme.
//!
//! The capture reads `createSettings()` at every call site; this is the same per-request read,
//! deduplicated so a request that reaches three controllers reads the files once.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::StatusCode;
use axum::http::header;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use nostream_config::Settings;

use crate::controllers::with_admin_controller_request_handler::error_message;
use crate::state::AdminState;

/// The typed settings for one request (D8: read per request, not cached across requests).
#[derive(Clone)]
pub struct RequestSettings(pub Arc<Settings>);

/// The merged settings document and the defaults it was merged from.
#[derive(Clone)]
pub struct RequestDocument {
    pub merged: Arc<serde_yaml::Value>,
    pub defaults: Arc<serde_yaml::Value>,
}

impl FromRequestParts<Arc<AdminState>> for RequestSettings {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        if let Some(cached) = parts.extensions.get::<Self>() {
            return Ok(cached.clone());
        }
        let settings = state.settings().map_err(|error| {
            tracing::error!(error = %error, "the admin surface could not read the settings");
            error_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
        })?;
        let loaded = Self(Arc::new(settings));
        parts.extensions.insert(loaded.clone());
        Ok(loaded)
    }
}

impl FromRequestParts<Arc<AdminState>> for RequestDocument {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        if let Some(cached) = parts.extensions.get::<Self>() {
            return Ok(cached.clone());
        }
        let (merged, defaults) = state.merged_document().map_err(|error| {
            tracing::error!(error = %error, "the admin surface could not read the settings");
            error_message(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
        })?;
        crate::state::log_validation(&merged, &defaults);
        let loaded = Self {
            merged: Arc::new(merged),
            defaults: Arc::new(defaults),
        };
        parts.extensions.insert(loaded.clone());
        Ok(loaded)
    }
}

/// The client's address and whether the request arrived over TLS (Value 47, Value 49).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientInfo {
    pub address: String,
    pub secure: bool,
}

impl FromRequestParts<Arc<AdminState>> for ClientInfo {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AdminState>,
    ) -> Result<Self, Self::Rejection> {
        let RequestSettings(settings) = RequestSettings::from_request_parts(parts, state).await?;

        if let Some(cached) = parts.extensions.get::<Self>() {
            return Ok(cached.clone());
        }

        let socket_address = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(peer)| peer.ip().to_string())
            .unwrap_or_default();

        let trusted_proxies = settings.network.trusted_proxies.as_deref();
        let header_name = settings
            .network
            .remote_ip_header
            .as_deref()
            .map(str::to_ascii_lowercase);
        let header_address = header_name
            .as_ref()
            .and_then(|name| parts.headers.get(name))
            .and_then(|value| value.to_str().ok());
        let forwarded_proto = parts
            .headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok());

        let info = Self {
            address: crate::utils::http::remote_address(
                &socket_address,
                header_address,
                trusted_proxies,
            ),
            secure: crate::utils::http::is_secure_request(
                &socket_address,
                forwarded_proto,
                trusted_proxies,
            ),
        };
        parts.extensions.insert(info.clone());
        Ok(info)
    }
}

/// The `Not Found` body the disabled surface and an unknown path answer (R4).
pub fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain")],
        "Not Found",
    )
        .into_response()
}

/// A boolean query parameter the capture parses with `parseBoolean`: `true`/`false` only.
pub fn parse_bool_query(value: Option<&str>) -> Option<bool> {
    match value {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::Path;

    use nostream_config::{load_defaults, merge, validate_document};

    use super::*;

    #[test]
    fn the_defaults_document_validates_against_itself() {
        let defaults = load_defaults(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/default-settings.yaml"),
        )
        .unwrap();
        let merged = merge(&defaults, &serde_yaml::Value::Mapping(Default::default()));
        assert!(validate_document(&merged, &defaults).is_empty());
    }

    #[test]
    fn only_the_two_literals_are_booleans() {
        assert_eq!(parse_bool_query(Some("true")), Some(true));
        assert_eq!(parse_bool_query(Some("false")), Some(false));
        assert_eq!(parse_bool_query(Some("")), None);
        assert_eq!(parse_bool_query(Some("1")), None);
        assert_eq!(parse_bool_query(None), None);
    }
}
