//! `nostream-cli` — the operator command line.
//!
//! The surface lives in the library (`nostream_cli::app`); this file only hands the process's
//! arguments to it, so the binary has no logic of its own to keep in step with a test.

use std::process::ExitCode;

fn main() -> ExitCode {
    nostream_cli::app::run(std::env::args().skip(1).collect())
}
