//! Admin authentication. Mirrors `src/admin/password-admin-auth-provider.ts` and the
//! `src/utils/admin-{password,session}.ts` it composes.
//!
//! The provider's semantics, which are the capture's:
//!
//! - a non-empty `ADMIN_PASSWORD` wins as a constant-time plaintext compare (the daemon
//!   resolves the environment into [`AuthSettings::password_override`]; the crate reads none);
//! - otherwise `admin.passwordHash` in `scrypt:<salt>:<key>` form is verified with scrypt;
//! - an absent hash is a failed login, never a `500`;
//! - a missing `SECRET` is a `500` for minting and verifying, because a token cannot be signed
//!   or checked without the key.

use nostream_config::Settings;

use crate::error::AdminError;
use crate::utils::password::{
    hash_admin_password, verify_admin_password_hash, verify_plaintext_password,
};
use crate::utils::session;

/// The pieces of the settings and environment the provider needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthSettings {
    /// `ADMIN_PASSWORD`, when the environment carried a non-empty one.
    pub password_override: Option<String>,
    /// `admin.passwordHash`.
    pub password_hash: Option<String>,
    /// `admin.sessionTtlSeconds`.
    pub session_ttl_seconds: Option<u64>,
}

impl AuthSettings {
    /// Reads the block out of the loaded settings.
    pub fn from_settings(settings: &Settings, password_override: Option<&str>) -> Self {
        let admin = settings.admin.as_ref();
        Self {
            password_override: password_override
                .filter(|password| !password.is_empty())
                .map(str::to_owned),
            password_hash: admin
                .and_then(|admin| admin.password_hash.as_ref())
                .map(|hash| hash.expose().to_owned()),
            session_ttl_seconds: admin.and_then(|admin| admin.session_ttl_seconds),
        }
    }

    /// `verifyPassword`: the override first, then the hash.
    pub fn verify_password(&self, password: &str) -> bool {
        if let Some(override_password) = &self.password_override {
            return verify_plaintext_password(password, override_password);
        }
        match &self.password_hash {
            Some(hash) => verify_admin_password_hash(password, hash),
            None => false,
        }
    }

    /// The `ADMIN_PASSWORD` override, which wins over the hash (`verifyPassword`).
    pub fn password_override(&self) -> Option<&str> {
        self.password_override.as_deref()
    }

    /// The scrypt hash when one is configured, so the caller can run the work off-thread.
    pub fn password_hash(&self) -> Option<&str> {
        self.password_hash.as_deref()
    }

    /// The resolved session lifetime in whole seconds (Value 2).
    pub fn session_ttl(&self) -> u64 {
        session::resolve_ttl(self.session_ttl_seconds)
    }

    /// Mints the token for a session starting now.
    pub fn mint(
        &self,
        secret: Option<&[u8]>,
        now_seconds: i64,
    ) -> Result<(String, i64), AdminError> {
        let secret = secret.ok_or_else(|| {
            AdminError::Internal("the admin session signer has no SECRET".to_owned())
        })?;
        let expires_at = now_seconds + i64::try_from(self.session_ttl()).unwrap_or(i64::MAX);
        let token = session::create_token(&session::session_key(secret), expires_at);
        Ok((token, expires_at))
    }
}

/// `hashAdminPassword` over a fresh salt: the operator's tool for writing
/// `admin.passwordHash`.
pub fn hash_password(
    password: &str,
    salt: &[u8; crate::utils::password::SALT_LENGTH],
) -> Result<String, AdminError> {
    hash_admin_password(password, salt)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const SALT: [u8; 16] = [3u8; 16];

    #[test]
    fn the_override_wins_over_the_hash() {
        let settings = AuthSettings {
            password_override: Some("plain".to_owned()),
            password_hash: Some(hash_password("hashed", &SALT).unwrap()),
            session_ttl_seconds: None,
        };
        assert!(settings.verify_password("plain"));
        assert!(!settings.verify_password("hashed"));
    }

    #[test]
    fn an_empty_override_falls_through_to_the_hash() {
        let settings = AuthSettings {
            password_override: None,
            password_hash: Some(hash_password("hashed", &SALT).unwrap()),
            session_ttl_seconds: Some(60),
        };
        assert!(settings.verify_password("hashed"));
        assert_eq!(settings.session_ttl(), 60);
    }

    #[test]
    fn an_absent_hash_is_a_failed_login() {
        let settings = AuthSettings::default();
        assert!(!settings.verify_password("anything"));
        assert_eq!(
            settings.session_ttl(),
            session::DEFAULT_ADMIN_SESSION_TTL_SECONDS
        );
    }
}
