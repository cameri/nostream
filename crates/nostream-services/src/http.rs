//! The one outbound HTTP seam. Mirrors the `axios` instances the capture's payment
//! processors, notification channels and NIP-05 verifier create.
//!
//! Only a 2xx status is a success (`validateStatus: 200 <= s < 300`,
//! `src/services/notification-channels.ts:45,64,90,115`), and a failure carries the status
//! that arrived so a caller can apply the invoice walk's 404 rule. Tests drive this trait
//! with a recording double; [`ReqwestClient`] is the process's transport.

use std::pin::Pin;
use std::time::Duration;

use nostream_core::nip05::{FetchOutcome, Nip05Fetch};

use crate::error::ServicesError;

/// What one request answered: the status and the body as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// One outbound request future, in the style of the relay's seam traits.
pub type HttpFuture<'a> =
    Pin<Box<dyn Future<Output = Result<HttpResponse, ServicesError>> + Send + 'a>>;

/// The HTTP operations the services need: a GET and a POST with headers.
pub trait HttpClient: Send + Sync {
    /// GETs `url` with `headers` within `timeout`, failing on a non-2xx status.
    fn get<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
        timeout: Duration,
    ) -> HttpFuture<'a>;

    /// POSTs `body` to `url` with `headers` within `timeout`, failing on a non-2xx status.
    fn post<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
        body: &'a str,
        timeout: Duration,
    ) -> HttpFuture<'a>;
}

/// The process's transport (`axios` in the capture).
#[derive(Debug, Clone)]
pub struct ReqwestClient {
    client: reqwest::Client,
}

/// The capture's `maxRedirects: 1` on the processors' axios instances
/// (`src/factories/payments-processors/*.ts`). This one client serves every caller, so the
/// notification channels follow at most one redirect, where their bare `axios.post` follows
/// up to five (`src/services/notification-channels.ts:42`).
const MAX_REDIRECTS: usize = 1;

impl ReqwestClient {
    /// A client with the default TLS configuration that follows at most one redirect.
    pub fn new() -> Result<Self, ServicesError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
            .map_err(|error| ServicesError::Configuration(format!("http client: {error}")))?;

        Ok(Self { client })
    }
}

async fn send(
    request: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<HttpResponse, ServicesError> {
    let response = request
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| ServicesError::Http {
            status: error.status().map(|status| status.as_u16()),
            // The URL is the credential for the Telegram and webhook channels, and this
            // message reaches the daemon log and both notification tables.
            message: error.without_url().to_string(),
        })?;

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ServicesError::Http {
            status: Some(status),
            message: error.without_url().to_string(),
        })?;
    let body = String::from_utf8_lossy(&bytes).into_owned();

    if !(200..300).contains(&status) {
        return Err(ServicesError::Http {
            status: Some(status),
            message: format!("HTTP status {status}"),
        });
    }

    Ok(HttpResponse { status, body })
}

impl HttpClient for ReqwestClient {
    fn get<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
        timeout: Duration,
    ) -> HttpFuture<'a> {
        Box::pin(async move {
            let mut request = self.client.get(url);

            for (name, value) in headers {
                request = request.header(name, value);
            }

            send(request, timeout).await
        })
    }

    fn post<'a>(
        &'a self,
        url: &'a str,
        headers: &'a [(String, String)],
        body: &'a str,
        timeout: Duration,
    ) -> HttpFuture<'a> {
        Box::pin(async move {
            let mut request = self.client.post(url).body(body.to_owned());

            for (name, value) in headers {
                request = request.header(name, value);
            }

            send(request, timeout).await
        })
    }
}

/// `isRedirectTargetSafe` (`src/utils/nip05.ts:59-105`): a redirect must stay on `https` and
/// must not point at loopback, link-local, private or multicast space.
fn is_redirect_target_safe(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }

    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();

    if host == "localhost" || host == "0.0.0.0" || host.ends_with(".localhost") {
        return false;
    }

    // NIP-05 hosts are domain names; any bracketed IPv6 literal is refused.
    if host.starts_with('[') && host.ends_with(']') {
        return false;
    }

    let Ok(address) = host.parse::<std::net::Ipv4Addr>() else {
        return true;
    };
    let [a, b, ..] = address.octets();

    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168))
}

/// The capture's `beforeRedirect` over `maxRedirects`: each hop is checked before it is
/// followed, and a refused target aborts the fetch.
fn nip05_redirect_policy(max_redirects: usize) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= max_redirects {
            return attempt.error("too many redirects");
        }

        if !is_redirect_target_safe(attempt.url()) {
            let target = attempt.url().to_string();
            return attempt.error(format!("refused redirect to unsafe target: {target}"));
        }

        attempt.follow()
    })
}

impl Nip05Fetch for ReqwestClient {
    fn get<'a>(
        &'a self,
        url: &'a str,
        timeout_ms: u64,
        max_bytes: usize,
        max_redirects: usize,
    ) -> Pin<Box<dyn Future<Output = Result<FetchOutcome, nostream_core::CoreError>> + Send + 'a>>
    {
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .redirect(nip05_redirect_policy(max_redirects))
                .timeout(Duration::from_millis(timeout_ms))
                .build()
                .map_err(|error| nostream_core::CoreError::Fetch(error.to_string()))?;

            let mut response = client
                .get(url)
                .send()
                .await
                .map_err(|error| nostream_core::CoreError::Fetch(error.to_string()))?;

            let status = response.status().as_u16();
            let mut body = Vec::new();

            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| nostream_core::CoreError::Fetch(error.to_string()))?
            {
                if body.len() + chunk.len() > max_bytes {
                    return Err(nostream_core::CoreError::Fetch(format!(
                        "response body exceeds {max_bytes} bytes"
                    )));
                }

                body.extend_from_slice(&chunk);
            }

            Ok(FetchOutcome { status, body })
        })
    }
}

/// POSTs `body` as JSON with `headers`, which is every processor's request.
pub async fn post_json(
    client: &dyn HttpClient,
    url: &str,
    headers: &[(String, String)],
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<HttpResponse, ServicesError> {
    let body = serde_json::to_string(body)
        .map_err(|error| ServicesError::Configuration(format!("request body: {error}")))?;
    let mut request_headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    request_headers.extend_from_slice(headers);

    client.post(url, &request_headers, &body, timeout).await
}

/// Parses a response body as JSON.
pub fn parse_json(response: &HttpResponse) -> Result<serde_json::Value, ServicesError> {
    serde_json::from_str(&response.body)
        .map_err(|error| ServicesError::Payment(format!("invalid response body: {error}")))
}

/// Joins a configured base URL and a path, tolerating either side's trailing slash.
pub fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::time::Duration;

    use super::{HttpClient, ReqwestClient, is_redirect_target_safe};

    /// `Some` when `url` parses, so a typo fails the comparison instead of the test helper.
    fn safe(url: &str) -> Option<bool> {
        reqwest::Url::parse(url)
            .ok()
            .map(|url| is_redirect_target_safe(&url))
    }

    #[test]
    fn a_redirect_target_is_safe_only_on_https_and_on_public_hosts() {
        assert_eq!(
            safe("https://relay.example.com/.well-known/nostr.json?name=alice"),
            Some(true)
        );
        assert_eq!(safe("https://8.8.8.8/nostr.json"), Some(true));
        assert_eq!(safe("https://172.32.0.1/nostr.json"), Some(true));

        assert_eq!(safe("http://relay.example.com/nostr.json"), Some(false));
        assert_eq!(safe("https://localhost/nostr.json"), Some(false));
        assert_eq!(safe("https://relay.localhost/nostr.json"), Some(false));
        assert_eq!(safe("https://0.0.0.0/nostr.json"), Some(false));
        assert_eq!(safe("https://127.0.0.1/nostr.json"), Some(false));
        assert_eq!(safe("https://10.1.2.3/nostr.json"), Some(false));
        assert_eq!(safe("https://172.16.0.1/nostr.json"), Some(false));
        assert_eq!(safe("https://172.31.255.255/nostr.json"), Some(false));
        assert_eq!(safe("https://192.168.1.1/nostr.json"), Some(false));
        assert_eq!(safe("https://169.254.169.254/nostr.json"), Some(false));
        assert_eq!(safe("https://224.0.0.1/nostr.json"), Some(false));
        assert_eq!(safe("https://[::1]/nostr.json"), Some(false));
    }

    /// The Telegram and webhook URLs carry their credential in the path, and this text reaches
    /// the daemon log, the delivery log and the outbox row.
    #[tokio::test]
    async fn a_transport_failure_does_not_carry_the_request_url() {
        let error = ReqwestClient::new()
            .expect("client")
            .get(
                "https://127.0.0.1:1/bot123456:SECRETTOKEN/sendMessage",
                &[],
                Duration::from_secs(1),
            )
            .await
            .expect_err("nothing listens on port 1");

        assert!(
            !error.to_string().contains("SECRETTOKEN"),
            "the URL is the credential: {error}"
        );
    }
}
