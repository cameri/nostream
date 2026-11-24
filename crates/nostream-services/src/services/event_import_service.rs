//! `event-import-service.ts`: the streaming import, its validation and the batch persister.
//!
//! Both readers stream — a JSONL line at a time, and a JSON array element at a time — so the
//! file is never materialised as one value. The array reader finds each element's end before
//! handing it to `serde_json`, so an element spanning many reads is parsed once (#1101).

use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};

use nostream_core::Event;
use nostream_core::crypto::{compute_event_id, verify_event_signature};
use nostream_relay::strategies::delete::{DeletionTargets, deletion_targets};
use nostream_scan::ElementEnd;
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
    /// Set once a comma was consumed: a comma must be followed by an element.
    expect_element: bool,
    /// Where the current element ends, as far as the bytes read so far show.
    element_end: ElementEnd,
    /// How many times an element was handed to the parser, so a test can prove each element
    /// is parsed once however many reads it spans.
    #[cfg(test)]
    parse_attempts: usize,
    /// The bytes handed to the parser over all its tries, so a test can prove parsing is linear.
    #[cfg(test)]
    parsed_bytes: usize,
}

impl<R: AsyncRead + Unpin> ArrayStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: Vec::new(),
            position: 0,
            opened: false,
            done: false,
            expect_element: false,
            element_end: ElementEnd::default(),
            #[cfg(test)]
            parse_attempts: 0,
            #[cfg(test)]
            parsed_bytes: 0,
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
    ///
    /// The grammar is the array's own, not `serde_json`'s per-element parse: a comma must be
    /// followed by an element (`[e,]` is not `[e]`), and nothing but whitespace may follow the
    /// closing bracket (`[e]garbage` is not an import).
    async fn next_value(&mut self) -> Result<Option<serde_json::Value>, ServicesError> {
        if !self.opened || self.done {
            return Ok(None);
        }

        loop {
            self.skip_whitespace();
            self.compact();

            if self.buffer.get(self.position) == Some(&b']') {
                if self.expect_element {
                    return Err(ServicesError::Import(
                        "Invalid JSON array input: expected an element after `,`".to_owned(),
                    ));
                }

                self.position += 1;
                self.done = true;
                self.expect_trailing_whitespace().await?;

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

            if self.expect_element && self.buffer[self.position] == b',' {
                return Err(ServicesError::Import(
                    "Invalid JSON array input: expected an element, found `,`".to_owned(),
                ));
            }

            // Parse once the element is complete, not after every read: a parse of a partial
            // element fails at its end, and retrying after every read re-parses the whole
            // prefix each time. An unfinished element — scalar included — is still tried each
            // time it doubles, so a malformed one fails without the reader buffering the rest
            // of the input.
            let element = &self.buffer[self.position..];
            let element_len = element.len();

            if !self.element_end.reached(element)
                && !self.element_end.probe_due(element_len)
                && self.read_more().await?
            {
                continue;
            }

            #[cfg(test)]
            {
                self.parse_attempts += 1;
                self.parsed_bytes += element_len;
            }

            let rest = &self.buffer[self.position..];
            let mut values =
                serde_json::Deserializer::from_slice(rest).into_iter::<serde_json::Value>();

            match values.next() {
                Some(Ok(value)) => {
                    self.position += values.byte_offset();
                    self.element_end = ElementEnd::default();

                    // Consume the separator, so the next call starts at the next element.
                    loop {
                        self.skip_whitespace();

                        match self.buffer.get(self.position) {
                            Some(&b',') => {
                                self.position += 1;
                                self.expect_element = true;
                                return Ok(Some(value));
                            }
                            Some(&b']') => {
                                self.expect_element = false;
                                return Ok(Some(value));
                            }
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

                    self.element_end.resume();
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

    /// Refuses anything but whitespace between the closing bracket and the end of input.
    async fn expect_trailing_whitespace(&mut self) -> Result<(), ServicesError> {
        loop {
            self.skip_whitespace();

            if let Some(byte) = self.buffer.get(self.position) {
                return Err(ServicesError::Import(format!(
                    "Invalid JSON array input: unexpected `{}` after the closing `]`",
                    char::from(*byte)
                )));
            }

            if !self.read_more().await? {
                return Ok(());
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
        let deduplication = event.d_tag_value().to_owned();

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
            // Several versions of one replaceable address may land in one batch; the store
            // keeps one row per conflict key, so the counters below report rows written.
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

                    // The live arm's reading of the request (#1097): `e` ids and the author's own
                    // `a` addresses, deduplicated, and refused whole past either cap. A refused
                    // request is neither applied nor stored, as the relay would not have stored
                    // it, so it counts as skipped.
                    let Ok(DeletionTargets { ids, addresses }) = deletion_targets(event) else {
                        continue;
                    };

                    if !ids.is_empty() {
                        self.events
                            .delete_by_pubkey_and_ids(&event.pubkey, &ids)
                            .await?;
                    }

                    if !addresses.is_empty() {
                        self.events
                            .delete_by_addresses(&event.pubkey, &addresses, event.created_at)
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use std::pin::Pin;
    use std::task::{Context, Poll};

    use tokio::io::{AsyncRead, ReadBuf};

    use super::ArrayStream;

    /// Hands out its input one byte per read, so every element boundary falls between reads.
    struct OneByteAtATime<'a>(&'a [u8]);

    impl AsyncRead for OneByteAtATime<'_> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if let Some((&first, rest)) = self.0.split_first() {
                buf.put_slice(&[first]);
                self.0 = rest;
            }

            Poll::Ready(Ok(()))
        }
    }

    async fn read_all<R: AsyncRead + Unpin>(
        stream: &mut ArrayStream<R>,
    ) -> Result<Vec<serde_json::Value>, String> {
        stream.open().await.map_err(|error| error.to_string())?;
        let mut values = Vec::new();

        while let Some(value) = stream
            .next_value()
            .await
            .map_err(|error| error.to_string())?
        {
            values.push(value);
        }

        Ok(values)
    }

    /// An array whose one element is far larger than the 8 KiB read size.
    fn one_large_element(content_len: usize) -> Vec<u8> {
        let content = "x".repeat(content_len);

        format!(r#"[{{"content":"{content}"}}]"#).into_bytes()
    }

    #[tokio::test]
    async fn an_element_spanning_many_reads_is_parsed_once() {
        let input = one_large_element(60 * 1024);
        let mut stream = ArrayStream::new(&input[..]);

        stream.open().await.expect("the input opens with `[`");
        let value = stream
            .next_value()
            .await
            .expect("the element parses")
            .expect("one element");

        assert_eq!(value["content"].as_str().map(str::len), Some(60 * 1024));
        assert!(
            stream
                .next_value()
                .await
                .expect("the array closes")
                .is_none()
        );
        assert_eq!(stream.parse_attempts, 1);
    }

    #[tokio::test]
    async fn byte_at_a_time_reads_find_each_element_end_and_parse_it_once() {
        // Brackets, braces, quotes and backslashes inside strings must not end an element;
        // scalars end at the byte after them.
        let input =
            br#" [ {"a":"x]}\"\\","b":[1,{"c":"]"}]} , "s\"]" ,12,-3.5e2, true,null,[[]],{} ] "#;
        let expected: Vec<serde_json::Value> =
            serde_json::from_slice(input).expect("the fixture is valid JSON");
        let mut stream = ArrayStream::new(OneByteAtATime(input));

        let values = read_all(&mut stream).await.expect("the array reads");

        assert_eq!(values, expected);
        assert_eq!(stream.parse_attempts, expected.len());
    }

    #[tokio::test]
    async fn a_truncated_element_still_reports_the_parsers_error() {
        let mut stream = ArrayStream::new(OneByteAtATime(br#"[{"a":1"#));

        assert_eq!(
            read_all(&mut stream).await,
            Err(
                "Invalid JSON array input: EOF while parsing an object at line 1 column 6"
                    .to_owned()
            )
        );
    }

    #[tokio::test]
    async fn a_scalar_cut_off_by_the_end_of_input_is_an_unexpected_end() {
        let mut stream = ArrayStream::new(OneByteAtATime(b"[12"));

        assert_eq!(
            read_all(&mut stream).await,
            Err("Invalid JSON array input: unexpected end of input".to_owned())
        );
    }

    #[tokio::test]
    async fn a_malformed_element_is_named_by_the_parser() {
        let mut stream = ArrayStream::new(OneByteAtATime(br#"[{"a" 1}]"#));

        let error = read_all(&mut stream)
            .await
            .expect_err("the element is malformed");

        assert!(
            error.starts_with("Invalid JSON array input: expected `:`"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_large_element_is_parsed_in_linear_time() {
        let input = one_large_element(4 * 1024 * 1024);
        let mut stream = ArrayStream::new(&input[..]);

        let values = read_all(&mut stream).await.expect("the array reads");

        assert_eq!(values.len(), 1);
        // Parsing after every 8 KiB read handed the parser about 1 GiB here; the doubling tries
        // and the final parse stay under three times the element.
        assert!(
            stream.parsed_bytes < 3 * input.len(),
            "{} bytes parsed for a {}-byte element",
            stream.parsed_bytes,
            input.len()
        );
    }

    #[tokio::test]
    async fn a_malformed_scalar_fails_without_buffering_the_rest_of_the_input() {
        // Greptile's P1 on #1235: a scalar never probes, so `[` followed by bytes that
        // cannot end a scalar buffers to EOF instead of failing on the first read.
        let mut input = b"[".to_vec();
        input.extend(std::iter::repeat_n(b'x', 4 * 1024 * 1024));
        let mut stream = ArrayStream::new(&input[..]);

        let error = read_all(&mut stream)
            .await
            .expect_err("the element is malformed");

        assert!(
            stream.buffer.len() <= 2 * nostream_scan::FIRST_PROBE,
            "{} bytes buffered before the fault was named: {error}",
            stream.buffer.len()
        );
    }

    #[tokio::test]
    async fn a_malformed_element_fails_without_buffering_the_rest_of_the_input() {
        // A missing `}` keeps the depth above zero, so the scan never finds the element's end.
        let mut input = br#"[{"a":1, {"b":2}"#.to_vec();
        input.extend(std::iter::repeat_n(b' ', 4 * 1024 * 1024));
        input.push(b']');
        let mut stream = ArrayStream::new(&input[..]);

        let error = read_all(&mut stream)
            .await
            .expect_err("the element is malformed");

        assert_eq!(
            error,
            "Invalid JSON array input: key must be a string at line 1 column 9"
        );
        assert!(
            stream.buffer.len() <= 2 * nostream_scan::FIRST_PROBE,
            "{} bytes buffered before the fault was named",
            stream.buffer.len()
        );
    }
}
