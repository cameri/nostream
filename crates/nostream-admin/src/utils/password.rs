//! The password hash and the two comparison rules. Mirrors `src/utils/admin-password.ts`.
//!
//! The stored form is `scrypt:<16-byte salt, base64>:<key, base64>` with Node's scrypt
//! defaults — N=16384, r=8, p=1 — and the comparison is constant time over the stored key's
//! length, so a hash written with a different key length still verifies (Value 9).

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::error::AdminError;
use crate::utils::session::constant_time_eq;

/// The hash prefix (`SCRYPT_PREFIX`).
const SCRYPT_PREFIX: &str = "scrypt";

/// The salt length `hashAdminPassword` draws (`randomBytes(16)`).
pub const SALT_LENGTH: usize = 16;

/// The key length `hashAdminPassword` asks scrypt for (`scryptSync(password, salt, 64)`).
pub const KEY_LENGTH: usize = 64;

/// Node's scrypt cost parameters (`N = 2^14`, `r = 8`, `p = 1`).
fn params(key_length: usize) -> Result<scrypt::Params, AdminError> {
    scrypt::Params::new(14, 8, 1, key_length)
        .map_err(|error| AdminError::Internal(format!("scrypt parameters: {error}")))
}

/// `hashAdminPassword`: `scrypt:<salt b64>:<key b64>` for the given salt.
pub fn hash_admin_password(password: &str, salt: &[u8; SALT_LENGTH]) -> Result<String, AdminError> {
    let mut key = vec![0u8; KEY_LENGTH];
    scrypt::scrypt(password.as_bytes(), salt, &params(KEY_LENGTH)?, &mut key)
        .map_err(|error| AdminError::Internal(format!("scrypt: {error}")))?;
    Ok(format!(
        "{SCRYPT_PREFIX}:{}:{}",
        BASE64.encode(salt),
        BASE64.encode(key)
    ))
}

/// `verifyAdminPasswordHash`: a value that is not three colon parts with the `scrypt` prefix
/// is a failed login, never an error.
pub fn verify_admin_password_hash(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split(':').collect();
    if parts.len() != 3 || parts[0] != SCRYPT_PREFIX {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (BASE64.decode(parts[1]), BASE64.decode(parts[2])) else {
        return false;
    };
    if expected.is_empty() {
        return false;
    }
    let mut actual = vec![0u8; expected.len()];
    let Ok(params) = params(expected.len()) else {
        return false;
    };
    if scrypt::scrypt(password.as_bytes(), &salt, &params, &mut actual).is_err() {
        return false;
    }
    constant_time_eq(&expected, &actual)
}

/// `verifyPlaintextPassword`: the `ADMIN_PASSWORD` override's constant-time compare.
pub fn verify_plaintext_password(password: &str, expected: &str) -> bool {
    constant_time_eq(expected.as_bytes(), password.as_bytes())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const SALT: [u8; SALT_LENGTH] = [7u8; SALT_LENGTH];

    #[test]
    fn a_fixture_hash_verifies_and_a_wrong_password_does_not() {
        let hash = hash_admin_password("hunter2", &SALT).unwrap();
        assert!(hash.starts_with("scrypt:"));
        assert!(verify_admin_password_hash("hunter2", &hash));
        assert!(!verify_admin_password_hash("hunter3", &hash));
    }

    #[test]
    fn a_malformed_hash_is_a_failed_comparison() {
        assert!(!verify_admin_password_hash("hunter2", "scrypt:abcd"));
        assert!(!verify_admin_password_hash("hunter2", "argon2:abcd:ef"));
        assert!(!verify_admin_password_hash("hunter2", ""));
    }

    #[test]
    fn a_shorter_stored_key_still_verifies() {
        let salt = SALT;
        let mut key = vec![0u8; 32];
        scrypt::scrypt(
            b"hunter2",
            &salt,
            &scrypt::Params::new(14, 8, 1, 32).unwrap(),
            &mut key,
        )
        .unwrap();
        let stored = format!("scrypt:{}:{}", BASE64.encode(salt), BASE64.encode(key));
        assert!(verify_admin_password_hash("hunter2", &stored));
    }
}
