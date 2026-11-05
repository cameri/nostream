//! The `import` command's surface: its parser, its input checks, its output order and the
//! honest failure when the database is unreachable.
//!
//! Mirrors `src/import-events.ts`. The capture's parser is hand-written, so the messages here
//! are the assertion, not clap's.
//!
//! These targets may unwrap and assert by panicking: a failed assertion is a failed test.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use nostream_cli::commands::import::{self, ImportFormat, ParsedArgs};
use nostream_core::Kind;
use nostream_services::testing::{RecordingPersister, signed_event};

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn cli(values: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .arg("import")
        .args(values)
        .output()
        .expect("the binary runs")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../")
        .canonicalize()
        .expect("the workspace root exists")
}

fn an_event_line() -> String {
    let event = signed_event(&[1; 32], Kind::TEXT_NOTE, vec![], "hello");

    serde_json::to_string(&event).expect("serialize")
}

#[test]
fn the_parser_rejects_every_bad_invocation() {
    assert_eq!(
        import::parse_args(&args(&[])).unwrap_err().to_string(),
        "Missing path to .jsonl or .json file"
    );
    assert_eq!(
        import::parse_args(&args(&["--batch-size", "0"]))
            .unwrap_err()
            .to_string(),
        "Invalid --batch-size value: 0"
    );
    assert_eq!(
        import::parse_args(&args(&["--batch-size=abc"]))
            .unwrap_err()
            .to_string(),
        "Invalid --batch-size value: abc"
    );
    assert_eq!(
        import::parse_args(&args(&["--batch-size"]))
            .unwrap_err()
            .to_string(),
        "Missing value for --batch-size"
    );
    assert_eq!(
        import::parse_args(&args(&["--file", "events.jsonl"]))
            .unwrap_err()
            .to_string(),
        "Unknown option: --file"
    );
    assert_eq!(
        import::parse_args(&args(&["--help"])).expect("help"),
        ParsedArgs::Help
    );
    assert_eq!(
        import::parse_args(&args(&["events.jsonl", "--batch-size", "25"])).expect("run"),
        ParsedArgs::Run {
            file: PathBuf::from("events.jsonl"),
            batch_size: 25,
        }
    );
}

#[test]
fn the_input_checks_name_what_is_wrong() {
    let directory = tempfile::tempdir().expect("tempdir");

    let missing = directory.path().join("nope.jsonl");
    assert_eq!(
        import::validate_input(directory.path(), Path::new("nope.jsonl"))
            .unwrap_err()
            .to_string(),
        format!("Input file does not exist: {}", missing.display())
    );

    fs::create_dir(directory.path().join("directory.jsonl")).expect("mkdir");
    assert_eq!(
        import::validate_input(directory.path(), Path::new("directory.jsonl"))
            .unwrap_err()
            .to_string(),
        format!(
            "Input path is not a file: {}",
            directory.path().join("directory.jsonl").display()
        )
    );

    fs::write(directory.path().join("events.txt"), "").expect("write");
    assert_eq!(
        import::validate_input(directory.path(), Path::new("events.txt"))
            .unwrap_err()
            .to_string(),
        "Input file must have a .jsonl or .json extension"
    );

    fs::write(directory.path().join("events.JSON"), "[]").expect("write");
    assert_eq!(
        import::validate_input(directory.path(), Path::new("events.JSON"))
            .expect("the extension is case-insensitive")
            .1,
        ImportFormat::Json
    );
}

#[test]
fn the_binary_exits_one_and_says_why() {
    let output = cli(&[]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Missing path to .jsonl or .json file"),
        "{}",
        stderr(&output)
    );

    let output = cli(&["--batch-size", "0"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("Invalid --batch-size value: 0"));

    let output = cli(&["--batch-size=abc"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("Invalid --batch-size value: abc"));

    let output = cli(&["--batch-size"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("Missing value for --batch-size"));

    let output = cli(&["--file", "events.jsonl"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("Unknown option: --file"));

    let directory = tempfile::tempdir().expect("tempdir");
    let missing = directory.path().join("gone.jsonl");
    let output = cli(&[missing.to_str().expect("utf-8")]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains(&format!("Input file does not exist: {}", missing.display())),
        "{}",
        stderr(&output)
    );

    fs::write(directory.path().join("events.txt"), "").expect("write");
    let output = cli(&[directory.path().join("events.txt").to_str().expect("utf-8")]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("Input file must have a .jsonl or .json extension"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn help_exits_zero_and_names_the_file_and_the_batch_flag() {
    let output = cli(&["--help"]);

    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--batch-size"), "{stdout}");
    assert!(stdout.contains(".jsonl"), "{stdout}");
    assert!(
        stdout.contains("The .jsonl or .json file to import"),
        "{stdout}"
    );
}

/// `import` parses its own arguments, so clap cannot render a correct page for it through a
/// `help` subcommand; the route is gone and `import --help` is the only one.
#[test]
fn the_help_route_does_not_print_a_second_import_page() {
    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["help", "import"])
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(2), "{}", stderr(&output));
    assert!(
        stderr(&output).contains("unrecognized subcommand"),
        "{}",
        stderr(&output)
    );
}

#[tokio::test]
async fn a_successful_import_prints_progress_then_the_summary() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("events.jsonl");
    let line = an_event_line();
    fs::write(&path, format!("{line}\n{line}\n")).expect("write");
    let persister = RecordingPersister::new();

    let output = import::import_with(&path, ImportFormat::Jsonl, 1, persister)
        .await
        .expect("import");

    assert_eq!(output.exit_code, 0);
    assert_eq!(
        output.lines[0],
        "[Processed: 1 | Inserted: 1 | Skipped: 0 | Errors: 0]"
    );
    assert_eq!(
        output.lines[1],
        "[Processed: 2 | Inserted: 2 | Skipped: 0 | Errors: 0]"
    );
    assert!(
        output.lines[2].starts_with("Import completed in ") && output.lines[2].ends_with('s'),
        "{}",
        output.lines[2]
    );
    assert_eq!(
        output.lines[3],
        "[Processed: 2 | Inserted: 2 | Skipped: 0 | Errors: 0]"
    );
    assert_eq!(output.lines.len(), 4);
}

#[tokio::test]
async fn the_counters_use_en_us_separators() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("events.jsonl");
    let line = an_event_line();
    fs::write(&path, vec![line.as_str(); 1_000].join("\n")).expect("write");
    let persister = RecordingPersister::new();

    let output = import::import_with(&path, ImportFormat::Jsonl, 1_000, persister)
        .await
        .expect("import");

    assert_eq!(
        output.lines[0],
        "[Processed: 1,000 | Inserted: 1,000 | Skipped: 0 | Errors: 0]"
    );
}

// shortcut: the refused port costs the pool's 60 s acquire timeout before the failure is
// reported; upgrade when `PoolBounds` becomes injectable for the CLI.
#[test]
fn an_unreachable_database_fails_and_claims_no_success() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("events.jsonl");
    fs::write(&path, an_event_line()).expect("write");

    let output = Command::new(env!("CARGO_BIN_EXE_nostream-cli"))
        .args(["import", path.to_str().expect("utf-8")])
        .current_dir(workspace_root())
        .env("DB_URI", "postgres://postgres@127.0.0.1:1/none")
        .env_remove("DB_HOST")
        .env_remove("DB_PORT")
        .env_remove("DB_USER")
        .env_remove("DB_PASSWORD")
        .env_remove("DB_NAME")
        .output()
        .expect("the binary runs");

    assert_eq!(output.status.code(), Some(1));
    assert!(!stderr(&output).is_empty(), "the failure is explained");
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("Import completed"),
        "no success line without a completed import"
    );
}
