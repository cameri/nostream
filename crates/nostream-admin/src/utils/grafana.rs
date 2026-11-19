//! The dashboard's Grafana links. Mirrors `src/utils/admin-grafana.ts`.
//!
//! `ADMIN_METRICS_SSE_INTERVAL_MS` and `GRAFANA_*` are resolved by the composition root into
//! [`crate::state::AdminStateConfig`]; this module only formats the URLs and applies the
//! capture's fallback rule, which is what a test pins.

use crate::state::GrafanaSettings;

/// `DEFAULT_GRAFANA_URL` (`src/utils/admin-grafana.ts:1`).
pub const DEFAULT_GRAFANA_URL: &str = "http://127.0.0.1:7777";

/// `DEFAULT_DASHBOARD_UID` (`src/utils/admin-grafana.ts:2`).
pub const DEFAULT_DASHBOARD_UID: &str = "nostream-overview";

/// `getGrafanaBaseUrl`: the configured value with trailing slashes dropped.
pub fn base_url(configured: Option<&str>) -> String {
    match configured.map(str::trim) {
        Some(value) if !value.is_empty() => value.trim_end_matches('/').to_owned(),
        _ => DEFAULT_GRAFANA_URL.to_owned(),
    }
}

/// `getGrafanaDashboardUid`: the configured value, else the shipped dashboard.
pub fn dashboard_uid(configured: Option<&str>) -> String {
    match configured.map(str::trim) {
        Some(value) if !value.is_empty() => value.to_owned(),
        _ => DEFAULT_DASHBOARD_UID.to_owned(),
    }
}

/// Resolves the two settings from the environment's shape.
pub fn settings(base_url: Option<&str>, dashboard_uid: Option<&str>) -> GrafanaSettings {
    GrafanaSettings {
        base_url: self::base_url(base_url),
        dashboard_uid: self::dashboard_uid(dashboard_uid),
    }
}

/// `getGrafanaDashboardUrl`.
pub fn dashboard_url(settings: &GrafanaSettings) -> String {
    format!(
        "{}/d/{}/nostream-overview?orgId=1&refresh=5s&theme=dark",
        settings.base_url, settings.dashboard_uid
    )
}

/// `getGrafanaEmbedUrl`: the dashboard URL with `&kiosk`.
pub fn embed_url(settings: &GrafanaSettings) -> String {
    format!("{}&kiosk", dashboard_url(settings))
}

/// `getGrafanaFrameOrigin`: the base URL's origin, falling back to the shipped one.
pub fn frame_origin(settings: &GrafanaSettings) -> String {
    let base = &settings.base_url;
    let Some(scheme_end) = base.find("://") else {
        return DEFAULT_GRAFANA_URL.to_owned();
    };
    let rest = &base[scheme_end + 3..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    format!("{}://{}", &base[..scheme_end], &rest[..host_end])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_defaults_are_the_shipped_ones() {
        let resolved = settings(None, None);
        assert_eq!(resolved.base_url, DEFAULT_GRAFANA_URL);
        assert_eq!(resolved.dashboard_uid, DEFAULT_DASHBOARD_UID);
        assert_eq!(
            dashboard_url(&resolved),
            "http://127.0.0.1:7777/d/nostream-overview/nostream-overview?orgId=1&refresh=5s&theme=dark"
        );
        assert_eq!(frame_origin(&resolved), "http://127.0.0.1:7777");
    }

    #[test]
    fn a_configured_url_loses_its_trailing_slashes() {
        let resolved = settings(Some("https://grafana.example/"), Some("custom"));
        assert_eq!(resolved.base_url, "https://grafana.example");
        assert_eq!(resolved.dashboard_uid, "custom");
        assert_eq!(frame_origin(&resolved), "https://grafana.example");
        assert_eq!(settings(Some("   "), None).base_url, DEFAULT_GRAFANA_URL);
    }
}
