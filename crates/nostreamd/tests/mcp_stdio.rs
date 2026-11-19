//! AC5 — the stdio mode in the real binary: the flag, the JSON-RPC stream, the banner's stream,
//! the absent socket, the exit code and the unwired store's answer.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_banner_is_on_stderr_and_stdout_is_json_rpc` | stdout carries only JSON-RPC, and the one INFO line is on stderr |
//! | `initialize_names_the_daemon` | `protocolVersion`, `serverInfo.name` and the daemon's version |
//! | `settings_get_answers_redacted_over_stdio` | a real call answers the redacted document |
//! | `the_mode_binds_no_socket` | the dialogue completes while the port the flag names is held by the test |
//! | `the_process_exits_zero_on_stdin_eof` | closing stdin ends the process with `0` |
//! | `the_store_backed_tools_report_the_unwired_store` | `list_events` answers the store's own `NotImplemented` message, not an empty list |
//! | `the_help_text_names_the_credential` | `--help` names the three prerequisites and `NOSTREAM_ADMIN_TOKEN` |
//!
//! The dialogue is hand-written JSON-RPC over the child's pipes: this target proves a property
//! of the process, so it spawns the binary the way an MCP client does.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use nostream_admin::utils::session;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

/// The literal `SECRET` the daemon signs sessions with here.
const SECRET: &str = "a-test-secret";

/// The fixture password hash `hashAdminPassword` writes for `hunter2`.
const PASSWORD_HASH: &str = "scrypt:BwcHBwcHBwcHBwcHBwcHBw==:r5daXU05UJ9EUDu45YoHMWUoQCmkVbwINYNntY1/dwrJPOt3fTi/1IWw1wp9+YXRj1Vm6IpFi+gSU0JdqZvWIw==";

/// A session token the daemon's own clock accepts, minted the way `POST /admin/login` does.
fn token() -> String {
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .try_into()
        .unwrap();
    let expires_at = now + 3_600;
    session::create_token(&session::session_key(SECRET.as_bytes()), expires_at)
}

/// One spawned `nostreamd --mcp-stdio`, and every stdout line it wrote.
struct Daemon {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    stderr: ChildStderr,
    lines: Vec<String>,
    next_id: u64,
}

/// What a finished dialogue left behind.
struct Outcome {
    status: std::process::ExitStatus,
    stdout: Vec<String>,
    stderr: String,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl Daemon {
    /// Spawns the binary on a fresh config dir.
    fn start(token: Option<&str>, extra: &[String]) -> (Self, tempfile::TempDir) {
        let temp = tempfile::tempdir().expect("tempdir");
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        std::fs::write(
            config_dir.join("settings.yaml"),
            format!(
                "info:\n  name: Example\n  relay_url: ws://127.0.0.1:8008\nadmin:\n  enabled: true\n  passwordHash: \"{PASSWORD_HASH}\"\n"
            ),
        )
        .expect("settings");

        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_nostreamd"));
        command
            .arg("--config-dir")
            .arg(&config_dir)
            .arg("--log-level")
            .arg("info")
            .arg("--mcp-stdio")
            .args(extra)
            .current_dir(&workspace)
            .env("SECRET", SECRET)
            .env("WORKER_COUNT", "1")
            // The ambient environment must not decide whether this case is authenticated.
            .env_remove("NOSTREAM_ADMIN_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(token) = token {
            command.env("NOSTREAM_ADMIN_TOKEN", token);
        }
        let mut child = command.spawn().expect("the daemon starts");
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        let stderr = child.stderr.take().expect("stderr is piped");
        (
            Self {
                child,
                stdin,
                stdout,
                stderr,
                lines: Vec::new(),
                next_id: 0,
            },
            temp,
        )
    }

    async fn send(&mut self, message: Value) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .expect("the child reads");
        stdin.flush().await.expect("the child reads");
    }

    /// One stdout line, recorded so the banner case can hold every one of them to JSON.
    async fn read_line(&mut self) -> String {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(15), self.stdout.read_line(&mut line))
            .await
            .expect("a reply within fifteen seconds")
            .expect("the pipe reads");
        assert!(read > 0, "the child closed stdout mid-dialogue");
        self.lines.push(line.clone());
        line
    }

    /// The response carrying `id`, skipping anything else the server sends.
    async fn response(&mut self, id: u64) -> Value {
        loop {
            let line = self.read_line().await;
            let message: Value = serde_json::from_str(&line)
                .unwrap_or_else(|error| panic!("stdout carried a non-JSON line ({error}): {line}"));
            assert_eq!(message["jsonrpc"], "2.0", "{message}");
            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await;
        self.response(id).await
    }

    /// The `initialize` handshake every dialogue starts with.
    async fn initialize(&mut self) -> Value {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "mcp-stdio-test", "version": "0" },
                }),
            )
            .await;
        self.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        result
    }

    async fn call(&mut self, tool: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
        .await
    }

    /// Closes stdin, waits for the exit, and drains both pipes.
    async fn finish(mut self) -> Outcome {
        drop(self.stdin.take());
        let status = tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .expect("the child exits within five seconds when stdin closes")
            .expect("the child is reaped");
        let mut rest = String::new();
        self.stdout
            .read_to_string(&mut rest)
            .await
            .expect("stdout drains");
        let mut stderr = String::new();
        self.stderr
            .read_to_string(&mut stderr)
            .await
            .expect("stderr drains");
        let mut stdout = std::mem::take(&mut self.lines);
        stdout.extend(
            rest.lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_owned),
        );
        Outcome {
            status,
            stdout,
            stderr,
        }
    }
}

#[tokio::test]
async fn the_banner_is_on_stderr_and_stdout_is_json_rpc() {
    let (mut daemon, _temp) = Daemon::start(Some(&token()), &[]);
    daemon.initialize().await;
    daemon.request("tools/list", json!({})).await;
    let outcome = daemon.finish().await;

    assert!(
        outcome
            .stderr
            .lines()
            .any(|line| line.contains("mcp server on stdio")),
        "the banner is on stderr: {}",
        outcome.stderr
    );
    assert!(!outcome.stdout.is_empty(), "the dialogue answered");
    for line in &outcome.stdout {
        let message: Value = serde_json::from_str(line)
            .unwrap_or_else(|error| panic!("stdout carried {line:?}: {error}"));
        assert_eq!(message["jsonrpc"], "2.0", "{message}");
    }
}

#[tokio::test]
async fn initialize_names_the_daemon() {
    let (mut daemon, _temp) = Daemon::start(Some(&token()), &[]);
    let result = daemon.initialize().await;
    let outcome = daemon.finish().await;

    assert_eq!(result["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(result["result"]["serverInfo"]["name"], "nostream");
    assert_eq!(
        result["result"]["serverInfo"]["version"],
        env!("CARGO_PKG_VERSION")
    );
    assert!(outcome.status.success(), "{}", outcome.stderr);
}

#[tokio::test]
async fn settings_get_answers_redacted_over_stdio() {
    let (mut daemon, _temp) = Daemon::start(Some(&token()), &[]);
    daemon.initialize().await;
    let response = daemon.call("settings_get", json!({})).await;
    let outcome = daemon.finish().await;

    assert_eq!(response["result"]["isError"], false, "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["settings"]["admin"]["passwordHash"], "***",
        "{response}"
    );
    assert!(outcome.status.success(), "{}", outcome.stderr);
}

#[tokio::test]
async fn the_mode_binds_no_socket() {
    // Held open for the whole dialogue: the child never binds it.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("an ephemeral port");
    let port = listener.local_addr().expect("addr").port();

    let (mut daemon, _temp) = Daemon::start(
        Some(&token()),
        &["--listen-port".to_owned(), port.to_string()],
    );
    daemon.initialize().await;
    let listed = daemon.request("tools/list", json!({})).await;
    let outcome = daemon.finish().await;

    assert_eq!(
        listed["result"]["tools"].as_array().map(Vec::len),
        Some(4),
        "{listed}"
    );
    assert!(outcome.status.success(), "{}", outcome.stderr);
    drop(listener);
}

#[tokio::test]
async fn the_process_exits_zero_on_stdin_eof() {
    let (daemon, _temp) = Daemon::start(Some(&token()), &[]);
    let outcome = daemon.finish().await;
    assert_eq!(outcome.status.code(), Some(0), "{}", outcome.stderr);
}

#[tokio::test]
async fn the_store_backed_tools_report_the_unwired_store() {
    let (mut daemon, _temp) = Daemon::start(Some(&token()), &[]);
    daemon.initialize().await;
    let response = daemon.call("list_events", json!({})).await;
    let outcome = daemon.finish().await;

    assert_eq!(response["result"]["isError"], true, "{response}");
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert!(
        text.contains("not implemented in Phase 1 (job 005): storage::backend::wiring"),
        "{text}"
    );
    assert!(outcome.status.success(), "{}", outcome.stderr);
}

#[tokio::test]
async fn the_help_text_names_the_credential() {
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_nostreamd"))
        .arg("--help")
        .output()
        .await
        .expect("the binary answers --help");
    assert!(output.status.success(), "--help exits 0");
    let help = String::from_utf8_lossy(&output.stdout);
    for needle in [
        "--mcp-stdio",
        "NOSTREAM_ADMIN_TOKEN",
        "admin.enabled",
        "SECRET",
    ] {
        assert!(help.contains(needle), "the help names `{needle}`: {help}");
    }
}
