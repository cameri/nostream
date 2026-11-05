//! The one outbound HTTP seam. Mirrors the `axios` instances the capture's payment
//! processors, notification channels and NIP-05 verifier create.
//!
//! Only a 2xx status is a success (`validateStatus: 200 <= s < 300`,
//! `src/services/notification-channels.ts:45,64,90,115`), and a failure carries the status
//! that arrived so a caller can apply the invoice walk's 404 rule. Tests drive this trait
//! with a recording double; [`ReqwestClient`] is the process's transport.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use nostream_core::nip05::{FetchOutcome, Nip05Fetch};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

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
///
/// One client serves the payment processors and the notification channels, whose URLs are the
/// operator's to choose, including a self-hosted processor on a private address. The NIP-05
/// fetch is the exception: its URL comes from a stored identifier, so it is built on its own
/// client per request with [`GuardedResolver`] underneath.
#[derive(Clone)]
pub struct ReqwestClient {
    client: reqwest::Client,
    nip05_resolver: Arc<GuardedResolver>,
}

impl std::fmt::Debug for ReqwestClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReqwestClient")
            .finish_non_exhaustive()
    }
}

/// The capture's `maxRedirects: 1` on the processors' axios instances
/// (`src/factories/payments-processors/*.ts`). This one client serves every caller, so the
/// notification channels follow at most one redirect, where their bare `axios.post` follows
/// up to five (`src/services/notification-channels.ts:42`).
const MAX_REDIRECTS: usize = 1;

impl ReqwestClient {
    /// A client with the default TLS configuration that follows at most one redirect.
    pub fn new() -> Result<Self, ServicesError> {
        Self::with_nip05_resolver(Arc::new(SystemResolver))
    }

    /// A client whose NIP-05 fetch resolves names through `resolver`, guarded by
    /// [`GuardedResolver`].
    pub fn with_nip05_resolver(resolver: Arc<dyn Resolve>) -> Result<Self, ServicesError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
            .map_err(|error| ServicesError::Configuration(format!("http client: {error}")))?;

        Ok(Self {
            client,
            nip05_resolver: Arc::new(GuardedResolver::new(resolver)),
        })
    }
}

/// `getaddrinfo`, the resolver a client gets when nothing else is installed.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();

        Box::pin(async move {
            // Port 0: reqwest replaces it with the scheme's default, and a URL's explicit port
            // overrides it.
            let addresses = tokio::net::lookup_host((host.clone(), 0))
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?;

            Ok(Box::new(addresses) as Addrs)
        })
    }
}

/// A resolver that drops every address [`is_public_address`] refuses, failing the resolution
/// when nothing public is left.
///
/// Filtering here rather than after the connection keeps the TLS name and the `Host` header on
/// the original host, and the address set reqwest connects to is the one that was vetted, so a
/// second lookup cannot swap in a private address.
pub struct GuardedResolver {
    inner: Arc<dyn Resolve>,
}

impl GuardedResolver {
    /// Wraps `inner`.
    pub fn new(inner: Arc<dyn Resolve>) -> Self {
        Self { inner }
    }
}

impl std::fmt::Debug for GuardedResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GuardedResolver")
            .finish_non_exhaustive()
    }
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let inner = Arc::clone(&self.inner);

        Box::pin(async move {
            let host = name.as_str().to_owned();
            let addresses = inner.resolve(name).await?;
            let public: Vec<SocketAddr> = addresses
                .filter(|address| is_public_address(address.ip()))
                .collect();

            if public.is_empty() {
                return Err(format!(
                    "refusing to resolve {host}: every address is private, loopback, \
                     link-local, multicast or unspecified"
                )
                .into());
            }

            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// Whether `address` may be dialled: public unicast space only.
///
/// The capture cannot make this check (`src/utils/nip05.ts:59-105` has no resolver either), so
/// this is a deliberate divergence: a stored NIP-05 domain must not reach the host's own
/// network.
pub fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        // `::ffff:127.0.0.1` is loopback whatever the family says.
        IpAddr::V6(address) => match address.to_ipv4_mapped() {
            Some(mapped) => is_public_v4(mapped),
            None => {
                let segments = address.segments();

                !(address.is_loopback()
                    || address.is_unspecified()
                    || address.is_multicast()
                    // fc00::/7 unique local.
                    || (segments[0] & 0xfe00) == 0xfc00
                    // fe80::/10 link-local.
                    || (segments[0] & 0xffc0) == 0xfe80
                    // fec0::/10 deprecated site-local.
                    || (segments[0] & 0xffc0) == 0xfec0)
            }
        },
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let [first, second, ..] = address.octets();

    !(address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_unspecified()
        || address.is_broadcast()
        // 0.0.0.0/8, "this network".
        || first == 0
        // 100.64.0.0/10, carrier-grade NAT.
        || (first == 100 && (64..=127).contains(&second))
        // 192.0.0.0/24 and 198.18.0.0/15, protocol assignments and benchmarking.
        || (first == 192 && second == 0)
        || (first == 198 && (second & 0xfe) == 18))
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

/// A target the NIP-05 fetch may dial: `https` on a host that is not `localhost`, not a
/// private literal, and not an IPv6 literal.
///
/// The capture's `isRedirectTargetSafe` (`src/utils/nip05.ts:59-105`) is the same predicate
/// applied to redirect hops. It is applied to the initial URL here as well, and the host's
/// resolved addresses are filtered by [`GuardedResolver`] — a check the capture cannot make,
/// because it has no resolver.
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

    match host.parse::<IpAddr>() {
        Ok(address) => is_public_address(address),
        Err(_) => true,
    }
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
            // The URL comes from a stored identifier, so it is checked before anything is
            // dialled. A host name passes here and is decided by its addresses in
            // `GuardedResolver`; a literal is decided outright.
            let target = reqwest::Url::parse(url)
                .map_err(|error| nostream_core::CoreError::Fetch(format!("NIP-05 url: {error}")))?;

            if !is_redirect_target_safe(&target) {
                return Err(nostream_core::CoreError::Fetch(format!(
                    "refused NIP-05 fetch to unsafe target: {}",
                    target.host_str().unwrap_or("<no host>")
                )));
            }

            let client = reqwest::Client::builder()
                .redirect(nip05_redirect_policy(max_redirects))
                .timeout(Duration::from_millis(timeout_ms))
                // This client serves only the NIP-05 path; the shared client's processors may
                // legitimately point at a private address.
                .dns_resolver(Arc::clone(&self.nip05_resolver))
                .build()
                .map_err(|error| nostream_core::CoreError::Fetch(error.to_string()))?;

            let mut response = client.get(url).send().await.map_err(|error| {
                nostream_core::CoreError::Fetch(describe_transport_error(&error))
            })?;

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

/// `error` and its sources, so a resolver's refusal reaches the verification outcome. reqwest
/// reports a connect failure as "error sending request for url (...)" and keeps the reason —
/// here, the refusal — in the source chain.
fn describe_transport_error(error: &(dyn std::error::Error + 'static)) -> String {
    let mut message = error.to_string();
    let mut source = error.source();

    while let Some(error) = source {
        message.push_str(": ");
        message.push_str(&error.to_string());
        source = error.source();
    }

    message
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

    use std::collections::HashMap;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::time::Duration;

    use nostream_core::nip05::Nip05Fetch;
    use reqwest::dns::{Addrs, Name, Resolve, Resolving};

    use super::{HttpClient, ReqwestClient, is_public_address, is_redirect_target_safe};

    /// A resolver that answers from a table, so no test needs DNS.
    #[derive(Debug, Default)]
    struct FakeResolver {
        answers: HashMap<String, Vec<IpAddr>>,
        asked: Mutex<Vec<String>>,
    }

    impl FakeResolver {
        fn new(answers: &[(&str, &[&str])]) -> Arc<Self> {
            Arc::new(Self {
                answers: answers
                    .iter()
                    .map(|(name, addresses)| {
                        (
                            (*name).to_owned(),
                            addresses
                                .iter()
                                .map(|address| address.parse().expect("an ip address"))
                                .collect(),
                        )
                    })
                    .collect(),
                asked: Mutex::new(Vec::new()),
            })
        }

        fn asked(&self) -> Vec<String> {
            self.asked
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    impl Resolve for FakeResolver {
        fn resolve(&self, name: Name) -> Resolving {
            let host = name.as_str().to_owned();
            self.asked
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(host.clone());
            let answers = self.answers.get(&host).cloned().unwrap_or_default();

            Box::pin(async move {
                let addresses: Vec<SocketAddr> = answers
                    .into_iter()
                    .map(|address| SocketAddr::new(address, 0))
                    .collect();

                Ok(Box::new(addresses.into_iter()) as Addrs)
            })
        }
    }

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

    /// A stored NIP-05 domain must not reach the host's own network. The name passes the URL
    /// predicate and is refused by its resolved addresses.
    #[tokio::test]
    async fn a_name_that_resolves_to_private_space_is_refused() {
        for answer in [
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.10",
            "169.254.169.254",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "0.0.0.0",
        ] {
            let resolver = FakeResolver::new(&[("intranet.test", &[answer])]);
            let client =
                ReqwestClient::with_nip05_resolver(Arc::clone(&resolver) as Arc<dyn Resolve>)
                    .expect("client");

            let error = Nip05Fetch::get(
                &client,
                "https://intranet.test/.well-known/nostr.json?name=alice",
                200,
                4_096,
                1,
            )
            .await
            .expect_err("a private address is refused");

            assert!(
                error
                    .to_string()
                    .contains("refusing to resolve intranet.test"),
                "{answer}: {error}"
            );
            assert_eq!(
                resolver.asked(),
                vec!["intranet.test".to_owned()],
                "the name reached the guard"
            );
        }
    }

    /// A mixed answer keeps only the public address, so a host that publishes both is still
    /// reachable and never dials the private one.
    #[tokio::test]
    async fn a_public_address_still_passes_the_guard() {
        let resolver = FakeResolver::new(&[("relay.example.com", &["127.0.0.1", "93.184.216.34"])]);
        let client = ReqwestClient::with_nip05_resolver(Arc::clone(&resolver) as Arc<dyn Resolve>)
            .expect("client");

        let error = Nip05Fetch::get(
            &client,
            "https://relay.example.com/.well-known/nostr.json?name=alice",
            100,
            4_096,
            1,
        )
        .await
        .expect_err("nothing public answers on this sandbox");

        assert_eq!(
            resolver.asked(),
            vec!["relay.example.com".to_owned()],
            "the guard resolved the name rather than refusing it"
        );
        assert!(
            !error.to_string().contains("refusing to resolve"),
            "a public answer is not refused: {error}"
        );
    }

    /// The initial URL is checked before the resolver runs, and before anything is dialled.
    #[tokio::test]
    async fn the_initial_url_is_checked_before_the_resolver() {
        for url in [
            "http://relay.example.com/.well-known/nostr.json",
            "https://127.0.0.1/.well-known/nostr.json",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/.well-known/nostr.json",
            "https://localhost/.well-known/nostr.json",
        ] {
            let resolver = FakeResolver::new(&[]);
            let client =
                ReqwestClient::with_nip05_resolver(Arc::clone(&resolver) as Arc<dyn Resolve>)
                    .expect("client");

            let error = Nip05Fetch::get(&client, url, 200, 4_096, 1)
                .await
                .expect_err("an unsafe initial URL is refused");

            assert!(
                error
                    .to_string()
                    .starts_with("refused NIP-05 fetch to unsafe target"),
                "{url}: {error}"
            );
            assert!(resolver.asked().is_empty(), "{url}: nothing was resolved");
        }
    }

    #[test]
    fn the_address_predicate_covers_every_reserved_range() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "224.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "100.64.0.1",
            "198.18.0.1",
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
        ] {
            let address: IpAddr = address.parse().expect("an ip address");
            assert!(!is_public_address(address), "{address} is not public");
        }

        for address in [
            "8.8.8.8",
            "93.184.216.34",
            "172.32.0.1",
            "2606:4700:4700::1111",
            "2001:db8::1",
        ] {
            let address: IpAddr = address.parse().expect("an ip address");
            assert!(is_public_address(address), "{address} is public");
        }

        assert!(!is_public_address(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_public_address(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    /// The Telegram and webhook URLs carry their credential in the path, and this text reaches
    /// the daemon log, the delivery log and the outbox row.
    #[tokio::test]
    async fn a_transport_failure_does_not_carry_the_request_url() {
        let client = ReqwestClient::new().expect("client");
        let error = HttpClient::get(
            &client,
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
