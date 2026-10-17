//! `nostream-config` owns the settings family: the typed schema, the loader, the deep merge,
//! the validator (with the capture's exact issue strings), the dot-path editor, secret
//! redaction, the guided editor catalogue and the admin-notification merge.
//!
//! It owns these TypeScript paths from the capture commit
//! (`242a3001d77149e4d70151ec03060c4ef44a1547`):
//!
//! - `src/@types/settings.ts`, `src/@types/operator-notifications.ts`
//! - `src/utils/settings.ts`, `src/utils/settings-config.ts`, `src/utils/settings-paths.ts`,
//!   `src/utils/settings-redaction.ts`, `src/utils/settings-guided-schema.ts`,
//!   `src/utils/admin-notifications-settings.ts`
//! - `src/factories/settings-factory.ts` (its `new SettingsStatic()` wiring becomes
//!   [`load`], since the daemon owns the loaded value)
//!
//! Deliberately **not** in this crate (named so an omission is not mistaken for a gap):
//! `saveSettings`, `appendSettingsAuditLog`, `listSettingsBackups`, `restoreSettingsBackup`,
//! `filterSettingsAgainstDefaults` and `watchSettings` (filesystem hot reload) belong to the
//! admin job and the daemon's reload loop. The NIP-77 settings surface (`nip77` defaults, the
//! `relay_url` protocol rule) is deferred with the five-file forward port from `041fe34e`;
//! this crate models exactly what this branch's tree contains.

mod error;
pub mod guided;
mod issue;
pub mod load;
pub mod notifications;
pub mod path;
pub mod paths;
pub mod redaction;
pub mod settings;
pub mod validate;
pub mod value;

pub use error::ConfigError;
pub use issue::Issue;
pub use load::{LoadOutcome, load, load_defaults, load_document, load_user_settings, merge};
pub use paths::SettingsPaths;
pub use settings::Settings;
pub use validate::{validate, validate_document};
