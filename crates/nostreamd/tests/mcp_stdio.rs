//! AC5, AC29, AC30, AC33 — the stdio mode in the real binary: the flag, the JSON-RPC stream, the
//! banner's stream, the absent socket, the exit code, the unwired store's answer, and the two
//! ways the mode refuses to start with a credential it cannot accept.
//!
//! | case | what it proves |
//! |---|---|
//! | `the_banner_is_on_stderr_and_stdout_is_json_rpc` | stdout carries only JSON-RPC, and the one INFO line is on stderr |
//! | `initialize_names_the_daemon` | `protocolVersion`, `serverInfo.name` and the daemon's version |
//! | `settings_get_answers_redacted_over_stdio` | a real call answers the redacted document |
//! | `the_mode_binds_no_socket` | the dialogue completes while the port the flag names is held by the test |
//! | `the_process_exits_zero_on_stdin_eof` | closing stdin ends the process with `0` |
//! | `the_store_backed_tools_report_the_unwired_store` | `list_events` answers the store's own `NotImplemented` message, not an empty list |
//! | `the_help_text_names_the_credential` | `--help` names the two flags, the document's shape and scopes, the file rule and the retired variable |
//! | `a_console_session_token_in_the_environment_refuses_to_start` | the retired variable is named rather than ignored, even when it carries a token the console would accept |
//! | `a_group_readable_token_file_refuses_to_start` | mode 0644 fails the start, and the message names both modes |
//! | `the_mode_needs_one_credential_flag` | neither flag is an error naming both, and both is an error naming both |
//! | `an_inherited_descriptor_authenticates` | a document delivered on descriptor 3 answers `tools/list` and a read, with nothing on the command line or in the environment |
//!
//! The dialogue is hand-written JSON-RPC over the child's pipes: this target proves a property
//! of the process, so it spawns the binary the way an MCP client does.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use nostream_admin::utils::session;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

/// The literal `SECRET` the daemon is composed with here; the MCP credential does not use it.
const SECRET: &str = "a-test-secret";

/// The fixture password hash `hashAdminPassword` writes for `hunter2`.
const PASSWORD_HASH: &str = "scrypt:BwcHBwcHBwcHBwcHBwcHBw==:r5daXU05UJ9EUDu45YoHMWUoQCmkVbwINYNntY1/dwrJPOt3fTi/1IWw1wp9+YXRj1Vm6IpFi+gSU0JdqZvWIw==";

/// A session token the console's own gate would accept, minted the way `POST /admin/login` does —
/// which this mode must not treat as a credential (R26).
fn session_token() -> String {
    let now: i64 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .try_into()
        .unwrap();
    session::create_token(&session::session_key(SECRET.as_bytes()), now + 3_600)
}

/// The repository root, which the mode reads its `resources/` tree from.
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The token document's text: `{"scopes": [...]}` (R27).
fn token_document(scopes: &[&str]) -> String {
    serde_json::to_string(&json!({ "scopes": scopes })).unwrap()
}

/// Writes `contents` to `path` at mode 0600, the mode the credential requires (R27).
fn write_private(path: &Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// One config dir with the fixture settings, and the token file the mode is started with.
struct Prepared {
    _temp: tempfile::TempDir,
    config_dir: PathBuf,
    token: PathBuf,
}

impl Prepared {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let config_dir = temp.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("settings.yaml"),
            format!(
                "info:\n  name: Example\n  relay_url: ws://127.0.0.1:8008\nadmin:\n  enabled: true\n  passwordHash: \"{PASSWORD_HASH}\"\n"
            ),
        )
        .unwrap();
        let token = temp.path().join("admin-token.json");
        write_private(&token, &token_document(&["write"]));
        Self {
            _temp: temp,
            config_dir,
            token,
        }
    }

    /// The same fixture with payments turned on: the relay path refuses to start without `SECRET`
    /// (`src/app/app.ts:86-94`), and the stdio door, which serves no payments, must not inherit
    /// that refusal (D19: `SECRET` is not a prerequisite for this door).
    fn with_payments() -> Self {
        let prepared = Self::new();
        let settings = prepared.config_dir.join("settings.yaml");
        let mut document = std::fs::read_to_string(&settings).unwrap();
        document.push_str("payments:\n  enabled: true\n");
        std::fs::write(&settings, document).unwrap();
        prepared
    }

    /// The mode's arguments for a dialogue: the config dir, the log level, the mode flag and the
    /// token file.
    fn arguments(&self, extra: &[String]) -> Vec<String> {
        let mut arguments = vec![
            "--config-dir".to_owned(),
            self.config_dir.display().to_string(),
            "--log-level".to_owned(),
            "info".to_owned(),
            "--mcp-stdio".to_owned(),
            "--admin-token-file".to_owned(),
            self.token.display().to_string(),
        ];
        arguments.extend_from_slice(extra);
        arguments
    }
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
    /// Spawns the binary on the prepared config dir and token file.
    fn start(prepared: &Prepared, extra: &[String]) -> Self {
        let mut command = base_command();
        command.args(prepared.arguments(extra));
        Self::spawn(command)
    }

    /// The same, from a command a case built itself — the descriptor case runs the binary under
    /// `sh`, so its parent can open the document as descriptor 3.
    fn spawn(mut command: tokio::process::Command) -> Self {
        let mut child = command.spawn().expect("the daemon starts");
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        let stderr = child.stderr.take().expect("stderr is piped");
        Self {
            child,
            stdin,
            stdout,
            stderr,
            lines: Vec::new(),
            next_id: 0,
        }
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

/// The binary, with the ambient environment removed and the fixture's set: the retired variable
/// must not decide whether a case is authenticated (R26).
fn base_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_nostreamd"));
    command
        .current_dir(workspace_root())
        .env("SECRET", SECRET)
        .env("WORKER_COUNT", "1")
        .env_remove("NOSTREAM_ADMIN_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

/// Spawns the mode with these arguments and environment, and waits for it to exit without a
/// dialogue: for the cases whose point is that it refuses to start.
async fn refusal(arguments: &[String], environment: &[(&str, &str)]) -> (Option<i32>, String) {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_nostreamd"));
    command
        .args(arguments)
        .current_dir(workspace_root())
        .env("SECRET", SECRET)
        .env("WORKER_COUNT", "1")
        .env_remove("NOSTREAM_ADMIN_TOKEN")
        .envs(environment.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = command.output().await.expect("the binary runs");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// The binary with **no** `SECRET`, for the payments refusal: the relay path must answer it and
/// the stdio door must not. Bounded, because a build that lost the refusal would serve a relay
/// here instead of exiting.
async fn without_a_secret(arguments: &[String]) -> (Option<i32>, String) {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_nostreamd"));
    command
        .args(arguments)
        .current_dir(workspace_root())
        .env_remove("SECRET")
        .env("WORKER_COUNT", "1")
        .env_remove("NOSTREAM_ADMIN_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("the binary runs");
    let mut pipe = child.stderr.take().expect("stderr is piped");
    let status = match tokio::time::timeout(Duration::from_secs(20), child.wait()).await {
        Ok(status) => status.expect("the child is reaped"),
        Err(_) => {
            let _ = child.start_kill();
            panic!("the process neither refused nor exited within twenty seconds");
        }
    };
    let mut stderr = String::new();
    pipe.read_to_string(&mut stderr)
        .await
        .expect("stderr drains");
    (status.code(), stderr)
}

#[tokio::test]
async fn the_banner_is_on_stderr_and_stdout_is_json_rpc() {
    let prepared = Prepared::new();
    let mut daemon = Daemon::start(&prepared, &[]);
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
    let prepared = Prepared::new();
    let mut daemon = Daemon::start(&prepared, &[]);
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
    let prepared = Prepared::new();
    let mut daemon = Daemon::start(&prepared, &[]);
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

    let prepared = Prepared::new();
    let mut daemon = Daemon::start(&prepared, &["--listen-port".to_owned(), port.to_string()]);
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
    let prepared = Prepared::new();
    let daemon = Daemon::start(&prepared, &[]);
    let outcome = daemon.finish().await;
    assert_eq!(outcome.status.code(), Some(0), "{}", outcome.stderr);
}

#[tokio::test]
async fn the_store_backed_tools_report_the_unwired_store() {
    let prepared = Prepared::new();
    let mut daemon = Daemon::start(&prepared, &[]);
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
        "--admin-token-file",
        "--admin-token-fd",
        "NOSTREAM_ADMIN_TOKEN",
        "0600",
        "scopes",
        "write",
        "admin.enabled",
    ] {
        assert!(help.contains(needle), "the help names `{needle}`: {help}");
    }
}

/// Proof 1: a console session token in the retired variable does not start the door — the mode
/// names the variable and the flag that replaces it, rather than serving and refusing every call
/// (R26).
#[tokio::test]
async fn a_console_session_token_in_the_environment_refuses_to_start() {
    let prepared = Prepared::new();
    let session_token = session_token();
    let (code, stderr) = refusal(
        &prepared.arguments(&[]),
        &[("NOSTREAM_ADMIN_TOKEN", session_token.as_str())],
    )
    .await;

    assert_eq!(
        code,
        Some(1),
        "the mode exits 1 rather than serving: {stderr}"
    );
    assert!(stderr.contains("NOSTREAM_ADMIN_TOKEN"), "{stderr}");
    assert!(stderr.contains("retired"), "{stderr}");
    assert!(stderr.contains("--admin-token-file"), "{stderr}");
}

/// Proof 2: a token file anyone in the file's group can read is refused at start, and the message
/// names the mode it found and the mode it needs (R27).
#[tokio::test]
async fn a_group_readable_token_file_refuses_to_start() {
    let prepared = Prepared::new();
    std::fs::set_permissions(&prepared.token, std::fs::Permissions::from_mode(0o644)).unwrap();
    let (code, stderr) = refusal(&prepared.arguments(&[]), &[]).await;

    assert_eq!(code, Some(1), "{stderr}");
    assert!(stderr.contains("0644"), "the mode it found: {stderr}");
    assert!(stderr.contains("0600"), "the mode it needs: {stderr}");
}

#[tokio::test]
async fn the_mode_needs_one_credential_flag() {
    let prepared = Prepared::new();
    let neither = vec![
        "--config-dir".to_owned(),
        prepared.config_dir.display().to_string(),
        "--mcp-stdio".to_owned(),
    ];
    let (code, stderr) = refusal(&neither, &[]).await;
    assert_eq!(code, Some(1), "{stderr}");
    assert!(stderr.contains("--admin-token-file"), "{stderr}");
    assert!(stderr.contains("--admin-token-fd"), "{stderr}");

    let mut both = prepared.arguments(&[]);
    both.extend(["--admin-token-fd".to_owned(), "3".to_owned()]);
    let (code, stderr) = refusal(&both, &[]).await;
    assert_eq!(code, Some(2), "clap refuses the pair: {stderr}");
    assert!(stderr.contains("--admin-token-file"), "{stderr}");
    assert!(stderr.contains("--admin-token-fd"), "{stderr}");

    // A credential flag on the relay path is refused rather than ignored: a daemon started with
    // one and no `--mcp-stdio` would look configured and serve the console. `--check` is there so
    // that a silently accepted flag validates the settings and exits rather than binding a socket.
    let mut without_mode = vec![
        "--config-dir".to_owned(),
        prepared.config_dir.display().to_string(),
        "--admin-token-file".to_owned(),
        prepared.token.display().to_string(),
    ];
    without_mode.push("--check".to_owned());
    let (code, stderr) = refusal(&without_mode, &[]).await;
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("--mcp-stdio"), "{stderr}");
}

/// Proof 5: the descriptor form, end to end — the parent opens the document as descriptor 3 and
/// the mode inherits it, so the secret is on neither the command line nor the environment.
#[tokio::test]
async fn an_inherited_descriptor_authenticates() {
    let prepared = Prepared::new();
    let mut shell = tokio::process::Command::new("sh");
    shell
        .arg("-c")
        .arg(
            "exec 3<\"$TOKEN\"; exec \"$BIN\" --config-dir \"$CFG\" --log-level info \
             --mcp-stdio --admin-token-fd 3",
        )
        .current_dir(workspace_root())
        .env("TOKEN", &prepared.token)
        .env("BIN", env!("CARGO_BIN_EXE_nostreamd"))
        .env("CFG", &prepared.config_dir)
        .env("SECRET", SECRET)
        .env("WORKER_COUNT", "1")
        .env_remove("NOSTREAM_ADMIN_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut daemon = Daemon::spawn(shell);
    daemon.initialize().await;
    let listed = daemon.request("tools/list", json!({})).await;
    let read = daemon.call("settings_get", json!({})).await;
    let outcome = daemon.finish().await;

    assert_eq!(
        listed["result"]["tools"].as_array().map(Vec::len),
        Some(4),
        "{listed}"
    );
    assert_eq!(read["result"]["isError"], false, "{read}");
    assert_eq!(outcome.status.code(), Some(0), "{}", outcome.stderr);
}

/// The payments refusal is the relay path's, not the door's: a payment-enabled instance with no
/// `SECRET` still opens the stdio door when its token document is good (D19).
#[tokio::test]
async fn payments_without_a_secret_do_not_stop_the_door() {
    let prepared = Prepared::with_payments();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_nostreamd"));
    command
        .args(prepared.arguments(&[]))
        .current_dir(workspace_root())
        .env_remove("SECRET")
        .env("WORKER_COUNT", "1")
        .env_remove("NOSTREAM_ADMIN_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut daemon = Daemon::spawn(command);
    let result = daemon.initialize().await;
    let outcome = daemon.finish().await;

    assert_eq!(
        result["result"]["serverInfo"]["name"], "nostream",
        "{result}"
    );
    assert!(
        outcome
            .stderr
            .lines()
            .any(|line| line.contains("mcp server on stdio")),
        "the mode reached its banner: {}",
        outcome.stderr
    );
    assert_eq!(outcome.status.code(), Some(0), "{}", outcome.stderr);
}

/// The counterpart: moving the refusal must not be deleting it. The relay path with the same
/// settings and no `SECRET` still refuses, with the capture's own message and exit code `1`.
#[tokio::test]
async fn the_relay_path_still_needs_a_secret_for_payments() {
    let prepared = Prepared::with_payments();
    let arguments = vec![
        "--config-dir".to_owned(),
        prepared.config_dir.display().to_string(),
    ];
    let (code, stderr) = without_a_secret(&arguments).await;

    assert_eq!(code, Some(1), "{stderr}");
    assert!(
        stderr.contains("Please configure the secret using the SECRET environment variable."),
        "{stderr}"
    );
}
