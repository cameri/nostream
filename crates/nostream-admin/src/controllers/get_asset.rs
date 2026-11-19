//! `GET <prefix>/admin/assets/<file>`: the console's seven static files, byte-identically.
//! Mirrors `express.static('./resources/admin/assets')` (`src/routes/admin/index.ts:48`).
//!
//! The name is resolved inside the assets directory and nowhere else: a `..` component, a path
//! separator, a leading dot or an unknown name is a `404` with no file read (Value 45), so a
//! request can never reach `dashboard.html` or anything above the assets directory.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use crate::controllers::request_context::not_found;
use crate::controllers::with_admin_controller_request_handler::HandlerResult;
use crate::state::AdminState;

/// The content type of an asset name, by extension (`express.static`'s `mime` table for the
/// types this directory holds).
pub fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.') {
        Some((_, "js")) => "text/javascript; charset=utf-8",
        Some((_, "css")) => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Whether `name` is one file in the assets directory and nothing else. The query string is
/// already gone: the path is what follows `/assets/`.
pub fn is_servable(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    Path(name): Path<String>,
) -> HandlerResult {
    if !is_servable(&name) {
        return Ok(not_found());
    }
    let path = state.assets_dir().join(&name);
    match std::fs::read(&path) {
        Ok(bytes) => Ok((
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type(&name))],
            bytes,
        )
            .into_response()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(not_found()),
        Err(source) => {
            tracing::warn!(error = %source, name, "an admin asset could not be read");
            Ok(not_found())
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn only_a_bare_file_name_is_servable() {
        assert!(is_servable("dashboard.js"));
        assert!(is_servable("dashboard.css"));
        assert!(!is_servable(""));
        assert!(!is_servable("../dashboard.html"));
        assert!(!is_servable("a/b.js"));
        assert!(!is_servable("a\\b.js"));
        assert!(!is_servable(".env"));
    }

    #[test]
    fn the_two_extensions_have_the_browser_s_types() {
        assert_eq!(
            content_type("dashboard.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("dashboard.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("README"), "application/octet-stream");
    }
}
