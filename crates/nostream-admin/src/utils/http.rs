//! The request-facing helpers: the path prefix, the client address, the secure-request test
//! and the cookie path join. Mirrors `src/utils/http.ts`.

/// The public mount prefix: the path of `info.relay_url`, trailing slashes dropped, `''` for
/// `/` (`getRelayUrlPathPrefix`, `src/utils/http.ts:96-118`).
///
/// `X-Forwarded-Prefix` is **not** honoured (D10): the mount point is fixed when the router is
/// built, so a per-request prefix could move the page's script URLs away from the routes.
pub fn path_prefix_from_relay_url(relay_url: &str) -> String {
    let Some(scheme_end) = relay_url.find("://") else {
        return String::new();
    };
    let rest = &relay_url[scheme_end + 3..];
    let Some(path_start) = rest.find('/') else {
        return String::new();
    };
    let path = &rest[path_start..];
    normalize_prefix(path)
}

fn normalize_prefix(candidate: &str) -> String {
    let prefix = candidate.split(',').next().unwrap_or("").trim();
    if !prefix.starts_with('/') || prefix.starts_with("//") {
        return String::new();
    }
    let without_query = prefix.split(['?', '#']).next().unwrap_or("");
    let normalized = without_query.trim_end_matches('/');
    if normalized == "/" || normalized.is_empty() {
        String::new()
    } else {
        normalized.to_owned()
    }
}

/// Strips the IPv4-mapped prefix the way the capture's `normalizeIpAddress` does.
fn normalize_ip_address(input: &str) -> &str {
    input.strip_prefix("::ffff:").unwrap_or(input)
}

/// Whether `address` is in `network.trustedProxies` (`isTrustedProxy`).
pub fn is_trusted_proxy(address: &str, trusted_proxies: Option<&[String]>) -> bool {
    let Some(trusted_proxies) = trusted_proxies else {
        return false;
    };
    if trusted_proxies.is_empty() {
        return false;
    }
    let normalized = normalize_ip_address(address);
    trusted_proxies
        .iter()
        .any(|proxy| normalize_ip_address(proxy) == normalized)
}

/// The client address, honouring `network.remoteIpHeader` from a trusted peer only
/// (`getRemoteAddress`, `src/utils/http.ts:40-90`). The last hop wins.
pub fn remote_address(
    socket_address: &str,
    header_address: Option<&str>,
    trusted_proxies: Option<&[String]>,
) -> String {
    if is_trusted_proxy(socket_address, trusted_proxies)
        && let Some(header_address) = header_address
    {
        let hops: Vec<&str> = header_address
            .split(',')
            .map(str::trim)
            .filter(|hop| !hop.is_empty())
            .collect();
        if let Some(last) = hops.last() {
            return (*last).to_owned();
        }
    }
    socket_address.to_owned()
}

/// Whether the request arrived over TLS, from a trusted peer's `x-forwarded-proto`
/// (`isSecureRequest`, `src/utils/http.ts:120-135`).
pub fn is_secure_request(
    socket_address: &str,
    forwarded_proto: Option<&str>,
    trusted_proxies: Option<&[String]>,
) -> bool {
    if !is_trusted_proxy(socket_address, trusted_proxies) {
        return false;
    }
    let Some(forwarded_proto) = forwarded_proto else {
        return false;
    };
    forwarded_proto
        .split(',')
        .next()
        .map(|value| value.trim().eq_ignore_ascii_case("https"))
        .unwrap_or(false)
}

/// `<prefix><path>` with exactly one separator (`joinPathPrefix`).
pub fn join_path_prefix(prefix: &str, path: &str) -> String {
    let normalized_prefix = prefix.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{normalized_prefix}{path}")
    } else {
        format!("{normalized_prefix}/{path}")
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn a_relay_url_path_becomes_the_prefix() {
        assert_eq!(
            path_prefix_from_relay_url("wss://relay.example/nostr"),
            "/nostr"
        );
        assert_eq!(path_prefix_from_relay_url("wss://relay.example/"), "");
        assert_eq!(path_prefix_from_relay_url("wss://relay.example"), "");
        assert_eq!(
            path_prefix_from_relay_url("wss://relay.example/nostr/"),
            "/nostr"
        );
        assert_eq!(path_prefix_from_relay_url("not a url"), "");
    }

    #[test]
    fn only_a_trusted_peer_sets_the_client_address() {
        let proxies = vec!["10.0.0.1".to_owned()];
        assert_eq!(
            remote_address("10.0.0.1", Some("1.2.3.4, 5.6.7.8"), Some(&proxies)),
            "5.6.7.8"
        );
        assert_eq!(
            remote_address("10.0.0.2", Some("1.2.3.4"), Some(&proxies)),
            "10.0.0.2"
        );
        assert_eq!(remote_address("10.0.0.1", None, Some(&proxies)), "10.0.0.1");
        assert_eq!(remote_address("::1", None, None), "::1");
    }

    #[test]
    fn only_a_trusted_peer_marks_the_request_secure() {
        let proxies = vec!["::ffff:10.0.0.1".to_owned()];
        assert!(is_secure_request("10.0.0.1", Some("https"), Some(&proxies)));
        assert!(is_secure_request(
            "10.0.0.1",
            Some("HTTPS, http"),
            Some(&proxies)
        ));
        assert!(!is_secure_request("10.0.0.1", Some("http"), Some(&proxies)));
        assert!(!is_secure_request(
            "10.0.0.2",
            Some("https"),
            Some(&proxies)
        ));
        assert!(!is_secure_request("10.0.0.1", None, Some(&proxies)));
    }
}
