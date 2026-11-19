//! The admin's two limiters. Mirrors `src/utils/admin-rate-limit.ts`, over the tree's shared
//! limiter (`nostream_relay::limits`) rather than a third store of its own (D14).
//!
//! Each window is counted per `<remote address>:admin-<scope>:<period>` — the capture's key —
//! so the admin and login scopes never share a counter, and each configured window is its own
//! counter. An address in `limits.admin.ipWhitelist` trips neither.

use nostream_config::Settings;
use nostream_relay::limits::RateLimitConfig;

use crate::state::AdminState;

/// Which limiter a route is behind (`scope` in `isAdminRateLimited`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitScope {
    /// `limits.admin.rateLimits`, key scope `admin`.
    Admin,
    /// `limits.admin.loginRateLimits`, key scope `login`.
    Login,
}

impl LimitScope {
    fn key_scope(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Login => "login",
        }
    }
}

/// Counts one hit against every window of `scope` and reports whether any is over its rate.
pub fn is_rate_limited(
    state: &AdminState,
    settings: &Settings,
    remote_address: &str,
    scope: LimitScope,
) -> bool {
    let admin_limits = settings
        .limits
        .as_ref()
        .and_then(|limits| limits.admin.as_ref());

    let Some(admin_limits) = admin_limits else {
        return false;
    };

    let windows = match scope {
        LimitScope::Admin => admin_limits.rate_limits.as_deref(),
        LimitScope::Login => admin_limits.login_rate_limits.as_deref(),
    };

    let Some(windows) = windows else {
        return false;
    };
    if windows.is_empty() {
        return false;
    }

    let whitelist = admin_limits.ip_whitelist.as_deref().unwrap_or_default();
    if whitelist.iter().any(|entry| entry == remote_address) {
        return false;
    }

    let mut limited = false;
    for window in windows {
        let key = format!(
            "{remote_address}:admin-{}:{}",
            scope.key_scope(),
            window.period
        );
        // Every window is counted even once one trips, so the capture's per-window counters
        // advance together.
        let config = RateLimitConfig {
            period_ms: window.period,
            rate: window.rate,
        };
        if state.hit_rate_limit(settings, &key, &config) {
            tracing::debug!(
                address = remote_address,
                rate = window.rate,
                period = window.period,
                scope = scope.key_scope(),
                "admin request rate limited"
            );
            limited = true;
        }
    }

    limited
}
