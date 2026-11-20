//! `export-events.ts` and the `export` command's argument checks: the three output shapes, their
//! summaries, and the interrupt that stops a run at 130.
//!
//! The format rules are the capture's (`src/cli/index.ts:232-265` decides the flags,
//! `src/scripts/export-events.ts:126-215` resolves them to one of three shapes): a structured
//! format writes a JSONL stream or a `[`…`]` array, a compressed format writes gzip or xz, and a
//! bare path writes plain JSONL. The rows come from [`EventRepository::scan_live`], which is the
//! only read that enumerates a store — a filter read is bounded by one page.
//!
//! Progress and the summary are written to the stream the caller hands in, as the capture's
//! `console.log` does: an export of a large store that shows nothing until it finishes looks
//! hung. `main` owns the stream, which is the same split `import` already uses.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Instant;

use nostream_config::SettingsPaths;
use nostream_storage::repositories::{
    EventRecord, EventRepository, ScanCursor, StorageFuture, collect_scan,
};

use crate::app::Context;
use crate::compression::{Compression, encoder};
use crate::config::CommandOutput;
use crate::error::CliError;
use crate::store;

/// The output a bare `export` writes (`DEFAULT_OUTPUT_FILE_PATH`, `export-events.ts:28`).
pub const DEFAULT_OUTPUT_FILE_PATH: &str = "events.jsonl";

/// The floor on elapsed seconds, so a fast run cannot divide by zero
/// (`MIN_ELAPSED_SECONDS`, `export-events.ts:31`).
const MIN_ELAPSED_SECONDS: f64 = 0.001;

/// How often a long export says how far it has got (`exported % 10_000`, `export-events.ts:335`).
const PROGRESS_EVERY: u64 = 10_000;

/// The structured shapes `--format` accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructuredFormat {
    Jsonl,
    Json,
}

impl StructuredFormat {
    /// The name the summary line prints.
    pub fn label(self) -> &'static str {
        match self {
            Self::Jsonl => "jsonl",
            Self::Json => "json",
        }
    }

    /// The extension the output file must carry.
    fn extension(self) -> &'static str {
        match self {
            Self::Jsonl => ".jsonl",
            Self::Json => ".json",
        }
    }

    fn default_output(self) -> &'static str {
        match self {
            Self::Jsonl => "events.jsonl",
            Self::Json => "events.json",
        }
    }
}

/// The parsed `export` flags, as the parser read them (V28–V31).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExportOptions {
    /// The positional, or `--output`.
    pub output: Option<String>,
    pub compress: bool,
    /// The raw `--format` value, validated here because the message is the capture's.
    pub format: Option<String>,
    pub data_dir: Option<PathBuf>,
}

/// What one export writes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Shape {
    /// A JSONL stream or a `[`…`]` array.
    Structured(StructuredFormat),
    /// Plain JSONL, or JSONL through a compressor.
    Stream(Option<Compression>),
}

impl Shape {
    fn compression(&self) -> Option<Compression> {
        match self {
            Self::Structured(_) => None,
            Self::Stream(compression) => *compression,
        }
    }

    fn structured(&self) -> Option<StructuredFormat> {
        match self {
            Self::Structured(format) => Some(*format),
            Self::Stream(_) => None,
        }
    }
}

/// Runs `export` on a runtime the command owns, writing its progress to `out`.
pub fn run(
    context: &Context,
    options: &ExportOptions,
    out: &mut dyn Write,
) -> Result<CommandOutput, CliError> {
    context.block_on(export(context, options, out))
}

/// `runExport` and `runExportEvents`: the flags, then the rows.
pub(crate) async fn export(
    context: &Context,
    options: &ExportOptions,
    out: &mut dyn Write,
) -> Result<CommandOutput, CliError> {
    let (shape, output_path) = resolve(&context.cwd, options)?;

    let settings = crate::config::effective_settings(&SettingsPaths::resolve(&context.cwd))
        .map_err(|error| CliError::command(error.to_string()))?;
    let opened = store::open(&settings, options.data_dir.as_deref(), &context.env).await?;
    let source: &dyn EventRepository = opened.events();

    let first = source
        .scan_live(None, source.page_bound())
        .await
        .map_err(|error| CliError::command(error.to_string()))?;
    let first_page = collect_scan(first)
        .await
        .map_err(|error| CliError::command(error.to_string()))?;

    if first_page.is_empty() {
        writeln!(out, "No events to export.").map_err(stream_error)?;
        return Ok(CommandOutput::default());
    }

    match shape.compression() {
        Some(compression) => write!(out, "Exporting events to {}", output_path.display())
            .and_then(|()| writeln!(out, " using {} compression", compression.label())),
        None => writeln!(out, "Exporting events to {}", output_path.display()),
    }
    .map_err(stream_error)?;

    let started = Instant::now();
    let file = std::fs::File::create(&output_path).map_err(|error| {
        CliError::command(format!(
            "unable to write {}: {error}",
            output_path.display()
        ))
    })?;
    let mut counting = CountingWriter::new(file);

    let interrupt = Arc::new(AtomicU8::new(SIGNAL_NONE));
    let _watcher = {
        let _entered = context.enter();
        tokio::spawn(watch_signals(Arc::clone(&interrupt)))
    };

    let source = FirstPage::new(first_page, source);
    let exported = match shape {
        Shape::Structured(format) => {
            export_structured(&source, format, &mut counting, &interrupt, out).await?
        }
        Shape::Stream(compression) => {
            export_stream(
                &source,
                compression,
                &context.env,
                &mut counting,
                &interrupt,
                out,
            )
            .await?
        }
    };

    counting
        .inner
        .flush()
        .map_err(|error| CliError::command(format!("unable to flush the output: {error}")))?;

    let output_bytes = counting.bytes;

    if exported.interrupted.is_some() {
        return Ok(CommandOutput::with_code(Vec::new(), exported.exit_code()));
    }

    if let Some(format) = shape.structured() {
        writeln!(
            out,
            "Export complete: {} events written to {} ({})",
            exported.rows,
            output_path.display(),
            format.label()
        )
        .map_err(stream_error)?;
        return Ok(CommandOutput::default());
    }

    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let event_rate = rate_per_second(exported.rows as f64, elapsed_ms);
    let raw_rate = rate_per_second(exported.raw_bytes as f64, elapsed_ms);
    let output_rate = rate_per_second(output_bytes as f64, elapsed_ms);

    writeln!(
        out,
        "Export complete: {} events written to {}",
        exported.rows,
        output_path.display()
    )
    .map_err(stream_error)?;

    match compression_delta(exported.raw_bytes, output_bytes) {
        Some(delta) => writeln!(
            out,
            "Size: {} raw -> {} on disk ({delta})",
            format_bytes(exported.raw_bytes as f64),
            format_bytes(output_bytes as f64)
        ),
        None => writeln!(out, "Size: {} on disk", format_bytes(output_bytes as f64)),
    }
    .map_err(stream_error)?;

    writeln!(
        out,
        "Throughput: {} events/s | {}/s raw | {}/s output",
        format_count(event_rate),
        format_bytes(raw_rate),
        format_bytes(output_rate)
    )
    .map_err(stream_error)?;

    Ok(CommandOutput::default())
}

/// The flag checks and the output path, in the capture's order (`src/cli/index.ts:232-265`).
fn resolve(cwd: &Path, options: &ExportOptions) -> Result<(Shape, PathBuf), CliError> {
    let mut structured: Option<StructuredFormat> = None;
    let mut compression: Option<Compression> = None;

    if let Some(raw) = &options.format {
        structured = match raw.as_str() {
            "jsonl" => Some(StructuredFormat::Jsonl),
            "json" => Some(StructuredFormat::Json),
            _ => None,
        };
        compression = match structured {
            Some(_) => None,
            None => Some(Compression::parse(raw).ok_or_else(|| {
                CliError::usage(format!(
                    "Unsupported format: {raw}. Supported values: json, jsonl, gzip, gz, xz"
                ))
            })?),
        };
    }

    if structured.is_some() && options.compress {
        return Err(CliError::usage(
            "Cannot combine --compress with --format json/jsonl.",
        ));
    }

    let output = options.output.clone();

    match structured {
        Some(format) => {
            let path = absolute(cwd, output.as_deref().unwrap_or(format.default_output()));

            if extension(&path).as_deref() != Some(format.extension()) {
                return Err(CliError::command(format!(
                    "Output file extension must be {} when using --format {}",
                    format.extension(),
                    format.label()
                )));
            }

            Ok((Shape::Structured(format), path))
        }
        None => {
            if !options.compress && compression.is_some() {
                return Err(CliError::command("--format requires --compress"));
            }

            let path = absolute(cwd, output.as_deref().unwrap_or(DEFAULT_OUTPUT_FILE_PATH));

            let compression = if !options.compress {
                None
            } else {
                Some(
                    compression
                        .or_else(|| compression_from_extension(&path))
                        .unwrap_or(Compression::Gzip),
                )
            };

            Ok((Shape::Stream(compression), path))
        }
    }
}

/// `getCompressionFormatFromExtension`: `.gz` and `.xz`, and nothing else.
fn compression_from_extension(path: &Path) -> Option<Compression> {
    match extension(path).as_deref() {
        Some(".gz") => Some(Compression::Gzip),
        Some(".xz") => Some(Compression::Xz),
        _ => None,
    }
}

/// `extname(path).toLowerCase()`.
fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_lowercase()))
}

/// `path.resolve(filename)`: the path a command reads and writes, against its working directory.
fn absolute(cwd: &Path, filename: &str) -> PathBuf {
    let joined = cwd.join(filename);
    std::path::absolute(&joined).unwrap_or(joined)
}

/// One export's row count, byte counts and the exit code its outcome asks for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Exported {
    pub rows: u64,
    pub raw_bytes: u64,
    /// The signal that stopped the run, when one did.
    pub interrupted: Option<Signal>,
}

impl Exported {
    /// The process's code: 130 when a signal stopped the run, which is what the capture sets
    /// (`src/scripts/export-events.ts:280`), and 0 otherwise.
    pub fn exit_code(&self) -> u8 {
        if self.interrupted.is_some() { 130 } else { 0 }
    }
}

/// The two signals the capture listens for (`export-events.ts:276-287`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Int,
    Term,
}

impl Signal {
    /// The name the printed lines carry.
    pub fn name(self) -> &'static str {
        match self {
            Self::Int => "SIGINT",
            Self::Term => "SIGTERM",
        }
    }
}

/// The interrupt flag's values.
const SIGNAL_NONE: u8 = 0;
const SIGNAL_INT: u8 = 1;
const SIGNAL_TERM: u8 = 2;

fn signal(flag: &AtomicU8) -> Option<Signal> {
    match flag.load(Ordering::SeqCst) {
        SIGNAL_INT => Some(Signal::Int),
        SIGNAL_TERM => Some(Signal::Term),
        _ => None,
    }
}

/// Sets the flag when the process is interrupted, for as long as the runtime lives.
async fn watch_signals(flag: Arc<AtomicU8>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal as watch};

        let (Ok(mut interrupt), Ok(mut terminate)) = (
            watch(SignalKind::interrupt()),
            watch(SignalKind::terminate()),
        ) else {
            return;
        };

        tokio::select! {
            _ = interrupt.recv() => flag.store(SIGNAL_INT, Ordering::SeqCst),
            _ = terminate.recv() => flag.store(SIGNAL_TERM, Ordering::SeqCst),
        }
    }

    #[cfg(not(unix))]
    {
        if tokio::signal::ctrl_c().await.is_ok() {
            flag.store(SIGNAL_INT, Ordering::SeqCst);
        }
    }
}

/// What the export loop writes, page by page.
///
/// `bound` is the backend's own page bound, and it is what a page is compared against: a caller
/// that compares against `MAX_PAGE_ROWS` reads a backend's smaller full page as a short result
/// and stops early (`repositories.rs`'s `scan_live` contract says compare with
/// `min(limit, page_bound())`).
pub trait ExportSource {
    /// The next page after `after`, at most one page of the store.
    fn page(&self, after: Option<ScanCursor>) -> StorageFuture<'_, Vec<EventRecord>>;

    /// The most rows one page can hold, as the backend answers it.
    fn bound(&self) -> u64;
}

impl ExportSource for dyn EventRepository + '_ {
    fn page(&self, after: Option<ScanCursor>) -> StorageFuture<'_, Vec<EventRecord>> {
        Box::pin(async move { collect_scan(self.scan_live(after, self.page_bound()).await?).await })
    }

    fn bound(&self) -> u64 {
        self.page_bound()
    }
}

/// The page the empty-store probe already read, then the store's own pages.
struct FirstPage<'a> {
    first: Option<Vec<EventRecord>>,
    source: &'a dyn EventRepository,
}

impl<'a> FirstPage<'a> {
    fn new(first: Vec<EventRecord>, source: &'a dyn EventRepository) -> Self {
        Self {
            first: Some(first),
            source,
        }
    }
}

impl ExportSource for FirstPage<'_> {
    fn page(&self, after: Option<ScanCursor>) -> StorageFuture<'_, Vec<EventRecord>> {
        match &self.first {
            Some(first) if after.is_none() => Box::pin(async move { Ok(first.clone()) }),
            _ => self.source.page(after),
        }
    }

    fn bound(&self) -> u64 {
        self.source.page_bound()
    }
}

/// The JSONL branch: one line per row, or a `[`…`]` array (`export-events.ts:229-256`).
async fn export_structured<S: ExportSource, W: Write>(
    source: &S,
    format: StructuredFormat,
    writer: &mut W,
    interrupt: &AtomicU8,
    out: &mut dyn Write,
) -> Result<Exported, CliError> {
    let mut exported = Exported::default();
    let mut opened = false;
    let mut after: Option<ScanCursor> = None;

    loop {
        if let Some(signal) = signal(interrupt) {
            interrupt_lines(out, signal)?;
            exported.interrupted = Some(signal);
            return Ok(exported);
        }

        let page = source
            .page(after)
            .await
            .map_err(|error| CliError::command(error.to_string()))?;
        let full = page.len() as u64 >= source.bound();

        for record in &page {
            if let Some(signal) = signal(interrupt) {
                interrupt_lines(out, signal)?;
                exported.interrupted = Some(signal);
                return Ok(exported);
            }

            let line = serde_json::to_string(&record.event)
                .map_err(|error| CliError::command(error.to_string()))?;

            match format {
                StructuredFormat::Jsonl => {
                    writeln!(writer, "{line}").map_err(stream_error)?;
                }
                StructuredFormat::Json => {
                    let prefix = if opened { ",\n" } else { "[\n" };
                    write!(writer, "{prefix}{line}").map_err(stream_error)?;
                    opened = true;
                }
            }

            exported.rows = exported.rows.saturating_add(1);
            exported.raw_bytes = exported.raw_bytes.saturating_add(line.len() as u64);
            after = Some(cursor(record));
            progress(exported.rows, out)?;
        }

        if !full {
            break;
        }
    }

    if format == StructuredFormat::Json {
        writeln!(writer, "\n]").map_err(stream_error)?;
    }

    Ok(exported)
}

/// The plain and compressed branch: JSONL, through the compressor the shape named.
async fn export_stream<S: ExportSource>(
    source: &S,
    compression: Option<Compression>,
    env: &crate::env_file::Environment,
    writer: &mut CountingWriter,
    interrupt: &AtomicU8,
    out: &mut dyn Write,
) -> Result<Exported, CliError> {
    let mut exported = Exported::default();
    let mut after: Option<ScanCursor> = None;

    {
        let mut sink: Box<dyn Write + '_> = match compression {
            Some(format) => encoder(format, &mut *writer, env)?,
            None => Box::new(&mut *writer),
        };

        loop {
            if let Some(signal) = signal(interrupt) {
                interrupt_lines(out, signal)?;
                exported.interrupted = Some(signal);
                break;
            }

            let page = source
                .page(after)
                .await
                .map_err(|error| CliError::command(error.to_string()))?;
            let full = page.len() as u64 >= source.bound();

            for record in &page {
                if let Some(signal) = signal(interrupt) {
                    interrupt_lines(out, signal)?;
                    exported.interrupted = Some(signal);
                    break;
                }

                let mut line = serde_json::to_string(&record.event)
                    .map_err(|error| CliError::command(error.to_string()))?;
                line.push('\n');

                sink.write_all(line.as_bytes()).map_err(stream_error)?;

                exported.rows = exported.rows.saturating_add(1);
                exported.raw_bytes = exported.raw_bytes.saturating_add(line.len() as u64);
                after = Some(cursor(record));
                progress(exported.rows, out)?;
            }

            if exported.interrupted.is_some() || !full {
                break;
            }
        }

        sink.flush().map_err(stream_error)?;
    }

    Ok(exported)
}

/// The capture's two interrupt lines (`src/scripts/export-events.ts:276-287,367-371`): the
/// handler's, then the catch's.
fn interrupt_lines(out: &mut dyn Write, signal: Signal) -> Result<(), CliError> {
    writeln!(out, "{} received. Stopping export...", signal.name()).map_err(stream_error)?;
    writeln!(out, "Export interrupted by {}.", signal.name()).map_err(stream_error)
}

/// `Exported ${n} events...` every ten thousand rows.
fn progress(rows: u64, out: &mut dyn Write) -> Result<(), CliError> {
    if rows.is_multiple_of(PROGRESS_EVERY) {
        writeln!(out, "Exported {rows} events...").map_err(stream_error)?;
    }

    Ok(())
}

/// The cursor a page resumes after: the row just read.
fn cursor(record: &EventRecord) -> ScanCursor {
    ScanCursor {
        created_at: record.event.created_at,
        event_id: record.event.id,
    }
}

/// A writer that counts what reached the file, which is the summary's `on disk` number.
pub struct CountingWriter {
    inner: std::fs::File,
    bytes: u64,
}

impl CountingWriter {
    fn new(inner: std::fs::File) -> Self {
        Self { inner, bytes: 0 }
    }
}

impl Write for CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.bytes = self.bytes.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// `formatBytes` (`export-events.ts:33-53`).
pub fn format_bytes(bytes: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];

    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 B".to_owned();
    }

    let mut value = bytes;
    let mut unit = 0;

    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }

    let rounded = (value * 100.0).round() / 100.0;

    format!("{rounded} {}", UNITS[unit])
}

/// `formatCompressionDelta`: `None` when there is nothing to compare.
pub fn compression_delta(raw_bytes: u64, output_bytes: u64) -> Option<String> {
    if raw_bytes == 0 {
        return None;
    }

    let delta = (raw_bytes as f64 - output_bytes as f64) / raw_bytes as f64 * 100.0;
    let rounded = (delta.abs() * 100.0).round() / 100.0;

    Some(if delta >= 0.0 {
        format!("{rounded}% smaller")
    } else {
        format!("{rounded}% larger")
    })
}

/// `getRatePerSecond`.
pub fn rate_per_second(value: f64, elapsed_ms: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        return 0.0;
    }

    value / (elapsed_ms / 1_000.0).max(MIN_ELAPSED_SECONDS)
}

/// `formatCount`: a whole number as the capture prints it, else two decimals, with the integer
/// part grouped in threes — `toLocaleString('en-US')` (`src/scripts/export-events.ts:71-87`), so
/// a 20 000-row run prints `20,602.95 events/s` and not `20602.95`.
pub fn format_count(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;

    let rendered = if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.2}")
    };

    group_thousands(&rendered)
}

/// `toLocaleString('en-US')`'s grouping: commas every three digits of the integer part, and the
/// fraction untouched.
fn group_thousands(rendered: &str) -> String {
    let (integer, fraction) = match rendered.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (rendered, None),
    };

    let (sign, digits) = match integer.strip_prefix('-') {
        Some(digits) => ("-", digits),
        None => ("", integer),
    };

    let mut grouped = String::with_capacity(rendered.len() + digits.len() / 3 + 1);
    grouped.push_str(sign);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }

    if let Some(fraction) = fraction {
        grouped.push('.');
        grouped.push_str(fraction);
    }

    grouped
}

/// A write to the caller's stream failed, which no command can recover from.
fn stream_error(error: std::io::Error) -> CliError {
    CliError::command(format!("unable to write output: {error}"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn the_byte_renderer_is_the_captures() {
        assert_eq!(format_bytes(0.0), "0 B");
        assert_eq!(format_bytes(512.0), "512 B");
        assert_eq!(format_bytes(1_024.0), "1 KiB");
        assert_eq!(format_bytes(1_536.0), "1.5 KiB");
    }

    #[test]
    fn the_delta_says_smaller_larger_or_nothing() {
        assert_eq!(compression_delta(0, 0), None);
        assert_eq!(compression_delta(100, 100).as_deref(), Some("0% smaller"));
        assert_eq!(compression_delta(100, 25).as_deref(), Some("75% smaller"));
        assert_eq!(compression_delta(100, 200).as_deref(), Some("100% larger"));
    }

    #[test]
    fn the_rate_has_a_floor() {
        assert_eq!(rate_per_second(0.0, 10.0), 0.0);
        assert_eq!(rate_per_second(10.0, 0.0), 10_000.0);
        assert_eq!(rate_per_second(1_000.0, 1_000.0), 1_000.0);
    }

    #[test]
    fn the_count_is_whole_or_two_decimals_with_the_captures_separators() {
        assert_eq!(format_count(1.0), "1");
        assert_eq!(format_count(1.5), "1.50");
        assert_eq!(format_count(0.0), "0");
        assert_eq!(format_count(999.0), "999");
        assert_eq!(format_count(1_000.0), "1,000");
        assert_eq!(format_count(20_602.95), "20,602.95");
        assert_eq!(format_count(4_064.6), "4,064.60");
        assert_eq!(format_count(200_000.0), "200,000");
        assert_eq!(format_count(1_234_567.891), "1,234,567.89");
        assert_eq!(group_thousands("-1234.50"), "-1,234.50");
    }

    #[test]
    fn the_format_conflicts_are_the_captures_usage_errors() {
        let cwd = Path::new("/tmp/export-test");

        let unknown = resolve(
            cwd,
            &ExportOptions {
                format: Some("bogus".to_owned()),
                ..ExportOptions::default()
            },
        )
        .expect_err("an unknown format is refused");
        assert_eq!(
            unknown.to_string(),
            "Unsupported format: bogus. Supported values: json, jsonl, gzip, gz, xz"
        );

        let combined = resolve(
            cwd,
            &ExportOptions {
                compress: true,
                format: Some("json".to_owned()),
                ..ExportOptions::default()
            },
        )
        .expect_err("compression with a structured format is refused");
        assert_eq!(
            combined.to_string(),
            "Cannot combine --compress with --format json/jsonl."
        );

        let unaccompanied = resolve(
            cwd,
            &ExportOptions {
                format: Some("xz".to_owned()),
                ..ExportOptions::default()
            },
        )
        .expect_err("a compression format needs --compress");
        assert_eq!(unaccompanied.to_string(), "--format requires --compress");
    }

    #[test]
    fn a_structured_format_keeps_its_extension() {
        let cwd = Path::new("/tmp/export-test");

        let mismatched = resolve(
            cwd,
            &ExportOptions {
                output: Some("out.jsonl".to_owned()),
                format: Some("json".to_owned()),
                ..ExportOptions::default()
            },
        )
        .expect_err("the extension must match");
        assert_eq!(
            mismatched.to_string(),
            "Output file extension must be .json when using --format json"
        );

        let (shape, path) = resolve(
            cwd,
            &ExportOptions {
                output: Some("out.json".to_owned()),
                format: Some("json".to_owned()),
                ..ExportOptions::default()
            },
        )
        .expect("the extension matches");
        assert_eq!(shape.structured(), Some(StructuredFormat::Json));
        assert_eq!(path, PathBuf::from("/tmp/export-test/out.json"));
    }

    #[test]
    fn compression_is_inferred_from_the_extension_then_gzip() {
        let cwd = Path::new("/tmp/export-test");
        let shaped = |output: &str| {
            resolve(
                cwd,
                &ExportOptions {
                    output: Some(output.to_owned()),
                    compress: true,
                    ..ExportOptions::default()
                },
            )
            .expect("the shape resolves")
            .0
            .compression()
        };

        assert_eq!(shaped("out.xz"), Some(Compression::Xz));
        assert_eq!(shaped("out.jsonl.gz"), Some(Compression::Gzip));
        assert_eq!(shaped("out.bin"), Some(Compression::Gzip));
    }

    /// One stored row, for the loop's tests.
    fn record(created_at: i64) -> EventRecord {
        use std::str::FromStr;

        let event = nostream_core::Event {
            id: nostream_core::EventId::from_str(&"11".repeat(32)).expect("an id"),
            pubkey: nostream_core::Pubkey::from_str(&"22".repeat(32)).expect("a pubkey"),
            created_at,
            kind: nostream_core::Kind(1),
            tags: Vec::new(),
            content: format!("event {created_at}"),
            sig: nostream_core::Signature::from_str(&"33".repeat(64)).expect("a signature"),
        };

        EventRecord {
            row_id: None,
            event,
            first_seen: None,
            deleted_at: None,
            expires_at: None,
            event_deduplication: None,
            remote_address: None,
        }
    }

    /// A store of fixed rows, one page, which is what the loop's test needs.
    struct FixedSource(Vec<EventRecord>);

    impl ExportSource for FixedSource {
        fn page(&self, after: Option<ScanCursor>) -> StorageFuture<'_, Vec<EventRecord>> {
            let rows: Vec<EventRecord> = match after {
                None => self.0.clone(),
                Some(cursor) => self
                    .0
                    .iter()
                    .filter(|record| {
                        record.event.created_at > cursor.created_at
                            || (record.event.created_at == cursor.created_at
                                && record.event.id > cursor.event_id)
                    })
                    .cloned()
                    .collect(),
            };

            Box::pin(async move { Ok(rows) })
        }

        fn bound(&self) -> u64 {
            self.0.len() as u64
        }
    }

    /// A backend whose full page is one row, which is the case `page_bound` exists for: a loop
    /// that compares against `MAX_PAGE_ROWS` reads the first page as short and stops there.
    struct OneRowPages(Vec<EventRecord>);

    impl ExportSource for OneRowPages {
        fn page(&self, after: Option<ScanCursor>) -> StorageFuture<'_, Vec<EventRecord>> {
            let rows: Vec<EventRecord> = self
                .0
                .iter()
                .filter(|record| match after {
                    None => true,
                    Some(cursor) => {
                        record.event.created_at > cursor.created_at
                            || (record.event.created_at == cursor.created_at
                                && record.event.id > cursor.event_id)
                    }
                })
                .take(1)
                .cloned()
                .collect();

            Box::pin(async move { Ok(rows) })
        }

        fn bound(&self) -> u64 {
            1
        }
    }

    /// A writer that sets the interrupt flag once it has been handed its first line, which is
    /// the signal arriving mid-run.
    struct InterruptingWriter<'a> {
        lines: Vec<u8>,
        flag: &'a AtomicU8,
    }

    impl Write for InterruptingWriter<'_> {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.lines.extend_from_slice(buffer);

            if self.lines.contains(&b'\n') {
                self.flag.store(SIGNAL_INT, Ordering::SeqCst);
            }

            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// AC42: a row written, then the signal, then the run stops at 130 with the capture's two
    /// lines.
    #[tokio::test]
    async fn an_interrupt_stops_the_export_after_the_row_it_interrupted() {
        let rows: Vec<EventRecord> = (0..10).map(record).collect();
        let source = FixedSource(rows);
        let flag = AtomicU8::new(SIGNAL_NONE);
        let mut writer = InterruptingWriter {
            lines: Vec::new(),
            flag: &flag,
        };
        let mut printed: Vec<u8> = Vec::new();

        let exported = export_structured(
            &source,
            StructuredFormat::Jsonl,
            &mut writer,
            &flag,
            &mut printed,
        )
        .await
        .expect("the loop runs");

        assert_eq!(exported.interrupted, Some(Signal::Int));
        assert_eq!(exported.exit_code(), 130);
        assert_eq!(exported.rows, 1);

        let written = String::from_utf8(writer.lines).expect("utf-8");
        assert_eq!(
            written.lines().count(),
            1,
            "one line was written: {written}"
        );

        assert_eq!(
            String::from_utf8(printed).expect("utf-8"),
            "SIGINT received. Stopping export...\nExport interrupted by SIGINT.\n"
        );
    }

    /// A backend's page is judged against the backend's own bound, not `MAX_PAGE_ROWS`: a store
    /// that reports a one-row page and is read against 5 000 stops after one row.
    #[tokio::test]
    async fn a_full_page_is_read_against_the_sources_own_bound() {
        let source = OneRowPages((0..3).map(record).collect());
        let flag = AtomicU8::new(SIGNAL_NONE);
        let mut writer: Vec<u8> = Vec::new();
        let mut printed: Vec<u8> = Vec::new();

        let exported = export_structured(
            &source,
            StructuredFormat::Jsonl,
            &mut writer,
            &flag,
            &mut printed,
        )
        .await
        .expect("the loop runs");

        assert_eq!(exported.rows, 3);
        let written = String::from_utf8(writer).expect("utf-8");
        assert_eq!(written.lines().count(), 3, "every page is read: {written}");
    }
}
