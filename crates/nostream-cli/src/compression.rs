//! The two compressed export shapes: gzip and xz, their format names and their environment knobs.
//!
//! Mirrors `src/utils/compression.ts`. The xz preset and thread cap are the capture's — 6 and 4,
//! one core left to the relay — and both environment overrides keep its messages
//! (`Invalid NOSTREAM_XZ_PRESET: 10. Expected an integer between 0 and 9.`).

use std::io::Write;
use std::path::Path;

use crate::env_file::Environment;
use crate::error::CliError;

/// The compression a compressed export writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    Gzip,
    Xz,
}

/// `DEFAULT_XZ_PRESET` and `DEFAULT_MAX_XZ_THREADS` (`src/utils/compression.ts:15-16`).
const DEFAULT_XZ_PRESET: u32 = 6;
const DEFAULT_MAX_XZ_THREADS: usize = 4;
const MIN_XZ_PRESET: u32 = 0;
const MAX_XZ_PRESET: u32 = 9;

impl Compression {
    /// The label the summary lines print.
    pub fn label(self) -> &'static str {
        match self {
            Self::Gzip => "gzip",
            Self::Xz => "xz",
        }
    }

    /// `parseCompressionFormat`: `gzip`/`gz` and `xz`, case- and space-insensitive.
    pub fn parse(token: &str) -> Option<Self> {
        match token.trim().to_ascii_lowercase().as_str() {
            "gzip" | "gz" => Some(Self::Gzip),
            "xz" => Some(Self::Xz),
            _ => None,
        }
    }

    /// `getCompressionFormatFromExtension`: `.gz` and `.xz`.
    pub fn from_extension(path: &Path) -> Option<Self> {
        match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("gz") => Some(Self::Gzip),
            Some("xz") => Some(Self::Xz),
            _ => None,
        }
    }
}

/// The xz encoder's knobs, resolved from the environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XzOptions {
    pub preset: u32,
    /// The threads this run may use. `xz2` 0.1 exposes no multithreaded encoder, so the number is
    /// resolved and validated here and does not reach the encoder:
    ///
    /// shortcut: the xz stream is written single-threaded; upgrade when `xz2` exposes
    /// `lzma_stream_encoder_mt`, which is the only way this number can take effect.
    pub threads: usize,
}

/// `getXzCompressionOptions`: the preset, then the thread cap.
pub fn xz_options(env: &Environment) -> Result<XzOptions, CliError> {
    let preset = match parse_integer("NOSTREAM_XZ_PRESET", env)? {
        Some(preset) => u32::try_from(preset).unwrap_or(0),
        None => DEFAULT_XZ_PRESET,
    };

    if !(MIN_XZ_PRESET..=MAX_XZ_PRESET).contains(&preset) {
        return Err(CliError::command(format!(
            "Invalid NOSTREAM_XZ_PRESET: {preset}. Expected an integer between {MIN_XZ_PRESET} \
             and {MAX_XZ_PRESET}."
        )));
    }

    let cap = match parse_integer("NOSTREAM_XZ_THREADS", env)? {
        Some(threads) => {
            if threads <= 0 {
                return Err(CliError::command(
                    "Invalid NOSTREAM_XZ_THREADS: expected a positive integer.",
                ));
            }
            usize::try_from(threads).unwrap_or(DEFAULT_MAX_XZ_THREADS)
        }
        None => DEFAULT_MAX_XZ_THREADS,
    };

    let available = std::thread::available_parallelism()
        .map(|count| count.get().saturating_sub(1).max(1))
        .unwrap_or(1);

    Ok(XzOptions {
        preset,
        threads: available.min(cap).max(1),
    })
}

/// `parseIntegerEnv`: an unset or blank value is absent; anything else must be an integer.
fn parse_integer(key: &str, env: &Environment) -> Result<Option<i64>, CliError> {
    let Some(raw) = env.get(key) else {
        return Ok(None);
    };
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Ok(None);
    }

    let digits = trimmed.strip_prefix('-').unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CliError::command(format!(
            "Invalid {key}: {raw}. Expected an integer."
        )));
    }

    trimmed
        .parse::<i64>()
        .map(Some)
        .map_err(|_| CliError::command(format!("Invalid {key}: {raw}. Expected an integer.")))
}

/// The sink an export writes through: the compressor a shape names, or the plain writer.
///
/// A boxed [`Write`] cannot be finished: `.gz`/`.xz` write their trailer from `Drop`, where an
/// error has nowhere to go, so a failing trailer left a truncated archive behind an exit 0. This
/// enum keeps the three writers named and gives them [`Sink::finish`], which reports the
/// trailer's own result and is what the export path calls before it reports success.
pub enum Sink<'a> {
    Plain(&'a mut dyn Write),
    Gzip(flate2::write::GzEncoder<&'a mut dyn Write>),
    Xz(xz2::write::XzEncoder<&'a mut dyn Write>),
}

impl Write for Sink<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Plain(writer) => writer.write(buffer),
            Self::Gzip(encoder) => encoder.write(buffer),
            Self::Xz(encoder) => encoder.write(buffer),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Plain(writer) => writer.flush(),
            Self::Gzip(encoder) => encoder.flush(),
            Self::Xz(encoder) => encoder.flush(),
        }
    }
}

impl Sink<'_> {
    /// Ends the stream and answers the trailer's write, which is the one `Drop` cannot report.
    pub fn finish(mut self) -> std::io::Result<()> {
        match &mut self {
            Self::Plain(writer) => writer.flush(),
            Self::Gzip(encoder) => encoder.try_finish(),
            Self::Xz(encoder) => encoder.try_finish(),
        }
    }
}

/// The sink that compresses `inner` in `format`.
///
/// The xz encoder's preset comes from the environment, so this can fail; gzip's cannot.
pub fn encoder<'a>(
    format: Compression,
    inner: &'a mut dyn Write,
    env: &Environment,
) -> Result<Sink<'a>, CliError> {
    match format {
        Compression::Gzip => Ok(Sink::Gzip(flate2::write::GzEncoder::new(
            inner,
            flate2::Compression::default(),
        ))),
        Compression::Xz => {
            let options = xz_options(env)?;
            Ok(Sink::Xz(xz2::write::XzEncoder::new(inner, options.preset)))
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;
    use std::collections::BTreeMap;

    fn environment(pairs: &[(&str, &str)]) -> Environment {
        let table: BTreeMap<String, String> = pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        Environment::from_values(table)
    }

    #[test]
    fn the_two_formats_parse_by_their_names() {
        assert_eq!(Compression::parse("gzip"), Some(Compression::Gzip));
        assert_eq!(Compression::parse("GZ"), Some(Compression::Gzip));
        assert_eq!(Compression::parse("xz"), Some(Compression::Xz));
        assert_eq!(Compression::parse("bzip2"), None);
    }

    #[test]
    fn the_extension_names_the_format() {
        assert_eq!(
            Compression::from_extension(Path::new("out.jsonl.gz")),
            Some(Compression::Gzip)
        );
        assert_eq!(
            Compression::from_extension(Path::new("out.xz")),
            Some(Compression::Xz)
        );
        assert_eq!(Compression::from_extension(Path::new("out.jsonl")), None);
    }

    #[test]
    fn the_preset_defaults_to_six_and_is_capped() {
        assert_eq!(xz_options(&environment(&[])).unwrap().preset, 6);
        assert_eq!(
            xz_options(&environment(&[("NOSTREAM_XZ_PRESET", "9")]))
                .unwrap()
                .preset,
            9
        );

        let error = xz_options(&environment(&[("NOSTREAM_XZ_PRESET", "10")])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid NOSTREAM_XZ_PRESET: 10. Expected an integer between 0 and 9."
        );

        let error = xz_options(&environment(&[("NOSTREAM_XZ_THREADS", "0")])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid NOSTREAM_XZ_THREADS: expected a positive integer."
        );

        let error = xz_options(&environment(&[("NOSTREAM_XZ_PRESET", "high")])).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid NOSTREAM_XZ_PRESET: high. Expected an integer."
        );
    }

    #[test]
    fn the_threads_never_exceed_the_cap_or_the_cores() {
        let options = xz_options(&environment(&[("NOSTREAM_XZ_THREADS", "2")])).unwrap();
        assert!(options.threads >= 1 && options.threads <= 2);
    }

    #[test]
    fn gzip_output_starts_with_its_magic() {
        let mut buffer = Vec::new();
        {
            let mut encoder = encoder(Compression::Gzip, &mut buffer, &environment(&[])).unwrap();
            encoder.write_all(b"hello world\n").unwrap();
            encoder.flush().unwrap();
        }
        assert_eq!(&buffer[..2], &[0x1f, 0x8b]);
    }

    #[test]
    fn xz_output_starts_with_its_magic() {
        let mut buffer = Vec::new();
        {
            let mut encoder = encoder(Compression::Xz, &mut buffer, &environment(&[])).unwrap();
            encoder.write_all(b"hello world\n").unwrap();
            encoder.flush().unwrap();
        }
        assert_eq!(&buffer[..6], &[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
    }
}
