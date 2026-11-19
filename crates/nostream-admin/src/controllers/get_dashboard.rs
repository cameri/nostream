//! `GET <prefix>/admin/` and `/dashboard`: the console page with the template's six
//! placeholders substituted. Mirrors
//! `src/handlers/request-handlers/get-admin-dashboard-request-handler.ts`.

use std::sync::Arc;

use axum::Extension;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;

use crate::controllers::admin_enabled_middleware::Nonce;
use crate::controllers::request_context::RequestSettings;
use crate::controllers::with_admin_controller_request_handler::{HandlerError, HandlerResult};
use crate::state::AdminState;
use crate::utils::grafana;
use crate::utils::http::path_prefix_from_relay_url;

/// The capture's five HTML escapes (`escapeHtml`, `src/utils/html.ts:9-11`).
fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// Renders the page with every placeholder the template carries (`{{grafana_embed_url}}`
/// appears in no template: substituting it is optional and cannot change the output).
pub fn render(
    template: &str,
    name: &str,
    path_prefix: &str,
    nonce: &str,
    settings: &crate::state::GrafanaSettings,
) -> String {
    template
        .replace("{{name}}", &escape_html(name))
        .replace("{{path_prefix}}", &escape_html(path_prefix))
        .replace(
            "{{grafana_embed_url}}",
            &escape_html(&grafana::embed_url(settings)),
        )
        .replace(
            "{{grafana_url}}",
            &escape_html(&grafana::dashboard_url(settings)),
        )
        .replace("{{grafana_base_url}}", &escape_html(&settings.base_url))
        .replace(
            "{{grafana_dashboard_uid}}",
            &escape_html(&settings.dashboard_uid),
        )
        .replace("{{nonce}}", nonce)
}

pub async fn handle(
    State(state): State<Arc<AdminState>>,
    Extension(nonce): Extension<Nonce>,
    RequestSettings(settings): RequestSettings,
) -> HandlerResult {
    let path = state.dashboard_path();
    let template = std::fs::read_to_string(&path).map_err(|source| {
        HandlerError(crate::error::AdminError::Io {
            path: path.clone(),
            source,
        })
    })?;

    let prefix = path_prefix_from_relay_url(&settings.info.relay_url);
    let page = render(
        &template,
        &settings.info.name,
        &prefix,
        &nonce.0,
        state.grafana(),
    );

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf8")],
        page,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_substitutions_leave_no_placeholder_and_escape_html() {
        let template = "{{name}}|{{path_prefix}}|{{nonce}}|{{grafana_url}}";
        let settings = crate::state::GrafanaSettings::default();
        let rendered = render(template, "A & B <x>", "/nostr", "nonce-1", &settings);
        assert!(!rendered.contains("{{"));
        assert!(rendered.starts_with("A &amp; B &lt;x&gt;|/nostr|nonce-1|"));
    }
}
