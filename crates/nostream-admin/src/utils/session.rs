//! The stateless session token. Mirrors `src/utils/admin-session.ts`.
//!
//! The token is `<expiresAt>.<hex of HMAC-SHA256(key, str(expiresAt))>` where the key is
//! `HMAC-SHA256(SECRET, "admin-session")`. There is no server-side revocation: validation is
//! the signature and the expiry, and the same token verifies after a restart.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::utils::http::join_path_prefix;

type HmacSha256 = Hmac<Sha256>;

/// `DEFAULT_ADMIN_SESSION_TTL_SECONDS` (`src/utils/admin-session.ts:8`).
pub const DEFAULT_ADMIN_SESSION_TTL_SECONDS: u64 = 86_400;

/// The cookie the console carries (`admin_session`).
pub const SESSION_COOKIE: &str = "admin_session";

/// The purpose string the session key is derived from.
pub const SESSION_KEY_PURPOSE: &str = "admin-session";

/// `hmacSha256(key, data)` (`src/utils/secret.ts:10-13`).
fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = match HmacSha256::new_from_slice(key) {
        Ok(mac) => mac,
        // HMAC accepts a key of any length, so this arm is unreachable; `new_from_slice` is
        // the only constructor and its error type carries no data.
        Err(_) => return Vec::new(),
    };
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// The session signing key: `HMAC-SHA256(SECRET, "admin-session")` (Value 35).
pub fn session_key(secret: &[u8]) -> Vec<u8> {
    hmac_sha256(secret, SESSION_KEY_PURPOSE.as_bytes())
}

/// A finite positive TTL in whole seconds, else the default (Value 2).
pub fn resolve_ttl(configured: Option<u64>) -> u64 {
    match configured {
        Some(ttl) if ttl > 0 => ttl,
        _ => DEFAULT_ADMIN_SESSION_TTL_SECONDS,
    }
}

/// `<expiresAt>.<hex signature>` (`createAdminSessionToken`).
pub fn create_token(key: &[u8], expires_at: i64) -> String {
    let signature = hmac_sha256(key, expires_at.to_string().as_bytes());
    format!("{expires_at}.{}", hex::encode(signature))
}

/// The `expiresAt` a token carries, without checking it (`parseAdminSessionToken`).
pub fn parse_token(token: &str) -> Option<i64> {
    let separator = token.find('.')?;
    if separator == 0 {
        return None;
    }
    exponent_or_integer(&token[..separator])
}

/// The capture reads the expiry with `Number(...)` (`admin-auth.ts`), so `1e3` is 1000; a
/// non-finite or fractional value is refused the way `Number.isFinite` refuses it.
fn exponent_or_integer(text: &str) -> Option<i64> {
    if let Ok(value) = text.parse::<i64>() {
        return Some(value);
    }
    let value = text.parse::<f64>().ok()?;
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    Some(value as i64)
}

/// Whether the token's signature verifies and it has not expired (`isValidAdminSessionToken`).
///
/// The signature is compared in constant time over equal-length byte strings; a non-hex or
/// wrong-length signature is rejected before the compare.
pub fn is_valid_token(key: &[u8], token: &str, now_seconds: i64) -> bool {
    let Some(separator) = token.find('.') else {
        return false;
    };
    if separator == 0 {
        return false;
    }
    let (expiry, signature) = token.split_at(separator);
    let signature = &signature[1..];
    let Some(expires_at) = exponent_or_integer(expiry) else {
        return false;
    };
    if expires_at <= now_seconds {
        return false;
    }
    if signature.is_empty()
        || !signature
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return false;
    }
    let expected = hex::encode(hmac_sha256(key, expires_at.to_string().as_bytes()));
    constant_time_eq(expected.as_bytes(), signature.as_bytes())
}

pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

/// The token from `Authorization: Bearer <token>` first, then the first `admin_session` cookie
/// (`getAdminSessionTokenFromRequest`, `src/utils/admin-session.ts:83-101`).
pub fn token_from_headers(authorization: Option<&str>, cookie: Option<&str>) -> Option<String> {
    if let Some(authorization) = authorization
        && let Some(token) = authorization.strip_prefix("Bearer ")
    {
        let token = token.trim();
        if !token.is_empty() {
            return Some(token.to_owned());
        }
    }

    let cookie = cookie?;
    for part in cookie.split(';') {
        let part = part.trim();
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if name == SESSION_COOKIE {
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.to_owned());
        }
    }
    None
}

/// `admin_session=<token>; Path=<prefix>/admin; HttpOnly; SameSite=Strict; Max-Age=<ttl>[; Secure]`
/// (`buildAdminSessionCookieHeader`).
pub fn cookie_header(prefix: &str, token: &str, max_age_seconds: u64, secure: bool) -> String {
    let path = join_path_prefix(prefix, "/admin");
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE}={token}; Path={path}; HttpOnly; SameSite=Strict; Max-Age={max_age_seconds}{secure}"
    )
}

/// The clearing cookie (`buildAdminSessionClearCookieHeader`).
pub fn clear_cookie_header(prefix: &str, secure: bool) -> String {
    let path = join_path_prefix(prefix, "/admin");
    let secure = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE}=; Path={path}; HttpOnly; SameSite=Strict; Max-Age=0{secure}")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    const SECRET: &[u8] = b"a-test-secret";
    const NOW: i64 = 1_700_000_000;

    #[test]
    fn a_minted_token_verifies_until_it_expires() {
        let key = session_key(SECRET);
        let token = create_token(&key, NOW + 60);
        assert!(is_valid_token(&key, &token, NOW));
        assert!(!is_valid_token(&key, &token, NOW + 60));
    }

    #[test]
    fn another_secret_does_not_verify() {
        let token = create_token(&session_key(SECRET), NOW + 60);
        assert!(!is_valid_token(&session_key(b"other"), &token, NOW));
    }

    #[test]
    fn a_short_or_non_hex_signature_is_rejected() {
        let key = session_key(SECRET);
        assert!(!is_valid_token(
            &key,
            &format!("{}.deadbeef", NOW + 60),
            NOW
        ));
        assert!(!is_valid_token(
            &key,
            &format!("{}.{}", NOW + 60, "z".repeat(64)),
            NOW
        ));
        assert!(!is_valid_token(&key, "no-separator", NOW));
        assert!(!is_valid_token(&key, ".abc", NOW));
    }

    #[test]
    fn the_token_comes_from_the_bearer_header_first() {
        assert_eq!(
            token_from_headers(Some("Bearer abc.def"), Some("admin_session=zzz")),
            Some("abc.def".to_owned())
        );
        assert_eq!(
            token_from_headers(None, Some("other=1; admin_session=zzz; x=2")),
            Some("zzz".to_owned())
        );
        assert_eq!(token_from_headers(None, Some("admin_session=;")), None);
        assert_eq!(token_from_headers(None, None), None);
    }

    #[test]
    fn the_cookie_carries_the_prefix_and_the_secure_flag() {
        assert_eq!(
            cookie_header("/nostr", "t", 60, true),
            "admin_session=t; Path=/nostr/admin; HttpOnly; SameSite=Strict; Max-Age=60; Secure"
        );
        assert_eq!(
            clear_cookie_header("", false),
            "admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0"
        );
    }

    #[test]
    fn a_ttl_of_zero_falls_back_to_the_default() {
        assert_eq!(resolve_ttl(None), DEFAULT_ADMIN_SESSION_TTL_SECONDS);
        assert_eq!(resolve_ttl(Some(0)), DEFAULT_ADMIN_SESSION_TTL_SECONDS);
        assert_eq!(resolve_ttl(Some(1)), 1);
    }
}
