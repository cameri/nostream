//! JavaScript semantics over `serde_yaml::Value`.
//!
//! The validator's messages and its decisions are the capture's, and the capture runs on
//! JavaScript values: `typeof` names arrays `object`, truthiness accepts `[]` and `{}`, and a
//! comparison with `undefined` is `false`. These helpers keep those rules in one place so the
//! port does not quietly become Rust semantics.

use serde_yaml::{Mapping, Value};

/// Whether the value is a plain object (`typeof v === 'object' && v !== null && !Array.isArray(v)`).
pub fn is_plain_object(value: &Value) -> bool {
    matches!(value, Value::Mapping(_))
}

/// JavaScript truthiness: `false`, `0`, `""`, `null` and `undefined` are false; everything
/// else (including `[]` and `{}`) is true.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(boolean) => *boolean,
        Value::Number(number) => number
            .as_f64()
            .is_some_and(|float| float != 0.0 && !float.is_nan()),
        Value::String(string) => !string.is_empty(),
        Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_) => true,
    }
}

/// Truthiness of an optional value (`undefined` is false).
pub fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// The result of JavaScript `typeof value`.
pub fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::Null => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_) => "object",
    }
}

/// JavaScript `Number(value)`; `None` stands for `NaN`.
pub fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(boolean) => Some(if *boolean { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(string) => {
            let trimmed = string.trim();
            if trimmed.is_empty() {
                return Some(0.0);
            }
            if let Some(hex) = trimmed
                .strip_prefix("0x")
                .or_else(|| trimmed.strip_prefix("0X"))
            {
                return u64::from_str_radix(hex, 16).ok().map(|value| value as f64);
            }
            trimmed.parse::<f64>().ok().filter(|float| !float.is_nan())
        }
        Value::Sequence(_) | Value::Mapping(_) | Value::Tagged(_) => None,
    }
}

/// `value >= bound`, with `undefined` and non-numeric values comparing false.
pub fn number_ge(value: Option<&Value>, bound: f64) -> bool {
    value
        .and_then(to_number)
        .is_some_and(|number| number >= bound)
}

/// `value <= bound`, with `undefined` and non-numeric values comparing false.
pub fn number_le(value: Option<&Value>, bound: f64) -> bool {
    value
        .and_then(to_number)
        .is_some_and(|number| number <= bound)
}

/// `left >= right`, with either side missing or non-numeric comparing false.
pub fn compare_ge(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left.and_then(to_number), right.and_then(to_number)) {
        (Some(left), Some(right)) => left >= right,
        _ => false,
    }
}

/// `left <= right`, with either side missing or non-numeric comparing false.
pub fn compare_le(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left.and_then(to_number), right.and_then(to_number)) {
        (Some(left), Some(right)) => left <= right,
        _ => false,
    }
}

/// `value < bound`.
pub fn number_lt(value: Option<&Value>, bound: f64) -> bool {
    value
        .and_then(to_number)
        .is_some_and(|number| number < bound)
}

/// A property read (`value.name`); `None` means `undefined`.
pub fn key<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Mapping(mapping) => mapping.get(name),
        _ => None,
    }
}

/// A chain of property reads.
pub fn key_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for name in path {
        current = key(current, name)?;
    }
    Some(current)
}

/// Whether a value is `null` or absent (`isNil`).
pub fn is_nil(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(_) => false,
    }
}

/// Ramda's `mergeDeepRight`: objects merge recursively, arrays and scalars are replaced by
/// the right-hand value, and `null` is a value that replaces.
pub fn merge_deep_right(left: &Value, right: &Value) -> Value {
    match (left, right) {
        (Value::Mapping(left), Value::Mapping(right)) => {
            let mut merged = left.clone();
            for (key, right_value) in right {
                let value = match merged.get(key) {
                    Some(left_value) => merge_deep_right(left_value, right_value),
                    None => right_value.clone(),
                };
                merged.insert(key.clone(), value);
            }
            Value::Mapping(merged)
        }
        _ => right.clone(),
    }
}

/// An empty YAML mapping.
pub fn empty_mapping() -> Value {
    Value::Mapping(Mapping::new())
}

/// A YAML string value.
pub fn string_value(value: impl Into<String>) -> Value {
    Value::String(value.into())
}
