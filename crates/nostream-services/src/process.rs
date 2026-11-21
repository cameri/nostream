//! The spawn seam: the one place in the workspace that opens a child process for the operator
//! command line.
//!
//! It owns `src/cli/utils/process.ts`'s two entry points, `runCommand` and
//! `runCommandWithOutput`, and nothing else: `nostream-services` is the only crate allowed
//! tokio's `process` feature (`CLAUDE.md:116`), so a front end that shells out reaches the
//! spawner through this module rather than taking the feature itself. Both entry points are
//! `async` and are driven by a runtime the **caller** owns — the CLI builds a current-thread
//! runtime per command — so this module never starts, stops or blocks a runtime.
//!
//! `run` inherits the parent's stdio, which is what a compose `up` needs: an operator watching
//! the terminal sees the build. `capture` takes both pipes and a budget, which is what a probe
//! needs: `docker inspect` answered inside a second, or the answer is that docker is slow.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// Why a child could not be started, or could not be read.
///
/// The three classes are Node's `ENOENT` / `EACCES` / everything else, which the capture's
/// `runCommandWithOutput` matches by `err.code` (`src/cli/utils/process.ts:87-98`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnFailure {
    /// The program is not on `PATH` (or `argv[0]` is not a path to a file).
    NotFound { program: String },
    /// The program exists and this user may not execute it.
    PermissionDenied { program: String },
    /// Anything else the operating system answered.
    Spawn { program: String, message: String },
}

impl std::fmt::Display for SpawnFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound { program } => write!(formatter, "{program} is not installed"),
            Self::PermissionDenied { program } => {
                write!(formatter, "{program} is not executable by this user")
            }
            Self::Spawn { program, message } => {
                write!(formatter, "{program} could not be run: {message}")
            }
        }
    }
}

/// What one captured run answered (`src/cli/utils/process.ts:10-17` `CommandResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapturedResult {
    /// The child ran to completion. A status with no exit code is reported as `1`, which is
    /// what the capture's `code ?? 1` does.
    Exited {
        code: i32,
        stdout: String,
        stderr: String,
    },
    /// The child was killed by a signal, so it has no exit code of its own.
    Signalled {
        signal: String,
        stdout: String,
        stderr: String,
    },
    /// The child outlived the budget the caller gave it and was killed.
    ///
    /// shortcut: a timed-out capture yields no output, because the pipes are drained by the same
    /// future the budget cancels; upgrade when a caller has to parse what a slow child printed
    /// before it was killed, which needs the readers to outlive the wait.
    TimedOut,
    /// The child never started.
    Failed {
        failure: SpawnFailure,
        stdout: String,
        stderr: String,
    },
}

impl CapturedResult {
    /// The exit code, when the child answered with one.
    pub fn code(&self) -> Option<i32> {
        match self {
            Self::Exited { code, .. } => Some(*code),
            Self::Signalled { .. } | Self::TimedOut | Self::Failed { .. } => None,
        }
    }

    /// What the child printed on stdout, or nothing when it never ran.
    pub fn stdout(&self) -> &str {
        match self {
            Self::Exited { stdout, .. }
            | Self::Signalled { stdout, .. }
            | Self::Failed { stdout, .. } => stdout,
            Self::TimedOut => "",
        }
    }

    /// What the child printed on stderr, or nothing when it never ran.
    pub fn stderr(&self) -> &str {
        match self {
            Self::Exited { stderr, .. }
            | Self::Signalled { stderr, .. }
            | Self::Failed { stderr, .. } => stderr,
            Self::TimedOut => "",
        }
    }
}

/// One command line: the program first, then its arguments.
fn split(argv: &[String]) -> (&str, &[String]) {
    match argv.split_first() {
        Some((program, arguments)) => (program.as_str(), arguments),
        None => ("", &[]),
    }
}

/// Builds the child with the caller's environment additions layered over the parent's, and the
/// classification every entry point shares.
fn command(argv: &[String], env: &[(&str, String)]) -> Command {
    let (program, arguments) = split(argv);
    let mut command = Command::new(program);
    command.args(arguments);
    for (name, value) in env {
        command.env(name, value);
    }
    command
}

fn classify(program: &str, error: std::io::Error) -> SpawnFailure {
    match error.kind() {
        std::io::ErrorKind::NotFound => SpawnFailure::NotFound {
            program: program.to_owned(),
        },
        std::io::ErrorKind::PermissionDenied => SpawnFailure::PermissionDenied {
            program: program.to_owned(),
        },
        _ => SpawnFailure::Spawn {
            program: program.to_owned(),
            message: error.to_string(),
        },
    }
}

/// `runCommand`: runs `argv` with the parent's stdio and answers its exit code.
///
/// An empty `argv` is [`SpawnFailure::NotFound`] with an empty program name: there is nothing to
/// start, and a caller that assembled the command from empty parts should read that as the
/// missing program it is.
pub async fn run(argv: &[String], env: &[(&str, String)]) -> Result<i32, SpawnFailure> {
    let (program, _) = split(argv);
    if program.is_empty() {
        return Err(SpawnFailure::NotFound {
            program: String::new(),
        });
    }

    let mut child = command(argv, env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| classify(program, error))?;

    let status = child.wait().await.map_err(|error| SpawnFailure::Spawn {
        program: program.to_owned(),
        message: error.to_string(),
    })?;

    // The capture's `resolve(code ?? 1)`: a signal leaves no code, and a caller comparing to zero
    // must read that as failure rather than as success.
    Ok(status.code().unwrap_or(1))
}

/// `runCommandWithOutput`: runs `argv` with both pipes and answers what it printed and how it
/// ended, or why it did not.
///
/// `timeout` of `None` waits forever, which is the capture's default.
pub async fn capture(argv: &[String], timeout: Option<Duration>) -> CapturedResult {
    let (program, _) = split(argv);
    if program.is_empty() {
        return CapturedResult::Failed {
            failure: SpawnFailure::NotFound {
                program: String::new(),
            },
            stdout: String::new(),
            stderr: String::new(),
        };
    }

    let child = match command(argv, &[])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CapturedResult::Failed {
                failure: classify(program, error),
                stdout: String::new(),
                stderr: String::new(),
            };
        }
    };

    let waited = match timeout {
        Some(budget) => match tokio::time::timeout(budget, child.wait_with_output()).await {
            Ok(waited) => waited,
            // Dropping the wait drops the child, and `kill_on_drop` kills it.
            Err(_) => return CapturedResult::TimedOut,
        },
        None => child.wait_with_output().await,
    };

    let output = match waited {
        Ok(output) => output,
        Err(error) => {
            return CapturedResult::Failed {
                failure: SpawnFailure::Spawn {
                    program: program.to_owned(),
                    message: error.to_string(),
                },
                stdout: String::new(),
                stderr: String::new(),
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    match output.status.code() {
        Some(code) => CapturedResult::Exited {
            code,
            stdout,
            stderr,
        },
        None => CapturedResult::Signalled {
            signal: signal_name(&output.status),
            stdout,
            stderr,
        },
    }
}

/// The signal's name, as the capture's `child.on('close', code, signal)` reports it.
#[cfg(unix)]
fn signal_name(status: &std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;

    status.signal().map_or_else(
        || "unknown".to_owned(),
        |signal| match signal {
            1 => "SIGHUP".to_owned(),
            2 => "SIGINT".to_owned(),
            3 => "SIGQUIT".to_owned(),
            6 => "SIGABRT".to_owned(),
            9 => "SIGKILL".to_owned(),
            15 => "SIGTERM".to_owned(),
            other => format!("signal {other}"),
        },
    )
}

#[cfg(not(unix))]
fn signal_name(_status: &std::process::ExitStatus) -> String {
    "unknown".to_owned()
}

#[cfg(all(test, unix))]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// Writes an executable shell script into `directory` under `name`.
    fn shim(directory: &std::path::Path, name: &str, body: &str) -> String {
        let path = directory.join(name);
        std::fs::write(&path, format!("#!/bin/bash\n{body}\n")).expect("the shim is written");
        let mut permissions = std::fs::metadata(&path)
            .expect("the shim exists")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).expect("the shim is executable");
        path.display().to_string()
    }

    fn argv(program: &str, arguments: &[&str]) -> Vec<String> {
        std::iter::once(program.to_owned())
            .chain(arguments.iter().map(|argument| (*argument).to_owned()))
            .collect()
    }

    #[tokio::test]
    async fn a_missing_binary_is_not_found() {
        let failure = run(&argv("nostream-cli-no-such-binary", &[]), &[])
            .await
            .expect_err("the binary is not there");
        assert_eq!(
            failure,
            SpawnFailure::NotFound {
                program: "nostream-cli-no-such-binary".to_owned()
            }
        );

        let captured = capture(&argv("nostream-cli-no-such-binary", &[]), None).await;
        assert!(matches!(
            captured,
            CapturedResult::Failed {
                failure: SpawnFailure::NotFound { .. },
                ..
            }
        ));
    }

    #[tokio::test]
    async fn a_script_without_the_execute_bit_is_refused() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let path = directory.path().join("not-executable");
        std::fs::write(&path, "#!/bin/bash\nexit 0\n").expect("the file is written");
        let failure = run(&argv(&path.display().to_string(), &[]), &[])
            .await
            .expect_err("the file is not executable");
        assert_eq!(
            failure,
            SpawnFailure::PermissionDenied {
                program: path.display().to_string()
            }
        );
    }

    #[tokio::test]
    async fn a_slow_child_times_out() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let slow = shim(directory.path(), "slow", "sleep 30");
        let started = std::time::Instant::now();
        let captured = capture(&argv(&slow, &[]), Some(Duration::from_millis(150))).await;
        assert_eq!(captured, CapturedResult::TimedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the budget is what ended the wait"
        );
    }

    #[tokio::test]
    async fn run_answers_the_child_exit_code_and_capture_answers_its_output() {
        let directory = tempfile::tempdir().expect("a temporary directory");
        // The environment the caller adds reaches the child: the shim answers 0 only when it
        // finds the variable it was handed.
        let env_check = shim(
            directory.path(),
            "env-check",
            "env | grep -q '^NOSTREAM_PROBE=yes$'",
        );
        let code = run(
            &argv(&env_check, &[]),
            &[("NOSTREAM_PROBE", "yes".to_owned())],
        )
        .await
        .expect("the child runs");
        assert_eq!(code, 0, "the added environment reaches the child");

        let echo = shim(directory.path(), "echoer", "printf '%s\\n' \"$@\"");
        let captured = capture(&argv(&echo, &["two"]), None).await;
        let CapturedResult::Exited { code, stdout, .. } = captured else {
            panic!("the child exits");
        };
        assert_eq!(code, 0);
        assert!(stdout.contains("two"), "the argument is echoed");
    }

    #[tokio::test]
    async fn an_empty_argv_is_not_a_program() {
        assert!(matches!(
            run(&[], &[]).await,
            Err(SpawnFailure::NotFound { .. })
        ));
        assert!(matches!(
            capture(&[], None).await,
            CapturedResult::Failed {
                failure: SpawnFailure::NotFound { .. },
                ..
            }
        ));
    }
}
