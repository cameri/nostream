//! The admin utils. Mirrors `src/utils/admin-{grafana,health,metrics,password,rate-limit,
//! session}.ts` (the settings-family exception, `admin-notifications-settings.ts`, belongs to
//! `nostream-config`), plus the request helpers of `src/utils/http.ts` and the ops helpers of
//! `src/utils/admin-ops-*.ts`.

pub mod diagnostics;
pub mod grafana;
pub mod health;
pub mod http;
pub mod metrics;
pub mod moderation;
pub mod nip05;
pub mod password;
pub mod rate_limit;
pub mod session;
pub mod status;
pub mod storage;
pub mod workers;
