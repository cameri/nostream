//! Secret classification and redaction. Mirrors `src/utils/settings-redaction.ts`.

use serde_yaml::Value;

/// Keys whose values are secrets wherever they appear.
const SENSITIVE_SETTING_KEYS: [&str; 3] = ["passwordHash", "secret", "botToken"];

/// The placeholder a redacted value becomes.
const REDACTED: &str = "***";

fn last_key(path: &str) -> &str {
    let last = path.rsplit('.').next().unwrap_or(path);
    if last.ends_with(']')
        && let Some(bracket) = last.rfind('[')
    {
        return &last[..bracket];
    }
    last
}

/// Whether a settings path holds a secret.
///
/// Webhook URLs embed secrets (Discord/Slack tokens, signed HTTP endpoints), so `url` under
/// `admin.notifications.targets` is sensitive too.
pub fn is_sensitive_settings_path(path: &str) -> bool {
    let key = last_key(path);
    if SENSITIVE_SETTING_KEYS.contains(&key) {
        return true;
    }
    key == "url" && path.starts_with("admin.notifications.targets")
}

/// Whether a path may not be written through the settings editor.
pub fn is_write_protected_settings_path(path: &str) -> bool {
    path == "admin.passwordHash" || path.ends_with(".passwordHash")
}

/// Redacts one value by path.
pub fn redact_settings_value(path: &str, value: &Value) -> Value {
    match value {
        Value::String(text) if is_sensitive_settings_path(path) && !text.is_empty() => {
            Value::String(REDACTED.to_owned())
        }
        other => other.clone(),
    }
}

/// Redacts every secret in a settings document, walking arrays and objects.
pub fn redact_settings_secrets(value: &Value) -> Value {
    fn walk(value: &Value, path: &str) -> Value {
        match value {
            Value::Sequence(entries) => Value::Sequence(
                entries
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| walk(entry, &format!("{path}[{index}]")))
                    .collect(),
            ),
            Value::Mapping(mapping) => {
                let mut result = serde_yaml::Mapping::new();
                for (key, entry) in mapping {
                    let Some(key_name) = key.as_str() else {
                        result.insert(key.clone(), entry.clone());
                        continue;
                    };
                    let child_path = if path.is_empty() {
                        key_name.to_owned()
                    } else {
                        format!("{path}.{key_name}")
                    };
                    let redacted = match entry {
                        Value::String(text)
                            if is_sensitive_settings_path(&child_path) && !text.is_empty() =>
                        {
                            Value::String(REDACTED.to_owned())
                        }
                        other => walk(other, &child_path),
                    };
                    result.insert(key.clone(), redacted);
                }
                Value::Mapping(result)
            }
            other => other.clone(),
        }
    }

    walk(value, "")
}
