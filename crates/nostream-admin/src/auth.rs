//! Admin authentication. Mirrors `src/admin/password-admin-auth-provider.ts` and
//! `src/utils/admin-{password,session,rate-limit}.ts`.

use crate::error::AdminError;

/// The authentication provider the admin routes accept.
#[derive(Debug, Clone, Default)]
pub struct PasswordAuthProvider;

impl PasswordAuthProvider {
    /// Verifies a password against the configured hash.
    ///
    /// Phase 1 stub — job 005; will verify with argon2 and mint a session; see `src/admin/password-admin-auth-provider.ts`.
    pub async fn verify(_password: &str, _hash: &str) -> Result<(), AdminError> {
        Err(AdminError::NotImplemented {
            module: "admin::auth::PasswordAuthProvider::verify",
        })
    }
}

/// Issues a session token with the configured TTL.
///
/// Phase 1 stub — job 005; will mint and store a session; see `src/utils/admin-session.ts`.
pub fn issue_session(_ttl_seconds: u64) -> Result<String, AdminError> {
    Err(AdminError::NotImplemented {
        module: "admin::auth::issue_session",
    })
}
