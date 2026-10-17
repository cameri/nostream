//! The dot-path editor and value parser. Mirrors the path half of
//! `src/utils/settings-config.ts` (`parsePath`, `formatPathTokens`, `getByPath`, `setByPath`,
//! `validatePathAgainstDefaults`, `parseValue`, `parseTypedValue`).

use serde_yaml::{Mapping, Value};
use thiserror::Error;

use crate::issue::Issue;

/// A parsed path element: a key or an array index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathToken {
    Key(String),
    Index(usize),
}

/// A path that cannot be parsed or applied. Messages are the capture's.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathError {
    #[error("Path is required")]
    Required,
    #[error("Invalid path segment in: {0}")]
    InvalidSegmentIn(String),
    #[error("Invalid path segment: {0}")]
    InvalidSegment(String),
    #[error("Cannot set key {0} on non-object path")]
    SetKeyOnNonObject(String),
    #[error("Cannot index non-array path at [{0}]")]
    IndexNonArray(usize),
}

/// Keys that would reach a JavaScript prototype. Mirrors `RESERVED_PATH_KEYS`.
const RESERVED_PATH_KEYS: [&str; 3] = ["__proto__", "prototype", "constructor"];

/// Renders tokens back into the `a.b[0].c` form.
pub fn format_path_tokens(tokens: &[PathToken]) -> String {
    let mut out = String::new();
    for token in tokens {
        match token {
            PathToken::Key(key) => {
                if !out.is_empty() {
                    out.push('.');
                }
                out.push_str(key);
            }
            PathToken::Index(index) => {
                out.push('[');
                out.push_str(&index.to_string());
                out.push(']');
            }
        }
    }
    out
}

/// Parses `a.b[0].c` into tokens.
///
/// Grammar per segment: `^([A-Za-z_][A-Za-z0-9_]*)(\[(\d+)\])*$`, with the reserved-key guard
/// applied to the key part.
pub fn parse_path(path: &str) -> Result<Vec<PathToken>, PathError> {
    let input = path.trim();
    if input.is_empty() {
        return Err(PathError::Required);
    }

    let mut tokens = Vec::new();
    for segment in input.split('.').map(str::trim) {
        if segment.is_empty() {
            return Err(PathError::InvalidSegmentIn(path.to_owned()));
        }
        let Some((key, indexes)) = split_segment(segment) else {
            return Err(PathError::InvalidSegment(segment.to_owned()));
        };
        if RESERVED_PATH_KEYS.contains(&key.as_str()) {
            return Err(PathError::InvalidSegment(segment.to_owned()));
        }
        tokens.push(PathToken::Key(key));
        for index in indexes {
            tokens.push(PathToken::Index(index));
        }
    }
    Ok(tokens)
}

/// Splits one segment into its key and its indexes, or `None` when it does not fit the grammar.
fn split_segment(segment: &str) -> Option<(String, Vec<usize>)> {
    let mut chars = segment.char_indices();
    let (_, first) = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let mut key_end = first.len_utf8();
    for (offset, character) in chars {
        if character.is_ascii_alphanumeric() || character == '_' {
            key_end = offset + character.len_utf8();
        } else {
            break;
        }
    }
    let key = segment[..key_end].to_owned();
    let mut rest = &segment[key_end..];
    let mut indexes = Vec::new();
    while !rest.is_empty() {
        let inner = rest.strip_prefix('[')?;
        let close = inner.find(']')?;
        let digits = &inner[..close];
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        indexes.push(digits.parse::<usize>().ok()?);
        rest = &inner[close + 1..];
    }
    Some((key, indexes))
}

/// Reads a value by path; `Ok(None)` means the path does not exist (`undefined` in the capture).
pub fn get_by_path<'a>(document: &'a Value, path: &str) -> Result<Option<&'a Value>, PathError> {
    let tokens = parse_path(path)?;
    let mut current = document;
    for token in &tokens {
        match token {
            PathToken::Key(key) => match current {
                Value::Mapping(mapping) => match mapping.get(key.as_str()) {
                    Some(value) => current = value,
                    None => return Ok(None),
                },
                _ => return Ok(None),
            },
            PathToken::Index(index) => match current {
                Value::Sequence(sequence) => match sequence.get(*index) {
                    Some(value) => current = value,
                    None => return Ok(None),
                },
                _ => return Ok(None),
            },
        }
    }
    Ok(Some(current))
}

/// Ensures `target` has at least `minimum + 1` entries, padding with `null`.
///
/// The capture pads with JavaScript `undefined`; `serde_yaml::Value` has no such value, so the
/// padding is `null`. The only observable difference is a shape-validation message at a padded
/// slot, and no settings path needs one.
fn ensure_array_length(target: &mut Vec<Value>, minimum: usize) {
    while target.len() <= minimum {
        target.push(Value::Null);
    }
}

fn next_container(next_is_index: bool) -> Value {
    if next_is_index {
        Value::Sequence(Vec::new())
    } else {
        Value::Mapping(Mapping::new())
    }
}

fn is_compatible(existing: &Value, next_is_index: bool) -> bool {
    match existing {
        Value::Sequence(_) => next_is_index,
        Value::Mapping(_) => !next_is_index,
        _ => false,
    }
}

/// Writes a value by path, returning a modified clone.
pub fn set_by_path(document: &Value, path: &str, value: Value) -> Result<Value, PathError> {
    let tokens = parse_path(path)?;
    let mut clone = document.clone();
    let Some((last, _)) = tokens.split_last() else {
        return Err(PathError::Required);
    };

    let mut current = &mut clone;
    for position in 0..tokens.len() - 1 {
        let token = &tokens[position];
        let next_is_index = matches!(tokens[position + 1], PathToken::Index(_));
        let replacement = next_container(next_is_index);
        current = match token {
            PathToken::Key(key) => {
                let Value::Mapping(mapping) = current else {
                    return Err(PathError::SetKeyOnNonObject(key.clone()));
                };
                mapping
                    .entry(Value::String(key.clone()))
                    .and_modify(|existing| {
                        if !is_compatible(existing, next_is_index) {
                            *existing = replacement.clone();
                        }
                    })
                    .or_insert(replacement)
            }
            PathToken::Index(index) => {
                let Value::Sequence(sequence) = current else {
                    return Err(PathError::IndexNonArray(*index));
                };
                ensure_array_length(sequence, *index);
                let slot = &mut sequence[*index];
                if !is_compatible(slot, next_is_index) {
                    *slot = replacement;
                }
                slot
            }
        };
    }

    match last {
        PathToken::Key(key) => {
            let Value::Mapping(mapping) = current else {
                return Err(PathError::SetKeyOnNonObject(key.clone()));
            };
            mapping.insert(Value::String(key.clone()), value);
        }
        PathToken::Index(index) => {
            let Value::Sequence(sequence) = current else {
                return Err(PathError::IndexNonArray(*index));
            };
            ensure_array_length(sequence, *index);
            sequence[*index] = value;
        }
    }

    Ok(clone)
}

fn path_exists_in_schema(schema: &Value, tokens: &[PathToken]) -> bool {
    let mut current = schema;
    for token in tokens {
        match token {
            PathToken::Key(key) => {
                let Value::Mapping(mapping) = current else {
                    return false;
                };
                let Some(next) = mapping.get(key.as_str()) else {
                    return false;
                };
                current = next;
            }
            PathToken::Index(_) => {
                let Value::Sequence(sequence) = current else {
                    return false;
                };
                if sequence.is_empty() {
                    return true;
                }
                current = &sequence[0];
            }
        }
    }
    true
}

/// Checks a path against the defaults document used as schema.
pub fn validate_path_against_defaults(defaults: &Value, path: &str) -> Result<Vec<Issue>, PathError> {
    let tokens = parse_path(path)?;
    if path_exists_in_schema(defaults, &tokens) {
        return Ok(Vec::new());
    }
    Ok(vec![Issue::new(
        path,
        "Path does not exist in default settings schema",
    )])
}

/// A value parsed from a string, keeping the distinction the capture keeps with `bigint`.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedValue {
    Bool(bool),
    Null,
    Number(i64),
    BigInt(String),
    Json(Value),
    String(String),
}

impl ParsedValue {
    /// Converts to a YAML value; a bigint becomes its decimal string, which is what
    /// `toSerializable` does before saving.
    pub fn to_value(&self) -> Value {
        match self {
            Self::Bool(boolean) => Value::Bool(*boolean),
            Self::Null => Value::Null,
            Self::Number(number) => Value::Number((*number).into()),
            Self::BigInt(digits) | Self::String(digits) => Value::String(digits.clone()),
            Self::Json(value) => value.clone(),
        }
    }
}

/// Parses a string the way the settings editor's `inferred` mode does.
pub fn parse_value(raw: &str) -> ParsedValue {
    let trimmed = raw.trim();
    match trimmed {
        "true" => return ParsedValue::Bool(true),
        "false" => return ParsedValue::Bool(false),
        "null" => return ParsedValue::Null,
        _ => {}
    }

    if is_integer_literal(trimmed)
        && let Ok(number) = trimmed.parse::<i64>()
        && number.unsigned_abs() <= 9_007_199_254_740_991
    {
        return ParsedValue::Number(number);
    }

    if let Some(digits) = trimmed.strip_suffix('n')
        && is_integer_literal(digits)
    {
        return ParsedValue::BigInt(digits.to_owned());
    }

    if ((trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']')))
        && let Ok(value) = serde_json::from_str::<Value>(trimmed)
    {
        return ParsedValue::Json(value);
    }

    ParsedValue::String(raw.to_owned())
}

fn is_integer_literal(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// Parses a string in the editor's `json` mode.
pub fn parse_typed_json(raw: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(raw).map_err(|error| format!("Invalid JSON value: {error}"))
}
