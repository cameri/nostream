//! `GET <prefix>/admin/settings/schema`: the guided catalogue with each field's `validate`
//! member stripped. Mirrors `src/controllers/admin/get-settings-schema-controller.ts`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use crate::controllers::admin_auth_middleware::Session;
use crate::controllers::admin_rate_limit_middleware::AdminRateLimited;
use crate::controllers::with_admin_controller_request_handler::{HandlerResult, json_response};
use crate::state::AdminState;

pub async fn handle(
    State(_state): State<Arc<AdminState>>,
    _limited: AdminRateLimited,
    _session: Session,
) -> HandlerResult {
    let categories: Vec<serde_json::Value> = nostream_config::guided::guided_setting_categories()
        .iter()
        .map(|category| {
            let settings: Vec<serde_json::Value> = category
                .settings
                .iter()
                .filter_map(|setting| serde_json::to_value(setting).ok())
                .map(|mut setting| {
                    if let serde_json::Value::Object(object) = &mut setting {
                        object.remove("validate");
                    }
                    setting
                })
                .collect();
            serde_json::json!({
                "value": category.value,
                "label": category.label,
                "settings": settings,
            })
        })
        .collect();

    Ok(json_response(
        StatusCode::OK,
        &serde_json::json!({ "categories": categories }),
    ))
}
