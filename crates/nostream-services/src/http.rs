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
    /// GETs `url` within `timeout`, failing on a non-2xx status.
    fn get<'a>(&'a self, url: &'a str, timeout: Duration) -> HttpFuture<'a>;

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

impl ReqwestClient {
    /// A client with the default TLS configuration.
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for ReqwestClient {
    fn default() -> Self {
        Self::new()
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
            message: error.to_string(),
        })?;

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| ServicesError::Http {
            status: Some(status),
            message: error.to_string(),
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
    fn get<'a>(&'a self, url: &'a str, timeout: Duration) -> HttpFuture<'a> {
        Box::pin(send(self.client.get(url), timeout))
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
                .redirect(reqwest::redirect::Policy::limited(max_redirects))
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

/// POSTs `body` as JSON, which is every processor's request.
pub async fn post_json(
    client: &dyn HttpClient,
    url: &str,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<HttpResponse, ServicesError> {
    let body = serde_json::to_string(body)
        .map_err(|error| ServicesError::Configuration(format!("request body: {error}")))?;
    let headers = [("content-type".to_owned(), "application/json".to_owned())];

    client.post(url, &headers, &body, timeout).await
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
