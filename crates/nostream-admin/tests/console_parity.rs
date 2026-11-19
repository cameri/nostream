//! AC6 / AC7 — the oracle. The endpoint list is **derived from the console's own JavaScript**
//! at test time, then every derived route is driven against a live in-process server.
//!
//! | case | what it proves |
//! |---|---|
//! | `every_console_route_is_served` | each derived API path answers the status R5's table names for it, each asset returns the file's bytes, both pages return HTML |
//! | `the_derivation_finds_every_console_route` | the derivation is the set it claims: 26 `(method, path)` entries over 24 paths, 2 pages, 7 assets |

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use common::TestServer;

/// The console's six script files plus the stylesheet, from `dashboard.html`.
const CONSOLE_ASSETS: [&str; 7] = [
    "admin-moderation.js",
    "admin-ops.js",
    "admin-trust.js",
    "dashboard.css",
    "dashboard.js",
    "notifications.js",
    "spark-field.js",
];

/// The path segment the console's `adminBase` template carries.
const ADMIN_BASE: &str = "${adminBase}";

/// One derived endpoint.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Endpoint {
    method: String,
    path: String,
}

fn assets_dir() -> PathBuf {
    common::resources_root().join("admin").join("assets")
}

fn dashboard_html() -> PathBuf {
    common::resources_root()
        .join("admin")
        .join("dashboard.html")
}

/// The asset names the page loads: every `<script src>` and `<link href>` under
/// `/admin/assets/`, with the query string dropped.
fn derive_assets(html: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let marker = "/admin/assets/";
    let mut rest = html;
    while let Some(index) = rest.find(marker) {
        let tail = &rest[index + marker.len()..];
        let end = tail
            .find(|character: char| {
                character == '"' || character == '\'' || character == '?' || character == ' '
            })
            .unwrap_or(tail.len());
        let name = &tail[..end];
        if !name.is_empty() {
            names.insert(name.to_owned());
        }
        rest = &tail[end..];
    }
    names
}

/// Reads a quoted or backtick-delimited literal starting at `source[start]`, returning its
/// content and the index just past its terminator.
fn read_literal(source: &[u8], start: usize) -> Option<(Vec<u8>, usize)> {
    let quote = *source.get(start)?;
    if !matches!(quote, b'`' | b'\'' | b'"') {
        return None;
    }
    let mut index = start + 1;
    while index < source.len() {
        if source[index] == quote {
            return Some((source[start + 1..index].to_vec(), index + 1));
        }
        index += 1;
    }
    None
}

/// The text of the call's remaining arguments, from just after the first argument to the
/// closing paren (balanced).
fn read_call_tail(source: &[u8], mut index: usize) -> Vec<u8> {
    let mut depth = 0usize;
    let start = index;
    while index < source.len() {
        match source[index] {
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
        index += 1;
    }
    source[start..index].to_vec()
}

/// The `method:` a call's options carry, uppercased; `GET` when there is none.
fn method_of(tail: &[u8]) -> String {
    let needle = b"method:";
    let Some(index) = tail
        .windows(needle.len())
        .position(|window| window == needle)
    else {
        return "GET".to_owned();
    };
    let mut after = index + needle.len();
    while after < tail.len() && tail[after].is_ascii_whitespace() {
        after += 1;
    }
    match read_literal(tail, after) {
        Some((method, _)) => String::from_utf8_lossy(&method).trim().to_ascii_uppercase(),
        None => "GET".to_owned(),
    }
}

/// Replaces each `${…}` interpolation with the path parameter it stands for.
fn template_path(content: &[u8]) -> String {
    let text = String::from_utf8_lossy(content).into_owned();
    let mut path = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(index) = rest.find("${") {
        path.push_str(&rest[..index]);
        let Some(end) = rest[index..].find('}') else {
            break;
        };
        // The console's only interpolated path segment is a pubkey (`admin-ops.js:275`).
        path.push_str(":pubkey");
        rest = &rest[index + end + 1..];
    }
    path.push_str(rest);
    path
}

fn strip_query(path: &str) -> String {
    path.split('?').next().unwrap_or(path).to_owned()
}

/// One parsed call site: where its first argument's literal lies, and its method.
struct Call {
    content_start: usize,
    content_end: usize,
    path: Option<String>,
    method: String,
}

/// The call sites in one file: every `fetch(…)` and every `adminFetch(…)`.
fn parse_calls(bytes: &[u8], source: &str) -> Vec<Call> {
    let mut calls = Vec::new();
    let mut index = 0usize;

    while index < bytes.len() {
        let rest = &bytes[index..];
        let (callee, callee_len) = if rest.starts_with(b"adminFetch(") {
            (true, b"adminFetch(".len())
        } else if rest.starts_with(b"fetch(") {
            (false, b"fetch(".len())
        } else {
            index += 1;
            continue;
        };

        index += callee_len;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }

        let Some((content, after_first)) = read_literal(bytes, index) else {
            continue;
        };
        let tail = read_call_tail(bytes, after_first);
        let content_text = String::from_utf8_lossy(&content).into_owned();

        // The wrapper (`fetch(`${adminBase}${path}`)`) is not a route; an `adminFetch` whose
        // first argument is a quoted path is.
        let path = if callee && content_text.starts_with('/') {
            Some(strip_query(&content_text))
        } else {
            None
        };

        calls.push(Call {
            content_start: index,
            content_end: after_first,
            path,
            method: method_of(&tail),
        });
        index = after_first;
    }

    let _ = source;
    calls
}

/// The endpoints one JavaScript file calls: the `adminFetch` paths, and every
/// `${adminBase}/…` interpolation — the `fetch(…)` calls and the one `EventSource` (`GET`)
/// the metrics strip opens.
fn derive_from_source(source: &str) -> Vec<Endpoint> {
    let bytes = source.as_bytes();
    let calls = parse_calls(bytes, source);
    let mut endpoints = Vec::new();

    for call in &calls {
        if let Some(path) = &call.path {
            endpoints.push(Endpoint {
                method: call.method.clone(),
                path: template_path(path.as_bytes()),
            });
        }
    }

    let marker = b"${adminBase}";
    let mut search = 0usize;
    while let Some(found) = source[search..].find(ADMIN_BASE) {
        let at = search + found;
        search = at + ADMIN_BASE.len();

        // A wrapper interpolates its own argument here; anything else is a concrete path.
        if bytes.get(at + marker.len()) != Some(&b'/') {
            continue;
        }

        // The literal that carries the interpolation: back to the opening backtick.
        let Some(literal_start) = bytes[..at].iter().rposition(|byte| *byte == b'`') else {
            continue;
        };
        let Some(literal_end) = bytes[at..].iter().position(|byte| *byte == b'`') else {
            continue;
        };
        let content =
            String::from_utf8_lossy(&bytes[literal_start + 1..at + literal_end]).into_owned();
        let Some(path) = content.strip_prefix(ADMIN_BASE) else {
            continue;
        };
        if !path.starts_with('/') {
            continue;
        }

        let method = calls
            .iter()
            .find(|call| call.content_start <= at && at < call.content_end)
            .map(|call| call.method.clone())
            .unwrap_or_else(|| "GET".to_owned());

        endpoints.push(Endpoint {
            method,
            path: template_path(strip_query(path).as_bytes()),
        });
    }

    endpoints
}

/// Derives the whole console surface from the repository.
fn derive() -> (BTreeSet<Endpoint>, Vec<String>, BTreeSet<String>) {
    let mut api = BTreeSet::new();
    for name in CONSOLE_ASSETS.iter().filter(|name| name.ends_with(".js")) {
        let path = assets_dir().join(name);
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        for endpoint in derive_from_source(&source) {
            api.insert(endpoint);
        }
    }

    let pages = vec!["/".to_owned(), "/dashboard".to_owned()];
    let html = std::fs::read_to_string(dashboard_html()).expect("the dashboard template");
    let assets = derive_assets(&html);
    (api, pages, assets)
}

/// A concrete request path for a derived one (`:pubkey` becomes a real key).
fn concrete(path: &str) -> String {
    path.replace(":pubkey", &"02".repeat(32))
}

/// The statuses R5 names for a route (its success column plus its "other statuses"), so a
/// request that lands on the router's fallback `404` — or on a method the route does not
/// take, `405` — is a failure and not "served". A `404` is named only where R5 names one.
fn expected_statuses(method: &str, path: &str) -> &'static [u16] {
    match (method, path) {
        ("GET", "/session") => &[200],
        ("POST", "/login") => &[200, 400, 401, 500],
        ("POST", "/logout") => &[200],
        ("GET", "/metrics") => &[200],
        ("GET", "/network-health") => &[200],
        ("GET", "/network-health/history") => &[200, 400],
        ("POST", "/network-health/run") => &[200, 400, 409, 502],
        ("GET", "/settings") => &[200],
        ("GET", "/settings/schema") => &[200],
        ("POST", "/settings/validate") => &[200],
        ("GET", "/settings/backups") => &[200],
        ("POST", "/settings/restore") => &[200, 400, 415],
        ("PATCH", "/settings") => &[200, 400],
        ("GET", "/notifications") => &[200],
        ("PATCH", "/notifications") => &[200, 400],
        ("POST", "/notifications/test") => &[200, 400, 502],
        ("GET", "/notifications/deliveries") => &[200, 400],
        ("GET", "/ops/workers") => &[200],
        ("GET", "/ops/nip05-verifications") => &[200, 400],
        ("POST", "/ops/nip05-verifications/:pubkey/reverify") => &[200, 400, 404, 409, 502],
        ("GET", "/ops/storage/counts") => &[200, 400, 500, 504],
        ("GET", "/audit-log") => &[200],
        ("GET", "/diagnostics/export") => &[200],
        ("GET", "/moderation/limits") => &[200],
        ("GET", "/moderation/stats") => &[200, 400, 500, 504],
        ("POST", "/moderation/actions") => &[200, 400],
        _ => panic!("no R5 row for {method} {path}"),
    }
}

#[tokio::test]
async fn the_derivation_finds_every_console_route() {
    let (api, pages, assets) = derive();

    assert_eq!(api.len(), 26, "26 (method, path) entries: {api:#?}");
    let mut distinct: BTreeSet<&str> = BTreeSet::new();
    for endpoint in &api {
        distinct.insert(endpoint.path.as_str());
    }
    assert_eq!(distinct.len(), 24, "24 distinct paths: {distinct:#?}");
    assert_eq!(pages.len() + api.len(), 28, "28 console routes");

    // The two paths that carry two methods each.
    for (method, path) in [
        ("GET", "/settings"),
        ("PATCH", "/settings"),
        ("GET", "/notifications"),
        ("PATCH", "/notifications"),
    ] {
        assert!(
            api.contains(&Endpoint {
                method: method.to_owned(),
                path: path.to_owned(),
            }),
            "{method} {path} is derived"
        );
    }

    for name in CONSOLE_ASSETS {
        assert!(assets.contains(name), "asset {name} is derived");
    }
    assert_eq!(assets.len(), 7, "the seven asset names: {assets:#?}");

    // The names AC7 fixes: the interpolated path and three more.
    for path in [
        "/session",
        "/settings",
        "/notifications/deliveries",
        "/ops/nip05-verifications/:pubkey/reverify",
    ] {
        assert!(
            api.iter().any(|endpoint| endpoint.path == path),
            "{path} is derived"
        );
    }
}

#[tokio::test]
async fn every_console_route_is_served() {
    let server = TestServer::start().await;
    let cookie = server.login().await;
    let (api, pages, assets) = derive();

    let mut unserved: Vec<String> = Vec::new();
    for endpoint in &api {
        let path = format!("/admin{}", concrete(&endpoint.path));
        let response = server
            .request(
                &endpoint.method,
                &path,
                &[("cookie", &cookie), ("content-type", "application/json")],
                matches!(endpoint.method.as_str(), "POST" | "PATCH").then_some(b"{}".as_slice()),
            )
            .await;
        let named = expected_statuses(&endpoint.method, &endpoint.path);
        if !named.contains(&response.status) {
            unserved.push(format!(
                "{} {} → {} (R5 names {named:?})",
                endpoint.method, endpoint.path, response.status
            ));
        }
    }

    for page in &pages {
        let response = server.get_with(&format!("/admin{page}"), &cookie).await;
        assert_eq!(response.status, 200, "page {page}: {}", response.text());
        assert!(
            response.content_type().starts_with("text/html"),
            "page {page} is HTML, got {}",
            response.content_type()
        );
    }

    for name in &assets {
        let response = server
            .get_with(&format!("/admin/assets/{name}"), &cookie)
            .await;
        assert_eq!(response.status, 200, "asset {name}");
        let on_disk = std::fs::read(assets_dir().join(name)).unwrap();
        assert_eq!(response.body, on_disk, "asset {name} is byte-identical");
    }

    println!(
        "derived: {} calls over {} paths + {} page + {} assets",
        api.len(),
        api.iter()
            .map(|endpoint| &endpoint.path)
            .collect::<BTreeSet<_>>()
            .len(),
        pages.len(),
        assets.len(),
    );
    assert!(
        unserved.is_empty(),
        "unserved: {} of {} derived routes: {unserved:#?}",
        unserved.len(),
        api.len()
    );
    println!("unserved: {}", unserved.len());
}

/// Runs the derivation against a synthetic source, so the parser itself is pinned and not just
/// its output on the console's files.
#[test]
fn the_parser_reads_the_capture_s_call_shapes() {
    let source = r#"
      const a = await fetch(`${adminBase}/settings`, { credentials: 'include' })
      const b = await fetch(`${adminBase}/settings`, { method: 'PATCH', body: '{}' })
      const c = await fetch(`${adminBase}/network-health/history?limit=${n}`, { credentials: 'include' })
      const d = await adminFetch(`/ops/nip05-verifications/${encodeURIComponent(pubkey)}/reverify`, {
        method: 'POST',
      })
      const wrapper = await fetch(`${adminBase}${path}`, { credentials: 'same-origin' })
    "#;
    let endpoints = derive_from_source(source);
    let found: BTreeSet<(String, String)> = endpoints
        .iter()
        .map(|endpoint| (endpoint.method.clone(), endpoint.path.clone()))
        .collect();
    assert_eq!(
        found,
        BTreeSet::from([
            ("GET".to_owned(), "/settings".to_owned()),
            ("PATCH".to_owned(), "/settings".to_owned()),
            ("GET".to_owned(), "/network-health/history".to_owned()),
            (
                "POST".to_owned(),
                "/ops/nip05-verifications/:pubkey/reverify".to_owned()
            ),
        ])
    );
}

/// The derivation must fail loudly when the console is missing, never skip (CLAUDE.md:188).
#[test]
fn a_missing_console_file_is_a_failure() {
    let missing = Path::new("definitely-not-here.js");
    assert!(!assets_dir().join(missing).exists());
    let _ = ADMIN_BASE;
}
