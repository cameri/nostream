//! The CLI surface as an operator meets it: the page, the codes, the streams, and the two PATH
//! shims that make the compose and git commands testable without a daemon.
//!
//! This is the Rust form of `test/unit/cli/cli.integration.spec.ts`: one case per row of the
//! spec's acceptance table, asserting the triple `(stdout, stderr, exit code)` on a spawned
//! binary. Every case runs in a temporary working directory that holds a copy of `resources/`
//! (so `resources/default-settings.yaml` resolves) and, where the case opens a store, a
//! `NOSTR_CONFIG_DIR` selecting LMDB and a `--data-dir`.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use nostream_core::{Event, EventId, Kind, Pubkey, Signature};
use nostream_storage::LmdbBackend;
use nostream_storage::repositories::{EventRecord, EventRepository};

/// The repository root, which the surface cases run from.
fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the workspace root exists")
}

/// Copies `from` into `to`, one level of files and directories, which is all `resources/` is.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("the target directory");

    for entry in fs::read_dir(from).expect("the source directory") {
        let entry = entry.expect("a directory entry");
        let target = to.join(entry.file_name());

        if entry.file_type().expect("a file type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).expect("the file copies");
        }
    }
}

/// One temporary working directory with the repository's `resources/` in it.
struct Work {
    directory: tempfile::TempDir,
}

impl Work {
    fn new() -> Self {
        let directory = tempfile::tempdir().expect("a temporary directory");
        copy_tree(
            &workspace_root().join("resources"),
            &directory.path().join("resources"),
        );
        Self { directory }
    }

    fn path(&self) -> &Path {
        self.directory.path()
    }

    /// Gives the directory a `NOSTR_CONFIG_DIR` holding the given settings document, plus an
    /// LMDB store root, and answers both paths.
    fn with_lmdb_settings(&self, settings: &str) -> PathBuf {
        let config = self.path().join("config");
        fs::create_dir_all(&config).expect("the config directory");
        fs::write(config.join("settings.yaml"), settings).expect("the settings write");
        fs::create_dir_all(self.path().join("data")).expect("the data directory");
        config
    }

    fn data(&self) -> PathBuf {
        self.path().join("data")
    }
}

/// One spawned run in `cwd`, with `env` layered over a clean environment.
fn run_env(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nostream-cli"));

    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", shims(cwd).display()))
        .env("HOME", cwd);

    for (key, value) in env {
        command.env(key, value);
    }

    command.output().expect("the binary runs")
}

/// One spawned run in the repository root.
fn cli(args: &[&str], env: &[(&str, &str)]) -> Output {
    run_env(&workspace_root(), args, env)
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn code(output: &Output) -> i32 {
    output.status.code().expect("the child exited")
}

/// The directory one test's `PATH` shims live in. Each case gets its own, because the cases run
/// in parallel threads and a shared shim would point at the wrong log.
fn shims(cwd: &Path) -> PathBuf {
    let directory = cwd.join(".shims");
    fs::create_dir_all(&directory).expect("the shim directory");
    directory
}

/// Writes one `PATH` shim: a bash script that appends `"$*"` to `log` and exits 0.
fn write_shim(cwd: &Path, name: &str, log: &Path) -> PathBuf {
    write_shim_exiting(cwd, name, log, 0)
}

/// `write_shim`, for a child that must fail: the same log line, then `code`.
fn write_shim_exiting(cwd: &Path, name: &str, log: &Path, code: u8) -> PathBuf {
    let path = shims(cwd).join(name);
    let body = format!(
        "#!/bin/sh\necho \"{name} $*\" >> {log}\nexit {code}\n",
        log = log.display()
    );
    fs::write(&path, body).expect("the shim writes");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .expect("the shim is executable");
    }

    path
}

/// A note by the key `secret`, at `created_at`.
fn note(secret: u8, kind: u64, created_at: i64) -> Event {
    let mut event = Event {
        id: EventId::from_byte_array([0; 32]),
        pubkey: Pubkey::from_byte_array([0; 32]),
        created_at,
        kind: Kind(kind),
        tags: Vec::new(),
        content: format!("row {created_at} [seed]"),
        sig: Signature::from_byte_array([0; 64]),
    };
    nostream_core::crypto::sign_event(&[secret; 32], &mut event).expect("the event signs");
    event
}

/// Writes `events` into the LMDB store under `data`.
async fn write_events(data: &Path, events: Vec<Event>) {
    let backend = LmdbBackend::open(data).await.expect("the store opens");
    let records: Vec<EventRecord> = events.iter().map(EventRecord::from_event).collect();
    backend.create_many(&records).await.expect("the rows write");
}

fn block_on_store<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
        .block_on(future)
}

// ---------------------------------------------------------------------------------------------
// AC1–AC4: the page, the version and the unknown word.
// ---------------------------------------------------------------------------------------------

#[test]
fn ac1_the_page_is_the_captures_on_stdout() {
    for flag in ["--help", "-h"] {
        let output = cli(&[flag], &[("NOSTR_CONFIG_DIR", "/nonexistent")]);
        let page = stdout(&output);

        assert_eq!(code(&output), 0, "{flag}: {}", stderr(&output));
        assert!(stderr(&output).is_empty(), "{flag}: {}", stderr(&output));

        for phrase in [
            "Usage:",
            "start [...args]",
            "stop [...args]",
            "info",
            "update [...args]",
            "clean",
            "import [file] [...args]",
            "export [output] [...args]",
            "seed",
            "invite [...args]",
            "setup",
            "config [...args]",
            "-h, --help",
            "-v, --version",
        ] {
            assert!(page.contains(phrase), "{flag} names `{phrase}`: {page}");
        }

        assert!(
            !page.lines().any(|line| line.contains("dev")),
            "no line names the removed `dev`: {page}"
        );
    }
}

#[test]
fn ac2_no_arguments_prints_the_page_on_stdout() {
    let output = cli(&[], &[]);

    assert_eq!(code(&output), 0);
    assert!(stderr(&output).is_empty(), "{}", stderr(&output));
    assert!(stdout(&output).contains("Usage:"));
    assert_eq!(stdout(&output), stdout(&cli(&["--help"], &[])));
}

#[test]
fn ac3_the_version_page_is_the_crates_own() {
    for flag in ["--version", "-v"] {
        let output = cli(&[flag], &[]);

        assert_eq!(code(&output), 0, "{flag}");
        assert_eq!(
            stdout(&output),
            format!("nostream/{}\n", env!("CARGO_PKG_VERSION")),
            "{flag}"
        );
    }
}

#[test]
fn ac4_an_unknown_word_marks_stderr_and_pages_stdout() {
    let output = cli(&["wobble"], &[]);

    assert_eq!(code(&output), 2);
    assert_eq!(stderr(&output), "Unknown command: wobble\n");
    assert!(stdout(&output).contains("Usage:"));
    assert!(stdout(&output).contains("start [...args]"));
}

// ---------------------------------------------------------------------------------------------
// AC5–AC7, AC59: the three failure shapes.
// ---------------------------------------------------------------------------------------------

#[test]
fn ac5_a_usage_failure_is_prefixed_and_exits_two() {
    let output = cli(&["invite"], &[]);
    assert_eq!(code(&output), 2);
    assert_eq!(
        stderr(&output),
        "Error: Usage: nostream invite create [--uses N] [--expires-in <seconds>] [--json]\n"
    );

    let output = cli(&["invite", "create", "--uses", "0"], &[]);
    assert_eq!(code(&output), 2);
    assert_eq!(
        stderr(&output),
        "Error: --uses must be a positive integer\n"
    );

    let output = cli(&["invite", "create", "--expires-in", "0"], &[]);
    assert_eq!(code(&output), 2);
    assert_eq!(
        stderr(&output),
        "Error: --expires-in must be a positive integer (seconds)\n"
    );
}

#[test]
fn ac6_a_command_failure_keeps_exit_one() {
    let output = cli(&["seed", "--count", "0"], &[]);
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: --count must be a positive integer\n"
    );

    // V5's second boundary: the capture reads its own `argv` for the flag
    // (`src/cli/commands/start.ts:74-78`), so a `--port` with no value after it is the port's
    // own message at exit 1 — answered before the parser runs, at both bare spellings.
    for argv in [vec!["start", "--port"], vec!["start", "--port", "--detach"]] {
        let output = cli(&argv, &[]);
        assert_eq!(code(&output), 1, "{argv:?}");
        assert_eq!(
            stderr(&output),
            "Error: Port must be a safe integer between 1 and 65535\n",
            "{argv:?}"
        );
    }

    let output = cli(&["start", "--port", "70000"], &[]);
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: Port must be a safe integer between 1 and 65535\n"
    );
}

#[test]
fn ac7_the_json_envelope_and_the_bare_line() {
    let output = cli(&["config", "get", "payments.fakeField", "--json"], &[]);
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "{\"error\":{\"message\":\"Path not found: payments.fakeField\",\"code\":1}}\n"
    );

    let output = cli(&["config", "get", "payments.fakeField"], &[]);
    assert_eq!(code(&output), 1);
    assert_eq!(stderr(&output), "Path not found: payments.fakeField\n");
}

// ---------------------------------------------------------------------------------------------
// AC8–AC9: the per-command pages.
// ---------------------------------------------------------------------------------------------

#[test]
fn ac8_the_pages_carry_the_captures_flags() {
    let export = cli(&["export", "--help"], &[]);
    assert_eq!(code(&export), 0);
    let page = stdout(&export);

    for phrase in [
        "--output <output>",
        "--compress",
        "--format <format>",
        "jsonl|json|gzip|gz|xz",
    ] {
        assert!(page.contains(phrase), "export names `{phrase}`: {page}");
    }

    let start = stdout(&cli(&["start", "--help"], &[]));
    for phrase in [
        "--tor",
        "--i2p",
        "--nginx",
        "--debug",
        "--detach",
        "--port <port>",
    ] {
        assert!(start.contains(phrase), "start names `{phrase}`: {start}");
    }
    // The value is required on the page even though a bare flag is answered by hand (V5's
    // second boundary, AC6): an optional value would render `--port [<port>]`.
    assert!(
        !start.contains("[<port>]"),
        "start's page renders `--port <port>`, not an optional value: {start}"
    );

    let info = stdout(&cli(&["info", "--help"], &[]));
    for phrase in ["--tor-hostname", "--i2p-hostname", "--json"] {
        assert!(info.contains(phrase), "info names `{phrase}`: {info}");
    }

    let import = stdout(&cli(&["import", "--help"], &[]));
    for phrase in ["--file", "Path to .jsonl/.json file"] {
        assert!(import.contains(phrase), "import names `{phrase}`: {import}");
    }
    // The page's program name is `nostream`, as on every other page (AC1's rule, R4): the
    // binary's file name is the only place `nostream-cli` belongs.
    assert!(
        import.contains("Usage: nostream import"),
        "import's page names the program: {import}"
    );
    assert!(
        !import.contains("nostream-cli"),
        "no page names the binary: {import}"
    );
}

#[test]
fn ac9_the_nested_pages_name_a_subcommands_usage() {
    for (args, expected) in [
        (
            vec!["config", "get", "--help"],
            "Usage: nostream config get <path>",
        ),
        (
            vec!["config", "env", "--help"],
            "Usage: nostream config env <list|get|set|validate>",
        ),
        (
            vec!["invite", "create", "--help"],
            "Usage: nostream invite create",
        ),
    ] {
        let output = cli(&args, &[]);
        assert_eq!(code(&output), 0, "{args:?}: {}", stderr(&output));
        assert!(
            stdout(&output).contains(expected),
            "{args:?} names `{expected}`: {}",
            stdout(&output)
        );
    }
}

// ---------------------------------------------------------------------------------------------
// AC11–AC14: config.
// ---------------------------------------------------------------------------------------------

#[test]
fn ac11_config_list_prints_both_shapes() {
    let output = cli(&["config", "list"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert!(stdout(&output).contains("payments:"));

    let output = cli(&["config", "list", "--json"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let parsed: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");
    assert!(parsed.get("payments").is_some());
}

/// A reader that closes early ends the output at the command's own code: `println!` panics on
/// the broken pipe, and 101 is outside the surface's 0/1/2 vocabulary (V1). The document is
/// larger than the pipe buffer, so the child has to write into a pipe nobody is reading.
#[test]
fn a_closed_reader_ends_config_list_without_a_panic() {
    let work = Work::new();
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");

    let mut document =
        String::from("eventStore:\n  backend: lmdb\nlimits:\n  rateLimiter:\n    whitelist:\n");
    for index in 0..4_000 {
        document.push_str(&format!(
            "      - 1{index}abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123\n"
        ));
    }
    fs::write(config.join("settings.yaml"), document).expect("the settings write");

    let mut child = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["config", "list"])
        .current_dir(work.path())
        .env("NOSTR_CONFIG_DIR", &config)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("the binary starts");

    {
        use std::io::Read;

        let mut stdout = child.stdout.take().expect("a stdout pipe");
        let mut first = [0u8; 1_024];
        let read = stdout.read(&mut first).expect("the first bytes");
        assert!(read > 0, "the command printed nothing");
        // Dropping the handle closes the read end, so the child's next write is EPIPE.
    }

    let output = child.wait_with_output().expect("the child finishes");
    let reported = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(0),
        "a closed reader is not a failure: {reported}"
    );
    assert!(
        !reported.contains("panicked"),
        "no panic on the broken pipe: {reported}"
    );
}

#[test]
fn ac12_config_set_writes_and_reads_back() {
    let work = Work::new();
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    let env = [("NOSTR_CONFIG_DIR", config.to_str().expect("a path"))];

    let output = run_env(
        work.path(),
        &["config", "set", "limits.event.content[0].maxLength", "2048"],
        &env,
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "Updated limits.event.content[0].maxLength\n"
    );

    let output = run_env(
        work.path(),
        &["config", "get", "limits.event.content[0].maxLength"],
        &env,
    );
    assert_eq!(stdout(&output).trim(), "2048");

    let output = run_env(
        work.path(),
        &[
            "config",
            "set",
            "nip05.domainWhitelist",
            "[\"example.com\",\"relay.io\"]",
            "--type",
            "json",
        ],
        &env,
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let output = run_env(
        work.path(),
        &["config", "get", "nip05.domainWhitelist"],
        &env,
    );
    assert!(
        stdout(&output).contains("example.com"),
        "{}",
        stdout(&output)
    );
}

#[test]
fn ac13_config_set_refuses_an_invalid_value_unless_told_not_to() {
    let work = Work::new();
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    let env = [("NOSTR_CONFIG_DIR", config.to_str().expect("a path"))];

    let output = run_env(
        work.path(),
        &[
            "config",
            "set",
            "limits.rateLimiter.strategy",
            "broken-strategy",
        ],
        &env,
    );
    assert_eq!(code(&output), 1);
    let reported = stderr(&output);
    assert!(
        reported.starts_with("Config update rejected by validation:\n"),
        "the first line is the capture's, bare: {reported}"
    );
    assert!(
        reported.contains("- limits.rateLimiter.strategy: "),
        "{reported}"
    );

    let output = run_env(
        work.path(),
        &["config", "get", "limits.rateLimiter.strategy"],
        &env,
    );
    assert!(stdout(&output).contains("ewma"), "{}", stdout(&output));

    let output = run_env(
        work.path(),
        &[
            "config",
            "set",
            "limits.rateLimiter.strategy",
            "broken-strategy",
            "--no-validate",
        ],
        &env,
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let output = run_env(
        work.path(),
        &["config", "get", "limits.rateLimiter.strategy"],
        &env,
    );
    assert!(stdout(&output).contains("broken-strategy"));
}

#[test]
fn a_failed_restart_keeps_the_written_line() {
    let (work, log) = compose_work();
    write_shim_exiting(work.path(), "docker", &log, 1);
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    fs::write(config.join("settings.yaml"), "info:\n  name: before\n").expect("the settings write");

    let output = run_env(
        work.path(),
        &["config", "set", "info.name", "after", "--restart"],
        &[("NOSTR_CONFIG_DIR", config.to_str().expect("a utf-8 path"))],
    );

    // The file is already written when the restart runs, so its line is the operator's only
    // notice that the value landed: it keeps stdout, where a successful `config set` writes it,
    // and only the restart's step goes to stderr at the step's code.
    assert_eq!(code(&output), 1, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Updated info.name\n");
    assert_eq!(stderr(&output), "Restart failed while stopping relay\n");
    let written = fs::read_to_string(config.join("settings.yaml")).expect("the settings");
    assert!(written.contains("after"), "{written}");
}

/// A restart that cannot even spawn its child is a failure of the restart, not of the write.
/// With no `docker` on `PATH` the settings file is already written, so `Updated <path>` is the
/// operator's only notice that it landed — and the class this arm answers is `Command`, not the
/// `Reported` class the shim case above produces (round 3's code finding 1).
#[test]
fn a_restart_that_cannot_spawn_keeps_the_written_line() {
    let (work, _log) = compose_work();
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    fs::write(config.join("settings.yaml"), "info:\n  name: before\n").expect("the settings write");

    // A `PATH` holding only the shim directory: no `docker` binary, so the spawn fails before the
    // child exists and the arm answers `CliError::Command` rather than the shim's exit code.
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["config", "set", "info.name", "after", "--restart"])
        .current_dir(work.path())
        .env_clear()
        .env("PATH", shims(work.path()))
        .env("HOME", work.path())
        .env("NOSTR_CONFIG_DIR", &config)
        .output()
        .expect("the binary runs");

    assert_eq!(code(&output), 1, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Updated info.name\n");
    assert_eq!(stderr(&output), "Error: docker is not installed\n");
    let written = fs::read_to_string(config.join("settings.yaml")).expect("the settings");
    assert!(written.contains("after"), "{written}");
}

#[test]
fn ac14_config_env_lists_masks_gets_sets_and_validates() {
    let work = Work::new();
    fs::write(work.path().join(".env"), "SECRET=abcdef\nFOO=bar\n").expect("the env file");

    let output = run_env(work.path(), &["config", "env", "list"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let listed = stdout(&output);
    assert!(listed.contains("SECRET=ab***ef"), "{listed}");
    assert!(listed.contains("FOO=bar"), "{listed}");
    assert!(
        listed.find("FOO=bar") < listed.find("SECRET=ab***ef"),
        "sorted by key: {listed}"
    );

    let output = run_env(work.path(), &["config", "env", "get", "SECRET"], &[]);
    assert_eq!(stdout(&output).trim(), "ab***ef");

    let output = run_env(
        work.path(),
        &["config", "env", "get", "SECRET", "--show-secrets"],
        &[],
    );
    assert_eq!(stdout(&output).trim(), "abcdef");

    let output = run_env(work.path(), &["config", "env", "get", "NOPE"], &[]);
    assert_eq!(code(&output), 1);
    assert_eq!(stderr(&output), "Unsupported env key: NOPE\n");

    let output = run_env(
        work.path(),
        &["config", "env", "set", "RELAY_PORT", "x"],
        &[],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(stderr(&output), "RELAY_PORT must be an integer\n");

    let output = run_env(
        work.path(),
        &["config", "env", "set", "RELAY_PORT", "8008"],
        &[],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Updated RELAY_PORT\n");
    assert!(
        fs::read_to_string(work.path().join(".env"))
            .expect("the env file")
            .contains("RELAY_PORT=8008")
    );

    let output = run_env(work.path(), &["config", "env", "validate"], &[]);
    assert_eq!(code(&output), 1);
    let reported = stderr(&output);
    assert!(
        reported.starts_with("Environment validation failed:\n"),
        "{reported}"
    );
    assert!(
        reported.contains("- FOO (FOO): FOO is not a supported environment setting"),
        "{reported}"
    );

    fs::write(work.path().join(".env"), "SECRET=abcdef\n").expect("the env file");
    let output = run_env(work.path(), &["config", "env", "validate"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Environment settings are valid\n");
}

// ---------------------------------------------------------------------------------------------
// AC16–AC21: start, stop, clean and update, over the shims.
// ---------------------------------------------------------------------------------------------

/// A working directory holding a copy of the repository's compose files and `resources/`.
fn compose_work() -> (Work, PathBuf) {
    let work = Work::new();
    let root = workspace_root();

    for entry in fs::read_dir(&root).expect("the repository root") {
        let entry = entry.expect("an entry");
        let name = entry.file_name();
        let name = name.to_string_lossy();

        if name.starts_with("docker-compose") && name.ends_with(".yml") {
            fs::copy(entry.path(), work.path().join(entry.file_name())).expect("the compose file");
        }
    }

    let log = work.path().join("log");
    (work, log)
}

#[test]
fn ac16_start_names_the_flags_overlays_and_the_up_arguments() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);

    let output = run_env(work.path(), &["start", "--tor", "--i2p", "--debug"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(logged.contains("compose"), "{logged}");
    assert!(logged.contains("docker-compose.tor.yml"), "{logged}");
    assert!(logged.contains("docker-compose.i2p.yml"), "{logged}");
    assert!(logged.contains("up --build --remove-orphans"), "{logged}");

    fs::write(&log, "").expect("the log resets");
    let output = run_env(work.path(), &["start", "--detach"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(
        logged.contains("up --build --remove-orphans -d"),
        "{logged}"
    );
}

/// `start` must not overwrite a deployment whose only settings file is the deprecated
/// `settings.json`. Copying the defaults into `settings.yaml` makes the loader prefer them —
/// `nostream_config::load_user_settings` reads the yaml first — so the deployment's overrides
/// would vanish silently on the next start. The capture's own bootstrap has this defect; this
/// port's does not (round 2, the primary's finding).
#[test]
fn a_legacy_settings_json_survives_the_bootstrap() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);

    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    fs::write(
        config.join("settings.json"),
        "{\"limits\":{\"event\":{\"content\":[{\"maxLength\":4242}]}}}",
    )
    .expect("the legacy settings write");
    let env = [("NOSTR_CONFIG_DIR", config.to_str().expect("a utf-8 path"))];

    let output = run_env(work.path(), &["start"], &env);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert!(
        !config.join("settings.yaml").exists(),
        "the bootstrap wrote a settings.yaml over the legacy file"
    );

    let output = run_env(
        work.path(),
        &["config", "get", "limits.event.content[0].maxLength"],
        &env,
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(
        stdout(&output).trim(),
        "4242",
        "the legacy override is still effective: {output:?}"
    );
}

/// A settings file that cannot be parsed is one class everywhere in this surface: the capture's
/// `loadMergedSettings` throws inside the action, so its handler prefixes it
/// (`src/cli/index.ts:40-42`). Round 2 measured `config list` and `config set` reporting it bare
/// while `info`, `export`, `seed`, `invite` and `clean-db` prefixed the same failure.
#[test]
fn a_broken_settings_file_is_prefixed_everywhere() {
    let work = Work::new();
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    fs::write(
        config.join("settings.yaml"),
        "eventStore:\n  backend: [lmdb\n",
    )
    .expect("the settings write");
    let env = [("NOSTR_CONFIG_DIR", config.to_str().expect("a utf-8 path"))];

    for args in [
        &["config", "list"][..],
        &["config", "get", "info.name"][..],
        &["config", "set", "info.name", "changed"][..],
        &["config", "validate"][..],
        &["info"][..],
    ] {
        let output = run_env(work.path(), args, &env);
        let reported = stderr(&output);
        assert_eq!(code(&output), 1, "{args:?}: {reported}");
        assert!(
            reported.starts_with("Error: failed to parse"),
            "{args:?}: {reported}"
        );
    }
}

/// A command that accepted `--json` renders one shape on both paths: the capture envelopes every
/// throw from it, with the class's code (`src/cli/index.ts:116-135`). Round 2 measured
/// `config list --json`, `config get … --json` and `info --json` printing their settings failure
/// as prose, leaving a script only the exit status to branch on.
#[test]
fn a_json_settings_failure_takes_the_envelope() {
    let work = Work::new();
    let config = work.path().join("config");
    fs::create_dir_all(&config).expect("the config directory");
    fs::write(
        config.join("settings.yaml"),
        "eventStore:\n  backend: [lmdb\n",
    )
    .expect("the settings write");
    let env = [("NOSTR_CONFIG_DIR", config.to_str().expect("a utf-8 path"))];

    for args in [
        &["config", "list", "--json"][..],
        &["config", "get", "info.name", "--json"][..],
        &["info", "--json"][..],
    ] {
        let output = run_env(work.path(), args, &env);
        let reported = stderr(&output);
        assert_eq!(code(&output), 1, "{args:?}: {reported}");
        assert!(stdout(&output).is_empty(), "{args:?}: {}", stdout(&output));
        assert!(
            reported.starts_with("{\"error\":{\"message\":\"failed to parse "),
            "{args:?}: {reported}"
        );
        assert!(
            reported.trim_end().ends_with("\"code\":1}}"),
            "{args:?}: {reported}"
        );
    }
}

/// A write that fails is the write's failure, not a panic. `/dev/full` answers `ENOSPC` to every
/// write; `println!`/`eprintln!` turned that into exit 101 with a backtrace where the message
/// belonged — the defect round 2 measured on `--version` and on every error line — and a page
/// that failed to write re-coded an unknown word's answer from 2 to 1. The answer keeps its code
/// and the failure is one line.
#[cfg(target_os = "linux")]
#[test]
fn a_full_disk_does_not_panic_or_recode_the_answer() {
    let full = || {
        std::fs::OpenOptions::new()
            .write(true)
            .open("/dev/full")
            .expect("/dev/full is a writable device")
    };
    let run = |args: &[&str], full_stdout: bool, full_stderr: bool| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nostream-cli"));
        command.args(args);
        if full_stdout {
            command.stdout(full());
        }
        if full_stderr {
            command.stderr(full());
        }
        command.output().expect("the binary runs")
    };

    // The version line is data: a write that failed answers 1, with the line that says why.
    let output = run(&["--version"], true, false);
    assert_eq!(code(&output), 1, "{}", stderr(&output));
    assert!(
        stderr(&output).starts_with("Error: unable to write output:"),
        "{}",
        stderr(&output)
    );
    assert!(!stderr(&output).contains("panicked"), "{}", stderr(&output));

    // An error line whose stream refused it keeps the failure's own code.
    let output = run(&["clean-db", "--older-than=abc"], false, true);
    assert_eq!(code(&output), 1);

    // A page that could not be written keeps the failure's code: 2 was the answer, and the
    // write's own failure is a second stderr line rather than a new code.
    let output = run(&["wobble"], true, false);
    assert_eq!(code(&output), 2, "{}", stderr(&output));
    assert!(
        stderr(&output).starts_with("Unknown command: wobble\n"),
        "{}",
        stderr(&output)
    );

    // And the marker's own stream failing does not lose the page.
    let output = run(&["wobble"], false, true);
    assert_eq!(code(&output), 2);
    assert!(stdout(&output).contains("Usage:"), "{output:?}");
}

/// The `NODE_ENV=production` warning is written **before** the delete, in the capture's order, so
/// a stderr that cannot take it must not abort the run: measured at the base this exited 101 with
/// all three rows still present (round 3's code finding 2, narrowed by the primary's
/// verification). The ordering is not moved — the run goes on and deletes, which is what the
/// second half asserts.
#[cfg(target_os = "linux")]
#[test]
fn a_production_warning_that_cannot_be_written_does_not_stop_the_run() {
    let work = Work::new();
    let config = work.with_lmdb_settings("eventStore:\n  backend: lmdb\n");
    block_on_store(write_events(
        &work.data(),
        vec![
            note(1, 1, 1_700_000_000),
            note(2, 1, 1_700_000_100),
            note(3, 1, 1_700_000_200),
        ],
    ));
    let data = work.data();
    let full = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .expect("/dev/full is a writable device");

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args([
            "clean-db",
            "--older-than=1",
            "--force",
            "--data-dir",
            data.to_str().expect("a utf-8 path"),
        ])
        .current_dir(work.path())
        .env_clear()
        .env(
            "PATH",
            format!("{}:/usr/bin:/bin", shims(work.path()).display()),
        )
        .env("HOME", work.path())
        .env("NODE_ENV", "production")
        .env("NOSTR_CONFIG_DIR", &config)
        .stderr(full)
        .output()
        .expect("the binary runs");

    assert_eq!(
        code(&output),
        0,
        "a warning that cannot be written is not a failure"
    );
    assert_eq!(stdout(&output).trim(), "Deleted 3 events.");

    let output = run_env(
        work.path(),
        &[
            "clean-db",
            "--older-than=1",
            "--dry-run",
            "--data-dir",
            data.to_str().expect("a utf-8 path"),
        ],
        &[("NOSTR_CONFIG_DIR", config.to_str().expect("a utf-8 path"))],
    );
    assert_eq!(
        stdout(&output).trim(),
        "Dry run: 0 events would be deleted."
    );
}

#[test]
fn ac17_the_port_override_file_is_named_then_removed() {
    let (work, log) = compose_work();
    let shim = shims(work.path()).join("docker");
    let copied = work.path().join("override.yml");

    fs::write(
        &shim,
        format!(
            "#!/bin/sh\necho \"docker $*\" >> {log}\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    *nostream-port-override-*.yml) cp \"$arg\" {copied};;\n  esac\ndone\nexit 0\n",
            log = log.display(),
            copied = copied.display()
        ),
    )
    .expect("the shipping shim writes");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).expect("executable");
    }

    let output = run_env(work.path(), &["start", "--port", "9999"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(
        logged.contains("nostream-port-override-"),
        "the log names the override: {logged}"
    );

    let body = fs::read_to_string(&copied).expect("the shim copied the file");
    assert!(body.contains("RELAY_PORT: 9999"), "{body}");
    assert!(body.contains("- 127.0.0.1:9999:9999"), "{body}");

    let leftovers: Vec<_> = fs::read_dir(std::env::temp_dir())
        .expect("the temp directory")
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("nostream-port-override-")
        })
        .collect();
    assert!(
        leftovers.is_empty(),
        "no override survives the run: {leftovers:?}"
    );
}

#[test]
fn ac18_the_nginx_checks_and_the_openssl_shim() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);
    write_shim(work.path(), "openssl", &log);

    let output = run_env(work.path(), &["start", "--nginx"], &[]);
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: RELAY_DOMAIN environment variable is required when using --nginx (example: RELAY_DOMAIN=relay.example.com).\n"
    );

    let output = run_env(
        work.path(),
        &["start", "--nginx"],
        &[("RELAY_DOMAIN", "relay.example.com")],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: CERTBOT_EMAIL environment variable is required when using --nginx (example: CERTBOT_EMAIL=you@example.com).\n"
    );

    let nginx = work.path().join("nginx");
    fs::create_dir_all(nginx.join("conf.d")).expect("the nginx tree");
    fs::write(
        nginx.join("conf.d/nostream.conf.template"),
        "server_name ${RELAY_DOMAIN};\n",
    )
    .expect("the template");

    let output = run_env(
        work.path(),
        &["start", "--nginx"],
        &[
            ("RELAY_DOMAIN", "relay.example.com"),
            ("CERTBOT_EMAIL", "you@example.com"),
        ],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let rendered =
        fs::read_to_string(nginx.join("conf.d/nostream.conf")).expect("the rendered site");
    assert!(rendered.contains("relay.example.com"), "{rendered}");

    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(
        logged.contains("openssl req -x509 -nodes -newkey rsa:2048 -days 1"),
        "{logged}"
    );
    assert!(logged.contains("-subj /CN=relay.example.com"), "{logged}");
}

#[test]
fn ac19_stop_selects_its_overlays_and_defaults_to_all_four() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);

    let output = run_env(work.path(), &["stop"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(logged.contains("down"), "{logged}");
    for overlay in [
        "docker-compose.tor.yml",
        "docker-compose.i2p.yml",
        "docker-compose.nginx.yml",
        "docker-compose.local.yml",
    ] {
        assert!(
            logged.contains(overlay),
            "no flag names {overlay}: {logged}"
        );
    }

    fs::write(&log, "").expect("the log resets");
    let output = run_env(work.path(), &["stop", "--tor"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(logged.contains("docker-compose.tor.yml"), "{logged}");
    for overlay in [
        "docker-compose.i2p.yml",
        "docker-compose.nginx.yml",
        "docker-compose.local.yml",
    ] {
        assert!(!logged.contains(overlay), "--tor names {overlay}: {logged}");
    }
}

#[test]
fn ac20_clean_stops_then_prunes_both_families() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);

    let output = run_env(work.path(), &["clean"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let logged = fs::read_to_string(&log).expect("the shim log");
    let down = logged.find(" down").expect("the down step");
    let system = logged.find("system prune -a -f").expect("the system prune");
    let volume = logged.find("volume prune -f").expect("the volume prune");

    assert!(down < system, "{logged}");
    assert!(system < volume, "{logged}");
}

#[test]
fn ac21_update_is_the_stash_pull_start_sequence() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);

    let git = shims(work.path()).join("git");
    fs::write(
        &git,
        format!(
            "#!/bin/sh\necho \"git $*\" >> {log}\nif [ \"$1\" = stash ] && [ \"$2\" = push ]; then echo 'No local changes to save' >&2; fi\nexit 0\n",
            log = log.display()
        ),
    )
    .expect("the quiet git shim");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).expect("executable");
    }

    let output = run_env(work.path(), &["update"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let logged = fs::read_to_string(&log).expect("the shim log");
    let stash = logged
        .find("git stash push -u -m nostream-cli-update")
        .expect("the stash");
    let pull = logged.find("git pull").expect("the pull");
    assert!(stash < pull, "{logged}");
    assert!(!logged.contains("git stash pop"), "{logged}");
    assert!(logged.contains(" up --build --remove-orphans"), "{logged}");

    fs::write(
        &git,
        format!(
            "#!/bin/sh\necho \"git $*\" >> {log}\nexit 0\n",
            log = log.display()
        ),
    )
    .expect("the loud git shim");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).expect("executable");
    }
    fs::write(&log, "").expect("the log resets");

    let output = run_env(work.path(), &["update"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(
        logged.contains("git stash pop"),
        "a created stash is reapplied: {logged}"
    );

    // The pull's own code is the run's: a shim exiting 2 is the value that tells "the step's
    // code" from a constant 1.
    fs::write(
        &git,
        format!(
            "#!/bin/sh\necho \"git $*\" >> {log}\nif [ \"$1\" = pull ]; then exit 2; fi\nexit 0\n",
            log = log.display()
        ),
    )
    .expect("the failing git shim");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).expect("executable");
    }

    let output = run_env(work.path(), &["update"], &[]);
    assert_eq!(code(&output), 2, "{}", stderr(&output));
    assert_eq!(
        stderr(&output),
        "Update failed while pulling latest changes. Restored stashed local changes.\n"
    );
}

// ---------------------------------------------------------------------------------------------
// AC22–AC27: info.
// ---------------------------------------------------------------------------------------------

/// The shared fixture AC22 names: LMDB selected, `resources/` copied, a store root.
fn info_work() -> (Work, String, String) {
    let work = Work::new();
    let config = work.with_lmdb_settings("eventStore:\n  backend: lmdb\n");
    let (config, data) = (
        config.display().to_string(),
        work.data().display().to_string(),
    );
    (work, config, data)
}

#[test]
fn ac22_info_prints_the_captures_nine_lines() {
    let (work, config, data) = info_work();
    let output = run_env(
        work.path(),
        &["info", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );

    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let expected = format!(
        "Nostream v{version}
Relay: nostream.your-domain.com (wss://nostream.your-domain.com)
Pubkey: replace-with-your-pubkey-in-hex
Signing pubkey (NIP-11 self): unavailable (SECRET not set)
Payments: disabled
Tor hostname: not found
Onion key path: {config}/v3_onion_private_key
Events: 0
Uptime: unavailable
",
        version = env!("CARGO_PKG_VERSION")
    );

    assert_eq!(stdout(&output), expected);
}

#[test]
fn ac23_info_json_is_the_same_data() {
    let (work, config, data) = info_work();
    let output = run_env(
        work.path(),
        &["info", "--json", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let payload: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");

    assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(payload["relay"]["name"], "nostream.your-domain.com");
    assert_eq!(payload["relay"]["url"], "wss://nostream.your-domain.com");
    assert_eq!(payload["relay"]["paymentsEnabled"], false);
    // `resources/default-settings.yaml:17` sets `payments.processor: zebedee`, so the field the
    // capture reads as `settings.payments?.processor ?? null` (`src/cli/commands/info.ts:141`)
    // prints, rather than falling back to null.
    assert_eq!(payload["relay"]["paymentProcessor"], "zebedee");
    assert!(payload["relay"]["signingPubkey"].is_null());
    assert!(payload["tor"]["hostname"].is_null());
    assert_eq!(
        payload["tor"]["onionPrivateKeyPath"],
        format!("{config}/v3_onion_private_key")
    );
    assert_eq!(payload["runtime"]["eventCount"], 0);
    assert!(payload["runtime"]["uptimeSeconds"].is_null());
}

#[test]
fn ac24_the_event_count_is_live_rows_only() {
    let (work, config, data) = info_work();
    block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        backend
            .create_many(&[
                EventRecord::from_event(&note(1, 1, 1_700_000_000)),
                EventRecord::from_event(&note(2, 1, 1_700_000_100)),
                EventRecord::from_event(&note(3, 1, 1_700_000_200)),
            ])
            .await
            .expect("the rows write");
    });

    let output = run_env(
        work.path(),
        &["info", "--json", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    let payload: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");
    assert_eq!(payload["runtime"]["eventCount"], 3);
}

#[test]
fn ac25_the_two_hostname_modes() {
    let (work, config, data) = info_work();

    let output = run_env(
        work.path(),
        &["info", "--tor-hostname", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Tor hostname not found. Start with `nostream start --tor` first.\n"
    );

    let hostname = work.path().join(".nostr/tor/data/nostream");
    fs::create_dir_all(&hostname).expect("the tor data directory");
    fs::write(hostname.join("hostname"), "abcdef.onion\n").expect("the hostname");

    let output = run_env(
        work.path(),
        &["info", "--tor-hostname", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "abcdef.onion\n");

    let output = run_env(
        work.path(),
        &["info", "--tor-hostname", "--json", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    let payload: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");
    assert_eq!(payload["torHostname"], "abcdef.onion");

    let output = run_env(
        work.path(),
        &["info", "--i2p-hostname", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1);
    let reported = stderr(&output);
    assert!(
        reported.starts_with("I2P destination keys not found. Is the i2pd container running?\n"),
        "{reported}"
    );
    assert!(reported.contains("Expected: "), "{reported}");
}

#[test]
fn ac26_uptime_is_the_containers_and_formatted() {
    let (work, config, data) = info_work();
    let shim = shims(work.path()).join("docker");
    let started = (chrono::Utc::now() - chrono::Duration::seconds(90))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    fs::write(
        &shim,
        format!(
            "#!/bin/sh\ncase \"$1\" in\n  compose) echo abc ;;\n  inspect) echo {started} ;;\nesac\nexit 0\n"
        ),
    )
    .expect("the docker shim");
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o755)).expect("executable");
    }

    let output = run_env(
        work.path(),
        &["info", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert!(
        stdout(&output).contains("Uptime: 1m 30s"),
        "{}",
        stdout(&output)
    );
}

#[test]
fn ac27_the_signing_pubkey_is_derived_and_agrees() {
    let (work, config, data) = info_work();
    let secret = "01".repeat(32);
    let expected = nostream_core::crypto::public_key(&[0x01; 32])
        .expect("the public key derives")
        .to_string();

    let output = run_env(
        work.path(),
        &["info", "--data-dir", &data],
        &[
            ("NOSTR_CONFIG_DIR", &config),
            ("RELAY_PRIVATE_KEY", &secret),
        ],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert!(
        stdout(&output).contains(&format!("Signing pubkey (NIP-11 self): {expected}")),
        "{}",
        stdout(&output)
    );

    let output = run_env(
        work.path(),
        &["info", "--json", "--data-dir", &data],
        &[
            ("NOSTR_CONFIG_DIR", &config),
            ("RELAY_PRIVATE_KEY", &secret),
        ],
    );
    let payload: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");
    assert_eq!(payload["relay"]["signingPubkey"], expected);
}

// ---------------------------------------------------------------------------------------------
// AC28–AC29: seed.
// ---------------------------------------------------------------------------------------------

/// A working directory with the repository's `resources/` and `seeds/` in it.
fn seed_work() -> (Work, String, String) {
    let work = Work::new();
    copy_tree(&workspace_root().join("seeds"), &work.path().join("seeds"));
    let config = work.with_lmdb_settings("eventStore:\n  backend: lmdb\n");
    let (config, data) = (
        config.display().to_string(),
        work.data().display().to_string(),
    );
    (work, config, data)
}

#[test]
fn ac28_seed_count_writes_the_expansion_over_a_clean_store() {
    let (work, config, data) = seed_work();

    block_on_store(write_events(&work.data(), vec![note(9, 1, 1_600_000_000)]));

    let output = run_env(
        work.path(),
        &["seed", "--count", "3", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let contents = block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        let mut rows = Vec::new();
        let mut stream = backend
            .scan_live(None, nostream_storage::MAX_PAGE_ROWS)
            .await
            .expect("the scan opens");

        use futures_util::StreamExt;
        while let Some(item) = stream.next().await {
            rows.push(item.expect("a row"));
        }
        rows
    });

    assert_eq!(contents.len(), 3, "the pre-existing row is gone");
    let mut suffixes: Vec<String> = contents
        .iter()
        .map(|record| {
            record.event.content[record.event.content.rfind("[seed:").expect("a suffix")..]
                .to_owned()
        })
        .collect();
    suffixes.sort();
    assert_eq!(suffixes, vec!["[seed:1]", "[seed:2]", "[seed:3]"]);

    for record in &contents {
        nostream_core::crypto::verify_event_signature(&record.event)
            .expect("the synthetic key signed it");
    }
}

#[test]
fn ac29_seed_with_no_count_writes_the_fixture() {
    let (work, config, data) = seed_work();

    let output = run_env(
        work.path(),
        &["seed", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let count = block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        backend
            .count_by_filters(&[nostream_core::Filter::default()])
            .await
            .expect("the count answers")
    });

    assert_eq!(count, 463);
}

// ---------------------------------------------------------------------------------------------
// AC30–AC32: invite.
// ---------------------------------------------------------------------------------------------

#[test]
fn ac30_invite_refuses_a_missing_database_with_the_hint() {
    let output = cli(&["invite", "create"], &[]);

    assert_eq!(code(&output), 1);
    let reported = stderr(&output);
    assert!(
        reported.starts_with("Error: PostgreSQL is not configured (set DB_URI or DB_HOST).\n\n"),
        "{reported}"
    );
    assert!(
        reported.contains(
            "If Nostream is running in Docker, Postgres is not published to the host. Run:"
        ),
        "{reported}"
    );
    assert!(
        reported.contains("If PostgreSQL is local, set DB_URI or DB_HOST (see .env.example)."),
        "{reported}"
    );
}

#[test]
fn ac31_invite_create_mints_and_prints_two_ways() {
    let (work, config, data) = info_work();

    let output = run_env(
        work.path(),
        &["invite", "create", "--json", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let payload: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");
    for key in [
        "code",
        "createdBy",
        "claimedBy",
        "expiresAt",
        "remainingUses",
        "createdAt",
        "updatedAt",
    ] {
        assert!(payload.get(key).is_some(), "the payload names {key}");
    }
    assert_eq!(payload["remainingUses"], 1);
    let minted = payload["code"].as_str().expect("a code");
    assert_eq!(minted.len(), 32, "16 bytes of hex: {minted}");
    assert!(
        minted
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );

    let output = run_env(
        work.path(),
        &["invite", "create", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let printed = stdout(&output);
    let lines: Vec<&str> = printed.lines().collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert!(lines[1].starts_with("uses: "), "{lines:?}");
    assert!(lines[2].starts_with("expires: "), "{lines:?}");
}

/// AC31's `--json` failures: the capture's handler takes JSON mode from the options object, so a
/// command that accepted `--json` answers every failure with the envelope and the class's code —
/// not the human `Error: …` line (`src/cli/index.ts:116-135`).
#[test]
fn the_invite_json_failures_carry_the_envelope() {
    let (work, config, _data) = info_work();

    let output = run_env(
        work.path(),
        &["invite", "create", "--json", "--uses", "0"],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 2, "{}", stderr(&output));
    assert_eq!(
        stderr(&output),
        "{\"error\":{\"message\":\"--uses must be a positive integer\",\"code\":2}}\n"
    );

    // A safe integer no instant can hold is refused rather than panicking (Amendment 3).
    let output = run_env(
        work.path(),
        &[
            "invite",
            "create",
            "--json",
            "--expires-in",
            "9223372036854775807",
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 2, "{}", stderr(&output));
    assert_eq!(
        stderr(&output),
        "{\"error\":{\"message\":\"--expires-in must be a positive integer (seconds)\",\"code\":2}}\n"
    );

    // The store refusal is the thrown class: error 1, enveloped.
    let output = run_env(
        work.path(),
        &["invite", "create", "--json"],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1, "{}", stderr(&output));
    assert_eq!(
        stderr(&output),
        "{\"error\":{\"message\":\"the lmdb backend needs --data-dir <path>\",\"code\":1}}\n"
    );
}

#[test]
fn ac32_info_self_is_hex_or_npub_and_a_bad_npub_is_refused() {
    let (work, config, data) = info_work();
    let npub = "npub1yt5qf5nw694k3k6jt8ncgj0fdk4463jv3arshk37kxnsgeljc7fsmhwffw";
    let hex = "22e804d26ed16b68db5259e78449e96dab5d464c8f470bda3eb1a70467f2c793";

    for (value, expected) in [
        (npub.to_owned(), Some(hex.to_owned())),
        (hex.to_uppercase(), Some(hex.to_owned())),
        ("replace-with-your-pubkey-in-hex".to_owned(), None),
    ] {
        fs::write(
            config_path(Path::new(&config)),
            format!("eventStore:\n  backend: lmdb\ninfo:\n  self: \"{value}\"\n"),
        )
        .expect("the settings write");

        let output = run_env(
            work.path(),
            &["invite", "create", "--json", "--data-dir", &data],
            &[("NOSTR_CONFIG_DIR", &config)],
        );
        assert_eq!(code(&output), 0, "{value}: {}", stderr(&output));
        let payload: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("JSON");
        assert_eq!(
            payload["createdBy"].as_str().map(str::to_owned),
            expected,
            "{value}"
        );
    }

    fs::write(
        config_path(Path::new(&config)),
        "eventStore:\n  backend: lmdb\ninfo:\n  self: \"npub1invalid\"\n",
    )
    .expect("the settings write");

    // AC32's bytes: the thrown failure, prefixed, at exit 1. The invocation names no `--json`,
    // which is the class the criterion pins.
    let output = run_env(
        work.path(),
        &["invite", "create", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: info.self npub did not decode to a 32-byte pubkey\n"
    );

    // The same failure under `--json` is the envelope, with the class's code (R3).
    let output = run_env(
        work.path(),
        &["invite", "create", "--json", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "{\"error\":{\"message\":\"info.self npub did not decode to a 32-byte pubkey\",\"code\":1}}\n"
    );
}

/// The `settings.yaml` a `NOSTR_CONFIG_DIR` holds.
fn config_path(config: &Path) -> PathBuf {
    config.join("settings.yaml")
}

// ---------------------------------------------------------------------------------------------
// AC33–AC35: setup.
// ---------------------------------------------------------------------------------------------

/// A working directory with the repository's `resources/` and `.env.example`.
fn setup_work() -> Work {
    let work = Work::new();
    fs::copy(
        workspace_root().join(".env.example"),
        work.path().join(".env.example"),
    )
    .expect("the example");
    work
}

#[test]
fn ac33_setup_yes_bootstraps_the_env_with_a_generated_secret() {
    let work = setup_work();
    let output = run_env(work.path(), &["setup", "--yes"], &[]);

    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let written = fs::read_to_string(work.path().join(".env")).expect("the env file");
    let secret_lines: Vec<&str> = written
        .lines()
        .filter(|line| line.starts_with("SECRET="))
        .collect();

    assert_eq!(secret_lines.len(), 1, "{written}");
    let value = secret_lines[0]
        .trim_start_matches("SECRET=")
        .split(' ')
        .next()
        .expect("a value");
    assert_eq!(value.len(), 128, "{value}");
    assert!(
        value
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()),
        "{value}"
    );
    assert!(
        secret_lines[0].contains("# Generate: openssl rand -hex 128"),
        "{written}"
    );

    let example = fs::read_to_string(work.path().join(".env.example")).expect("the example");
    assert_eq!(
        written.lines().count(),
        example.lines().count(),
        "every other line survives"
    );
}

#[test]
fn ac34_setup_keeps_a_real_secret_and_honours_the_environment() {
    let work = setup_work();

    fs::write(work.path().join(".env"), "SECRET=real-secret\nFOO=bar\n").expect("the env file");
    let before = fs::read_to_string(work.path().join(".env")).expect("the env file");
    let output = run_env(work.path(), &["setup", "--yes"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(
        fs::read_to_string(work.path().join(".env")).expect("the env file"),
        before
    );

    fs::write(
        work.path().join(".env"),
        "SECRET=change_me_to_something_long_and_random # Generate: openssl rand -hex 128\n",
    )
    .expect("the env file");
    let output = run_env(
        work.path(),
        &["setup", "--yes"],
        &[("SECRET", "env-secret")],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(
        fs::read_to_string(work.path().join(".env")).expect("the env file"),
        "SECRET=env-secret # Generate: openssl rand -hex 128\n"
    );

    fs::write(work.path().join(".env"), "SECRET=   # existing comment\n").expect("the env file");
    let output = run_env(
        work.path(),
        &["setup", "--yes"],
        &[("SECRET", "env-secret")],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(
        fs::read_to_string(work.path().join(".env")).expect("the env file"),
        "SECRET=env-secret # existing comment\n"
    );
}

#[test]
fn ac35_setup_start_starts_the_stack() {
    let (work, log) = compose_work();
    write_shim(work.path(), "docker", &log);
    fs::copy(
        workspace_root().join(".env.example"),
        work.path().join(".env.example"),
    )
    .expect("the example");

    let output = run_env(work.path(), &["setup", "--yes"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert!(
        !log.exists(),
        "no compose run without --start: {:?}",
        fs::read_to_string(&log)
    );

    let output = run_env(work.path(), &["setup", "--yes", "--start"], &[]);
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let logged = fs::read_to_string(&log).expect("the shim log");
    assert!(logged.contains("up --build --remove-orphans"), "{logged}");
}

// ---------------------------------------------------------------------------------------------
// AC36–AC39, AC41: export.
// ---------------------------------------------------------------------------------------------

/// A store of three live rows and one soft-deleted row, and the export's fixture.
fn export_work() -> (Work, String, String) {
    let (work, config, data) = info_work();
    block_on_store(write_events(
        &work.data(),
        vec![note(1, 1, 30), note(2, 1, 10), note(3, 1, 20)],
    ));
    (work, config, data)
}

#[test]
fn ac36_the_jsonl_export_ascends_and_summarises_without_a_suffix() {
    let (work, config, data) = export_work();
    let output_path = work.path().join("out.jsonl");

    let output = run_env(
        work.path(),
        &[
            "export",
            &output_path.display().to_string(),
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let written = fs::read_to_string(&output_path).expect("the export writes");
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(lines.len(), 3, "{written}");

    let parsed: Vec<serde_json::Value> = lines
        .iter()
        .map(|line| serde_json::from_str(line).expect("a row"))
        .collect();
    for key in [
        "id",
        "pubkey",
        "created_at",
        "kind",
        "tags",
        "content",
        "sig",
    ] {
        assert!(parsed[0].get(key).is_some(), "the row names {key}");
    }
    let mut times: Vec<i64> = parsed
        .iter()
        .map(|row| row["created_at"].as_i64().expect("a timestamp"))
        .collect();
    assert_eq!(times, {
        let mut sorted = times.clone();
        sorted.sort();
        sorted
    });
    times.clear();

    assert!(
        stdout(&output).contains(&format!(
            "Export complete: 3 events written to {}",
            output_path.display()
        )),
        "{}",
        stdout(&output)
    );
    assert!(!stdout(&output).contains("(jsonl)"), "{}", stdout(&output));
}

#[test]
fn ac37_the_json_array_shape_and_its_extension_rule() {
    let (work, config, data) = export_work();
    let output_path = work.path().join("out.json");

    let output = run_env(
        work.path(),
        &[
            "export",
            &output_path.display().to_string(),
            "--format",
            "json",
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let written = fs::read_to_string(&output_path).expect("the export writes");
    assert!(written.starts_with('['), "{written}");
    assert!(written.trim_end().ends_with(']'), "{written}");
    let parsed: serde_json::Value = serde_json::from_str(&written).expect("the array parses");
    assert_eq!(parsed.as_array().expect("an array").len(), 3);
    assert!(
        stdout(&output).contains(&format!("written to {} (json)", output_path.display())),
        "{}",
        stdout(&output)
    );

    let wrong = work.path().join("out2.jsonl");
    let output = run_env(
        work.path(),
        &[
            "export",
            &wrong.display().to_string(),
            "--format",
            "json",
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: Output file extension must be .json when using --format json\n"
    );
}

#[test]
fn ac38_the_two_compressed_shapes() {
    let (work, config, data) = export_work();

    let gz = work.path().join("out.jsonl.gz");
    let output = run_env(
        work.path(),
        &[
            "export",
            &gz.display().to_string(),
            "-z",
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let bytes = fs::read(&gz).expect("the export writes");
    assert_eq!(&bytes[..2], &[0x1f, 0x8b], "the gzip magic");
    let printed = stdout(&output);
    assert!(printed.contains("using gzip compression"), "{printed}");
    assert!(printed.contains("Size: "), "{printed}");
    assert!(printed.contains("Throughput: "), "{printed}");

    let xz = work.path().join("out.xz");
    let output = run_env(
        work.path(),
        &[
            "export",
            &xz.display().to_string(),
            "-z",
            "--format",
            "xz",
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    let bytes = fs::read(&xz).expect("the export writes");
    assert_eq!(
        &bytes[..6],
        &[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
        "the xz magic"
    );
    assert!(stdout(&output).contains("using xz compression"));

    let output = run_env(
        work.path(),
        &[
            "export",
            &work.path().join("bad.xz").display().to_string(),
            "-z",
            "--format",
            "xz",
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config), ("NOSTREAM_XZ_PRESET", "10")],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Error: Invalid NOSTREAM_XZ_PRESET: 10. Expected an integer between 0 and 9.\n"
    );
}

#[test]
fn ac39_the_flag_conflicts_are_usage_errors() {
    let (work, config, data) = export_work();
    let env = [("NOSTR_CONFIG_DIR", &*config)];
    let path = work.path().join("out.jsonl").display().to_string();

    let output = run_env(
        work.path(),
        &["export", &path, "--format", "bogus", "--data-dir", &data],
        &env,
    );
    assert_eq!(code(&output), 2);
    assert_eq!(
        stderr(&output),
        "Error: Unsupported format: bogus. Supported values: json, jsonl, gzip, gz, xz\n"
    );

    let output = run_env(
        work.path(),
        &[
            "export",
            &path,
            "--compress",
            "--format",
            "json",
            "--data-dir",
            &data,
        ],
        &env,
    );
    assert_eq!(code(&output), 2);
    assert_eq!(
        stderr(&output),
        "Error: Cannot combine --compress with --format json/jsonl.\n"
    );

    let output = run_env(
        work.path(),
        &["export", &path, "--format", "xz", "--data-dir", &data],
        &env,
    );
    assert_eq!(code(&output), 1);
    assert_eq!(stderr(&output), "Error: --format requires --compress\n");
}

#[test]
fn ac41_an_empty_store_exports_nothing_and_writes_no_file() {
    let (work, config, data) = info_work();
    let output_path = work.path().join("out.jsonl");

    let output = run_env(
        work.path(),
        &[
            "export",
            &output_path.display().to_string(),
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );

    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "No events to export.\n");
    assert!(!output_path.exists(), "no file is written");
}

// ---------------------------------------------------------------------------------------------
// AC44–AC49: clean-db.
// ---------------------------------------------------------------------------------------------

#[test]
fn ac44_dry_run_counts_and_deletes_nothing() {
    let (work, config, data) = info_work();
    block_on_store(write_events(
        &work.data(),
        vec![note(1, 1, 1_700_000_000), note(2, 1, 1_700_000_100)],
    ));

    let output = run_env(
        work.path(),
        &["clean-db", "--dry-run", "--all", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Dry run: 2 events would be deleted.\n");

    let count = block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        backend
            .count_by_filters(&[nostream_core::Filter::default()])
            .await
            .expect("the count answers")
    });
    assert_eq!(count, 2, "nothing was deleted");
}

#[test]
fn ac45_all_empties_the_event_store_and_nothing_else() {
    let (work, config, data) = info_work();

    let minted = run_env(
        work.path(),
        &["invite", "create", "--json", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&minted), 0, "{}", stderr(&minted));
    let code_of =
        serde_json::from_str::<serde_json::Value>(&stdout(&minted)).expect("JSON")["code"]
            .as_str()
            .expect("a code")
            .to_owned();

    let output = run_env(
        work.path(),
        &["clean-db", "--all", "--force", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Deleted all events.\n");

    let answers = block_on_store(async {
        use nostream_storage::repositories::InviteCodeRepository;
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        let events = backend
            .count_by_filters(&[nostream_core::Filter::default()])
            .await
            .expect("the count answers");
        let invite = backend
            .find_by_code(&code_of)
            .await
            .expect("the invite reads");
        (events, invite.is_some())
    });

    assert_eq!(answers, (0, true), "the invite row survives");
}

#[test]
fn ac46_older_than_deletes_only_what_is_past_the_cutoff() {
    let (work, config, data) = info_work();
    let now = chrono::Utc::now().timestamp();
    let past = now - 31 * 86_400;
    let kept_late = now - 30 * 86_400 + 60;
    let kept = now - 29 * 86_400;

    block_on_store(write_events(
        &work.data(),
        vec![note(1, 1, past), note(2, 1, kept_late), note(3, 1, kept)],
    ));

    let output = run_env(
        work.path(),
        &[
            "clean-db",
            "--older-than=30",
            "--force",
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Deleted 1 events.\n");

    let surviving = block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        backend
            .count_by_filters(&[nostream_core::Filter::default()])
            .await
            .expect("the count answers")
    });
    assert_eq!(surviving, 2);
}

#[test]
fn ac47_kinds_and_the_combination_select_their_rows() {
    let (work, config, data) = info_work();
    let now = chrono::Utc::now().timestamp();
    let old = now - 40 * 86_400;

    block_on_store(write_events(
        &work.data(),
        vec![note(1, 1, old), note(2, 7, old), note(3, 4, old)],
    ));

    let output = run_env(
        work.path(),
        &["clean-db", "--kinds=1,7", "--force", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert_eq!(stdout(&output), "Deleted 2 events.\n");

    let remaining = block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        backend
            .count_by_filters(&[nostream_core::Filter::default()])
            .await
            .expect("the count answers")
    });
    assert_eq!(remaining, 1, "kind 4 remains");
}

#[test]
fn ac48_the_non_tty_refusal_and_the_production_warning() {
    let (work, config, data) = info_work();

    let output = run_env(
        work.path(),
        &["clean-db", "--all", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 1);
    assert_eq!(
        stderr(&output),
        "Interactive confirmation is unavailable. Re-run with --force.\n"
    );

    let output = run_env(
        work.path(),
        &["clean-db", "--all", "--force", "--data-dir", &data],
        &[("NOSTR_CONFIG_DIR", &config), ("NODE_ENV", "production")],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));
    assert!(
        stderr(&output).contains(
            "WARNING: NODE_ENV=production detected. This operation permanently deletes data."
        ),
        "{}",
        stderr(&output)
    );
}

#[test]
fn ac49_clean_db_help_is_the_captures_page() {
    let output = cli(&["clean-db", "--help"], &[]);

    assert_eq!(code(&output), 0);
    let page = stdout(&output);

    for option in [
        "--all",
        "--older-than=<days>",
        "--kinds=<1,7,4>",
        "--dry-run",
        "--force",
        "--help",
    ] {
        assert!(page.contains(option), "the page names {option}: {page}");
    }
    assert_eq!(page.matches("nostream clean-db").count(), 5, "{page}");
    assert!(!page.contains("dev db:clean"), "{page}");
}

#[test]
fn clean_dbs_store_refusal_carries_the_prefix() {
    let work = Work::new();
    let config = work.with_lmdb_settings("eventStore:\n  backend: lmdb\n");

    // The parser's and the database's own failures are the capture's and print bare; the store
    // seam is the port's, and its refusal is C3's class A, the shape `export` and `seed` give it.
    let output = run_env(
        work.path(),
        &["clean-db", "--all", "--force"],
        &[("NOSTR_CONFIG_DIR", config.to_str().expect("a utf-8 path"))],
    );

    assert_eq!(code(&output), 1, "{}", stderr(&output));
    assert_eq!(
        stderr(&output),
        "Error: the lmdb backend needs --data-dir <path>\n"
    );
}

#[test]
fn ac40_the_scan_pages_past_one_page_bound() {
    let (work, config, data) = info_work();
    let rows = 12_001;

    block_on_store(async {
        let backend = LmdbBackend::open(&work.data())
            .await
            .expect("the store opens");
        let events: Vec<Event> = (0..rows)
            .map(|index| note(11, 1, 1_700_000_000 + index))
            .collect();
        let records: Vec<EventRecord> = events.iter().map(EventRecord::from_event).collect();
        backend.create_many(&records).await.expect("the rows write");
    });

    let output_path = work.path().join("all.jsonl");
    let output = run_env(
        work.path(),
        &[
            "export",
            &output_path.display().to_string(),
            "--data-dir",
            &data,
        ],
        &[("NOSTR_CONFIG_DIR", &config)],
    );
    assert_eq!(code(&output), 0, "{}", stderr(&output));

    let written = fs::read_to_string(&output_path).expect("the export writes");
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(lines.len(), rows as usize, "three pages, none truncated");

    let times: Vec<i64> = lines
        .iter()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).expect("a row")["created_at"]
                .as_i64()
                .expect("a timestamp")
        })
        .collect();
    assert!(
        times.windows(2).all(|pair| pair[0] <= pair[1]),
        "the export ascends through every page"
    );
}
