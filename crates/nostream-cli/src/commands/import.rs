//! `import-events.ts`: the `import` command.
//!
//! The capture's parser is hand-written (it rejects `--file` even though `CLI.md` shows it),
//! so this module parses the same way, renders clap's help for `--help`, and streams the
//! file through [`EventImportService`]. Every stdout line goes through the CLI's
//! [`CommandOutput`] so `main` stays the only stream writer.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use clap::CommandFactory;
use nostream_services::services::event_import_service::{
    EventBatchPersister, EventImportLineError, EventImportService, EventImportStats,
    LineErrorSink, RepositoryEventPersister,
};
use tokio::io::BufReader;

use crate::config::CommandOutput;
use crate::error::CliError;

/// The default batch (`DEFAULT_BATCH_SIZE`, `src/import-events.ts:33`).
pub const DEFAULT_BATCH_SIZE: u64 = 1_000;

/// The input shape the extension selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFormat {
    Jsonl,
    Json,
}

/// The parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedArgs {
    Help,
    Run { file: PathBuf, batch_size: u64 },
}

/// `--help` as clap renders it for this subcommand.
#[derive(Debug, clap::Parser)]
#[command(
    name = "nostream-cli import",
    about = "Import events from a .jsonl or .json file"
)]
struct ImportHelp {
    /// The .jsonl or .json file to import.
    file: Option<PathBuf>,
    /// Events per insert batch.
    #[arg(long, value_name = "N")]
    batch_size: Option<u64>,
}

/// The capture's `printUsage`, rendered by clap.
pub fn help_lines() -> Vec<String> {
    ImportHelp::command()
        .render_help()
        .to_string()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// `parseCliArgs` (`src/import-events.ts:60-111`).
pub fn parse_args(args: &[String]) -> Result<ParsedArgs, CliError> {
    let mut batch_size = DEFAULT_BATCH_SIZE;
    let mut file: Option<PathBuf> = None;

    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(ParsedArgs::Help);
    }

    let mut index = 0;

    while index < args.len() {
        let arg = &args[index];

        if arg == "--batch-size" {
            let Some(value) = args.get(index + 1) else {
                return Err(CliError::Import("Missing value for --batch-size".to_owned()));
            };
            batch_size = parse_batch_size(value)?;
            index += 2;
            continue;
        }

        if let Some(value) = arg.strip_prefix("--batch-size=") {
            batch_size = parse_batch_size(value)?;
            index += 1;
            continue;
        }

        if arg.starts_with('-') {
            return Err(CliError::Import(format!("Unknown option: {arg}")));
        }

        if file.is_some() {
            return Err(CliError::Import(format!("Unexpected extra argument: {arg}")));
        }

        file = Some(PathBuf::from(arg));
        index += 1;
    }

    let Some(file) = file else {
        return Err(CliError::Import(
            "Missing path to .jsonl or .json file".to_owned(),
        ));
    };

    Ok(ParsedArgs::Run { file, batch_size })
}

/// `parseBatchSize`: `Number(value)` must be a positive integer.
fn parse_batch_size(value: &str) -> Result<u64, CliError> {
    let parsed = value.trim().parse::<f64>();

    match parsed {
        Ok(number) if number.is_finite() && number.fract() == 0.0 && number > 0.0 => {
            Ok(number as u64)
        }
        _ => Err(CliError::Import(format!(
            "Invalid --batch-size value: {value}"
        ))),
    }
}

/// `ensureValidInputFile`: the absolute path and the format the extension names.
pub fn validate_input(cwd: &Path, file: &Path) -> Result<(PathBuf, ImportFormat), CliError> {
    let absolute = std::path::absolute(cwd.join(file)).unwrap_or_else(|_| cwd.join(file));

    if !absolute.exists() {
        return Err(CliError::Import(format!(
            "Input file does not exist: {}",
            absolute.display()
        )));
    }

    if !absolute.is_file() {
        return Err(CliError::Import(format!(
            "Input path is not a file: {}",
            absolute.display()
        )));
    }

    let extension = absolute
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_lowercase);

    match extension.as_deref() {
        Some("jsonl") => Ok((absolute, ImportFormat::Jsonl)),
        Some("json") => Ok((absolute, ImportFormat::Json)),
        _ => Err(CliError::Import(
            "Input file must have a .jsonl or .json extension".to_owned(),
        )),
    }
}

/// `runImportEvents` over the process's Postgres backend.
pub fn run(args: &[String], cwd: &Path) -> Result<CommandOutput, CliError> {
    let parsed = parse_args(args)?;

    let ParsedArgs::Run { file, batch_size } = parsed else {
        return Ok(CommandOutput {
            lines: help_lines(),
            exit_code: 0,
        });
    };

    let (path, format) = validate_input(cwd, &file)?;

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| CliError::Config(format!("tokio runtime: {error}")))?;

    runtime.block_on(async move {
        let backend = nostream_storage::PostgresBackend::from_env()
            .await
            .map_err(|error| CliError::Import(error.to_string()))?;
        let persister: Arc<dyn EventBatchPersister> =
            Arc::new(RepositoryEventPersister::new(Arc::new(backend)));

        import_with(&path, format, batch_size, persister).await
    })
}

/// The import over an injected persister, which is how the output contract is tested.
pub async fn import_with(
    path: &Path,
    format: ImportFormat,
    batch_size: u64,
    persister: Arc<dyn EventBatchPersister>,
) -> Result<CommandOutput, CliError> {
    let service = EventImportService::new(persister);
    let lines: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let sink: RefCell<LineErrorSink> = RefCell::new(LineErrorSink::default());

    let on_line_error = |error: &EventImportLineError| {
        if sink.borrow_mut().record(error) {
            lines.borrow_mut().push(format!(
                "[line {}] {}",
                error.line_number, error.reason
            ));
        }
    };
    let on_progress = |stats: &EventImportStats| {
        lines.borrow_mut().push(format_progress(stats));
    };

    let options = nostream_services::services::event_import_service::ImportOptions {
        batch_size,
        on_line_error: Some(&on_line_error),
        on_progress: Some(&on_progress),
    };

    let started = Instant::now();
    let reader = tokio::fs::File::open(path)
        .await
        .map_err(|error| CliError::Import(error.to_string()))?;

    let stats = match format {
        ImportFormat::Jsonl => {
            service
                .import_jsonl(BufReader::new(reader), &options)
                .await
        }
        ImportFormat::Json => service.import_json_array(reader, &options).await,
    }
    .map_err(|error| CliError::Import(error.to_string()))?;

    let suppressed = sink.borrow().suppressed;

    if suppressed > 0 {
        lines.borrow_mut().push(format!(
            "Suppressed {} additional line errors",
            format_number(suppressed)
        ));
    }

    let elapsed = started.elapsed().as_secs_f64();
    lines
        .borrow_mut()
        .push(format!("Import completed in {elapsed:.2}s"));
    lines.borrow_mut().push(format_progress(&stats));

    let lines = lines.into_inner();

    Ok(CommandOutput { lines, exit_code: 0 })
}

/// `[Processed: N | Inserted: N | Skipped: N | Errors: N]` with `en-US` separators.
fn format_progress(stats: &EventImportStats) -> String {
    format!(
        "[Processed: {} | Inserted: {} | Skipped: {} | Errors: {}]",
        format_number(stats.processed),
        format_number(stats.inserted),
        format_number(stats.skipped),
        format_number(stats.errors)
    )
}

/// `toLocaleString('en-US')` for a non-negative count.
fn format_number(value: u64) -> String {
    let digits = value.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);

    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            formatted.push(',');
        }

        formatted.push(digit);
    }

    formatted
}
