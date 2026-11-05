//! `event-import-service.ts`: the streaming import, its validation and the batch persister.
//!
//! Both readers stream — a JSONL line at a time, and a JSON array element at a time through
//! `serde_json`'s streaming deserializer — so the file is never materialised as one value.

use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};

use nostream_core::Event;
use nostream_core::crypto::{compute_event_id, verify_event_signature};
use nostream_core::event::EventId;
use nostream_storage::repositories::{EventRecord, EventRepository};

use crate::error::ServicesError;

/// The batch size a caller gets when it names none (`DEFAULT_BATCH_SIZE`,
/// `src/services/event-import-service.ts:49`).
pub const DEFAULT_BATCH_SIZE: u64 = 1_000;

/// How many line errors the CLI prints (`MAX_ERROR_LOGS`, `src/import-events.ts:34`).
pub const MAX_ERROR_LOGS: usize = 20;

/// The counters one import reports (`EventImportStats`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EventImportStats {
    pub processed: u64,
    pub inserted: u64,
    pub skipped: u64,
    pub errors: u64,
}

/// One rejected line (`EventImportLineError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventImportLineError {
    pub line_number: usize,
    pub reason: String,
}

/// How an import reports its progress.
pub struct ImportOptions<'a> {
    pub batch_size: u64,
    pub on_line_error: Option<&'a dyn Fn(&EventImportLineError)>,
    pub on_progress: Option<&'a dyn Fn(&EventImportStats)>,
}

impl Default for ImportOptions<'_> {
    fn default() -> Self {
        Self {
            batch_size: DEFAULT_BATCH_SIZE,
            on_line_error: None,
            on_progress: None,
        }
    }
}

/// The cap-and-count the CLI applies to line errors, and the same one a test asserts.
#[derive(Debug, Default)]
pub struct LineErrorSink {
    pub printed: Vec<EventImportLineError>,
    pub suppressed: u64,
}

impl LineErrorSink {
    /// Records one error: the first [`MAX_ERROR_LOGS`] are kept, the rest counted. Returns
    /// whether the caller should print it.
    pub fn record(&mut self, error: &EventImportLineError) -> bool {
        if self.printed.len() < MAX_ERROR_LOGS {
            self.printed.push(error.clone());

            true
        } else {
            self.suppressed += 1;

            false
        }
    }
}

/// One batch's write, returning the insert count the capture's repository reports
/// (`Number` there, hence `f64` here: a non-integer count is a failure the service checks).
pub trait EventBatchPersister: Send + Sync {
    fn persist<'a>(
        &'a self,
        events: &'a [Event],
    ) -> Pin<Box<dyn Future<Output = Result<f64, ServicesError>> + Send + 'a>>;
}

/// `EventImportService`.
pub struct EventImportService {
    persister: Arc<dyn EventBatchPersister>,
}

impl EventImportService {
    /// Builds the service over one persister.
    pub fn new(persister: Arc<dyn EventBatchPersister>) -> Self {
        Self { persister }
    }

    /// `importFromReadable`: one JSONL line at a time.
    pub async fn import_jsonl<R: AsyncBufRead + Unpin>(
        &self,
        reader: R,
        options: &ImportOptions<'_>,
    ) -> Result<EventImportStats, ServicesError> {
        let mut run = ImportRun::new(self.persister.as_ref(), options);
        let mut lines = BufReader::new(reader).lines();
        let mut line_number = 0usize;

        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|error| ServicesError::Import(error.to_string()))?
        {
            line_number += 1;
            let trimmed = line.trim();

            if trimmed.is_empty() {
                continue;
            }

            let candidate = serde_json::from_str::<Event>(trimmed)
                .map_err(|error| error.to_string())
                .and_then(validate);

            run.candidate(line_number, candidate).await?;
        }

        run.flush().await?;

        Ok(run.stats)
    }

    /// `importFromJsonArray`: one array element at a time.
    pub async fn import_json_array<R: AsyncRead + Unpin>(
        &self,
        reader: R,
        options: &ImportOptions<'_>,
    ) -> Result<EventImportStats, ServicesError> {
        let mut run = ImportRun::new(self.persister.as_ref(), options);
        let mut stream = ArrayStream::new(reader);

        stream.open().await?;
        let mut record_number = 0usize;

        while let Some(value) = stream.next_value().await? {
            record_number += 1;
            let candidate = serde_json::from_value::<Event>(value)
                .map_err(|error| error.to_string())
                .and_then(validate);

            run.candidate(record_number, candidate).await?;
        }

        run.flush().await?;

        Ok(run.stats)
    }
}

/// One import's mutable state.
struct ImportRun<'a> {
    persister: &'a dyn EventBatchPersister,
    options: &'a ImportOptions<'a>,
    batch_size: u64,
    batch: Vec<Event>,
    stats: EventImportStats,
}

impl<'a> ImportRun<'a> {
    fn new(persister: &'a dyn EventBatchPersister, options: &'a ImportOptions<'a>) -> Self {
        let batch_size = if options.batch_size > 0 {
            options.batch_size
        } else {
            DEFAULT_BATCH_SIZE
        };

        Self {
            persister,
            options,
            batch_size,
            batch: Vec::new(),
            stats: EventImportStats::default(),
        }
    }

    async fn candidate(
        &mut self,
        line_number: usize,
        candidate: Result<Event, String>,
    ) -> Result<(), ServicesError> {
        self.stats.processed += 1;

        match candidate {
            Ok(event) => {
                self.batch.push(event);

                if self.batch.len() as u64 >= self.batch_size {
                    self.flush().await?;
                }
            }
            Err(reason) => {
                self.stats.errors += 1;

                if let Some(on_line_error) = self.options.on_line_error {
                    on_line_error(&EventImportLineError {
                        line_number,
                        reason,
                    });
                }
            }
        }

        Ok(())
    }

    async fn flush(&mut self) -> Result<(), ServicesError> {
        if self.batch.is_empty() {
            return Ok(());
        }

        let current_batch_size = self.batch.len();
        let inserted = self.persister.persist(&self.batch).await?;

        if !inserted.is_finite()
            || inserted.fract() != 0.0
            || inserted < 0.0
            || inserted > current_batch_size as f64
        {
            return Err(ServicesError::Import(format!(
                "Invalid insert count ({inserted}) for batch size {current_batch_size}"
            )));
        }

        let inserted = inserted as u64;
        self.stats.inserted += inserted;
        self.stats.skipped += current_batch_size as u64 - inserted;
        self.batch.clear();

        if let Some(on_progress) = self.options.on_progress {
            on_progress(&self.stats);
        }

        Ok(())
    }
}

/// The capture's per-candidate validation: the strict schema, then the id, then the signature.
fn validate(event: Event) -> Result<Event, String> {
    nostream_core::validation::validate_event(&event).map_err(|error| error.to_string())?;

    let computed = compute_event_id(&event).map_err(|error| error.to_string())?;

    if computed != event.id {
        return Err("invalid: event id does not match".to_owned());
    }

    verify_event_signature(&event)
        .map_err(|_| "invalid: event signature verification failed".to_owned())?;

    Ok(event)
}

/// An incremental JSON-array reader: it parses one element at a time from a growing buffer and
/// keeps only the unconsumed tail.
struct ArrayStream<R> {
    reader: R,
    buffer: Vec<u8>,
    position: usize,
    opened: bool,
    done: bool,
}

impl<R: AsyncRead + Unpin> ArrayStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
            position: 0,
            opened: false,
            done: false,
        }
    }

    async fn read_more(&mut self) -> Result<bool, ServicesError> {
        let mut chunk = [0u8; 8 * 1024];
        let read =
            self.reader.read(&mut chunk).await.map_err(|error| {
                ServicesError::Import(format!("Invalid JSON array input: {error}"))
            })?;

        if read == 0 {
            return Ok(false);
        }

        self.buffer.extend_from_slice(&chunk[..read]);

        Ok(true)
    }

    fn skip_whitespace(&mut self) {
        while self
            .buffer
            .get(self.position)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.position += 1;
        }
    }

    fn compact(&mut self) {
        if self.position > 64 * 1024 {
            self.buffer.drain(..self.position);
            self.position = 0;
        }
    }

    async fn open(&mut self) -> Result<(), ServicesError> {
        loop {
            self.skip_whitespace();

            match self.buffer.get(self.position) {
                Some(&b'[') => {
                    self.position += 1;
                    self.opened = true;
                    return Ok(());
                }
                Some(other) => {
                    return Err(ServicesError::Import(format!(
                        "Invalid JSON array input: expected `[`, found `{}`",
                        char::from(*other)
                    )));
                }
                None => {
                    if !self.read_more().await? {
                        return Err(ServicesError::Import(
                            "Invalid JSON array input: unexpected end of input".to_owned(),
                        ));
                    }
                }
            }
        }
    }

    /// The next element, or `None` at the closing bracket.
    async fn next_value(&mut self) -> Result<Option<serde_json::Value>, ServicesError> {
        if !self.opened || self.done {
            return Ok(None);
        }

        loop {
            self.skip_whitespace();
            self.compact();

            if self.buffer.get(self.position) == Some(&b']') {
                self.position += 1;
                self.done = true;
                return Ok(None);
            }

            if self.buffer.get(self.position).is_none() {
                if !self.read_more().await? {
                    return Err(ServicesError::Import(
                        "Invalid JSON array input: unexpected end of input".to_owned(),
                    ));
                }

                continue;
            }

            let rest = &self.buffer[self.position..];
            let mut values =
                serde_json::Deserializer::from_slice(rest).into_iter::<serde_json::Value>();

            match values.next() {
                Some(Ok(value)) => {
                    self.position += values.byte_offset();

                    // Consume the separator, so the next call starts at the next element.
                    loop {
                        self.skip_whitespace();

                        match self.buffer.get(self.position) {
                            Some(&b',') => {
                                self.position += 1;
                                return Ok(Some(value));
                            }
                            Some(&b']') => return Ok(Some(value)),
                            Some(other) => {
                                return Err(ServicesError::Import(format!(
                                    "Invalid JSON array input: expected `,` or `]`, found `{}`",
                                    char::from(*other)
                                )));
                            }
                            None => {
                                if !self.read_more().await? {
                                    return Err(ServicesError::Import(
                                        "Invalid JSON array input: unexpected end of input"
                                            .to_owned(),
                                    ));
                                }
                            }
                        }
                    }
                }
                Some(Err(error)) if error.is_eof() => {
                    if !self.read_more().await? {
                        return Err(ServicesError::Import(format!(
                            "Invalid JSON array input: {error}"
                        )));
                    }
                }
                Some(Err(error)) => {
                    return Err(ServicesError::Import(format!(
                        "Invalid JSON array input: {error}"
                    )));
                }
                None => {
                    if !self.read_more().await? {
                        return Err(ServicesError::Import(
                            "Invalid JSON array input: unexpected end of input".to_owned(),
                        ));
                    }
                }
            }
        }
    }
}

/// The repository-backed batch writer (`createEventBatchPersister`,
/// `src/services/event-import-service.ts:91-142`).
pub struct RepositoryEventPersister {
    events: Arc<dyn EventRepository>,
}

impl RepositoryEventPersister {
    /// Builds the persister over the event store.
    pub fn new(events: Arc<dyn EventRepository>) -> Self {
        Self { events }
    }
}

/// The insert-time metadata the import sets (`enrichEventMetadata`, `:30-47`).
fn enrich(event: &Event) -> EventRecord {
    let mut record = EventRecord::from_event(event);

    if let Some(expiration) = nostream_core::expiration::get_event_expiration(event) {
        record.expires_at = Some(i64::from(expiration));
    }

    if event.kind.is_parameterized_replaceable() {
        let deduplication = event
            .tags
            .iter()
            .find(|tag| tag.len() >= 2 && tag[0] == "d")
            .map(|tag| tag[1].clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_default();

        record.event_deduplication = Some(vec![serde_json::Value::String(deduplication)]);
    }

    record
}

impl EventBatchPersister for RepositoryEventPersister {
    fn persist<'a>(
        &'a self,
        events: &'a [Event],
    ) -> Pin<Box<dyn Future<Output = Result<f64, ServicesError>> + Send + 'a>> {
        Box::pin(async move {
            if events.is_empty() {
                return Ok(0.0);
            }

            let mut inserted = 0u64;
            let mut regular: Vec<EventRecord> = Vec::new();
            let mut replaceable: Vec<EventRecord> = Vec::new();

            for event in events {
                if event.kind.is_ephemeral() {
                    continue;
                }

                if event.kind == nostream_core::Kind::DELETE {
                    inserted += self.events.create_many(&regular).await?;
                    regular.clear();
                    inserted += self.events.upsert_many(&replaceable).await?;
                    replaceable.clear();

                    let ids: Vec<EventId> = event
                        .tags
                        .iter()
                        .filter(|tag| tag.len() >= 2 && tag[0] == "e")
                        .filter_map(|tag| tag[1].parse::<EventId>().ok())
                        .collect();

                    if !ids.is_empty() {
                        self.events
                            .delete_by_pubkey_and_ids(&event.pubkey, &ids)
                            .await?;
                    }

                    inserted += self.events.create(&enrich(event)).await?;
                    continue;
                }

                let enriched = enrich(event);

                if event.kind.is_replaceable() || event.kind.is_parameterized_replaceable() {
                    replaceable.push(enriched);
                } else {
                    regular.push(enriched);
                }
            }

            inserted += self.events.create_many(&regular).await?;
            inserted += self.events.upsert_many(&replaceable).await?;

            Ok(inserted as f64)
        })
    }
}
