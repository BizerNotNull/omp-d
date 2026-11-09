//! Native global settings; values and validation stay authoritative in the CLI.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::agent::StartOptions;

// config set flushes an entire file, so even writes from separate windows must serialize.
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Deserialize)]
struct RawSetting {
    #[serde(rename = "type")]
    kind: String,
    description: String,
    // A present JSON null is different from an omitted (undefined) value.
    #[serde(flatten)]
    fields: Map<String, Value>,
}

type Listing = BTreeMap<String, RawSetting>;

#[derive(Serialize)]
pub struct Settings {
    entries: BTreeMap<String, SettingEntry>,
}

#[derive(Serialize)]
struct SettingEntry {
    #[serde(rename = "type")]
    kind: String,
    description: String,
    #[serde(flatten)]
    fields: Map<String, Value>,
    group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    choices: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stored: Option<Map<String, Value>>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    overridden_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_env: Option<String>,
}

fn profile(options: &StartOptions) -> Option<&str> {
    let args = options.extra_args.as_deref().unwrap_or_default();
    let mut profile = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--profile" {
            index += 1;
            profile = args.get(index).map(String::as_str);
        } else if let Some(value) = args[index].strip_prefix("--profile=") {
            profile = Some(value);
        }
        index += 1;
    }
    profile
}

async fn execute(options: &StartOptions, args: &[&str], writing: bool) -> Result<Vec<u8>, String> {
    let cwd = std::fs::canonicalize(&options.cwd)
        .map_err(|_| "Cannot open settings project directory".to_string())?;
    if !cwd.is_dir() {
        return Err("Settings project path is not a directory".into());
    }
    let program = options.binary.as_deref().map(str::trim)
        .filter(|value| !value.is_empty()).unwrap_or("omp");
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd)
        .env("NO_COLOR", "1").env("FORCE_COLOR", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true);
    // Config commands do not accept launcher --config/extension/session flags.
    if let Some(profile) = profile(options) {
        command.env("OMP_PROFILE", profile);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output()).await
        .map_err(|_| if writing {
            "Settings CLI timed out after 30 seconds; reload to check whether the write completed".to_string()
        } else {
            "Settings CLI timed out after 30 seconds".to_string()
        })?
        .map_err(|_| "Cannot execute configured omp binary for settings".to_string())?;
    if !output.status.success() {
        // Native parse/validation errors can echo submitted values or existing credentials.
        // Classify known failures without returning any subprocess text to the frontend.
        let error = String::from_utf8_lossy(&output.stderr);
        let reason = if error.contains("EACCES") || error.contains("EPERM") {
            "Permission denied; check access to the native configuration directory"
        } else if error.contains("ENOSPC") {
            "No space left to save the native configuration"
        } else if error.contains("Invalid boolean") {
            "Invalid boolean; use true/false, yes/no, on/off, or 1/0"
        } else if error.contains("Invalid number") {
            "Invalid number; enter a finite numeric value"
        } else if error.contains("Invalid array") {
            "Invalid array; enter a JSON array"
        } else if error.contains("Invalid record") {
            "Invalid record; enter a JSON object"
        } else if error.contains("Invalid value") {
            "Native validation rejected the value; use one of the listed choices"
        } else if writing {
            "Native settings write failed; check the setting description and configuration permissions, then reload before retrying"
        } else {
            "Native settings query failed; check the configured omp binary and profile"
        };
        return Err(reason.into());
    }
    Ok(output.stdout)
}

async fn list(options: &StartOptions, global: bool) -> Result<Listing, String> {
    let args: &[&str] = if global {
        &["config", "list", "--scope", "global", "--json"]
    } else {
        &["config", "list", "--json"]
    };
    let bytes = execute(options, args, false).await?;
    serde_json::from_slice(&bytes).map_err(|_| "Native settings CLI returned invalid settings JSON".into())
}

fn visible_fields(setting: &RawSetting) -> Map<String, Value> {
    let mut fields = Map::new();
    if setting.fields.get("redacted") == Some(&Value::Bool(true)) {
        fields.insert("redacted".into(), Value::Bool(true));
    } else if let Some(value) = setting.fields.get("value") {
        fields.insert("value".into(), value.clone());
    }
    fields
}

// Strip CSI and OSC sequences, including OSC hyperlinks, without a regex dependency.
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for ch in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&ch) { break; }
                }
            }
            Some(']') => {
                while let Some(ch) = chars.next() {
                    if ch == '\u{7}' { break; }
                    if ch == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    result
}

#[derive(Default)]
struct Metadata {
    group: Option<String>,
    choices: Option<Vec<String>>,
}

fn metadata(text: &str, settings: &Listing) -> BTreeMap<String, Metadata> {
    let text = strip_ansi(text);
    let mut result = BTreeMap::new();
    let mut group = None;
    for line in text.lines() {
        let line = line.trim_end();
        if let Some(heading) = line.strip_prefix('[').and_then(|line| line.strip_suffix(']')) {
            if !heading.is_empty() { group = Some(heading.to_string()); }
            continue;
        }
        let Some(line) = line.strip_prefix("  ") else { continue };
        let Some((key, tail)) = line.split_once(" = ") else { continue };
        let Some(setting) = settings.get(key) else { continue };
        let choices = if setting.kind == "enum" {
            // Only the final suffix is type metadata; values can contain parentheses and pipes.
            tail.rsplit_once(" (").and_then(|(_, suffix)| suffix.strip_suffix(')'))
                .filter(|suffix| suffix.contains('|'))
                .map(|suffix| suffix.split('|').map(str::to_string).collect::<Vec<_>>())
                .filter(|values| values.iter().all(|value| !value.is_empty()))
        } else { None };
        result.insert(key.to_string(), Metadata { group: group.clone(), choices });
    }
    result
}

pub async fn native_settings(options: StartOptions) -> Result<Settings, String> {
    let (effective, global) = tokio::try_join!(list(&options, false), list(&options, true))?;
    // Human output contributes metadata only. Format drift or an unavailable human listing
    // must not hide settings already returned by the authoritative JSON list.
    let human = execute(&options, &["config", "list"], false).await.unwrap_or_default();
    let mut metadata = metadata(&String::from_utf8_lossy(&human), &effective);
    let entries = effective.into_iter().map(|(key, setting)| {
        let meta = metadata.remove(&key).unwrap_or_default();
        let stored = global.get(&key).map(visible_fields);
        let fields = visible_fields(&setting);
        let group = meta.group.unwrap_or_else(|| key.split('.').next().unwrap_or("other").to_string());
        (key, SettingEntry { kind: setting.kind, description: setting.description,
            fields, group, choices: meta.choices, stored })
    }).collect();
    Ok(Settings { entries })
}

fn finite_number(text: &str) -> bool {
    if text.is_empty() { return false; }
    if let Ok(number) = text.parse::<f64>() {
        return number.is_finite();
    }
    // Match Number(text)'s unsigned radix literals without narrowing native CLI syntax.
    let (digits, radix) = if let Some(digits) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        (digits, 16)
    } else if let Some(digits) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        (digits, 8)
    } else if let Some(digits) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        (digits, 2)
    } else {
        return false;
    };
    if digits.is_empty() { return false; }
    let mut number = 0.0_f64;
    for digit in digits.chars() {
        let Some(digit) = digit.to_digit(radix) else { return false };
        number = number * f64::from(radix) + f64::from(digit);
    }
    number.is_finite()
}

fn validate_value(setting: &RawSetting, value: &str) -> Result<(), String> {
    let text = value.trim();
    let valid = match setting.kind.as_str() {
        "boolean" => matches!(text.to_ascii_lowercase().as_str(), "true" | "false" | "1" | "0" | "yes" | "no" | "on" | "off"),
        "number" => finite_number(text),
        "array" => serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_array()),
        "record" => serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_object()),
        "string" | "enum" => true,
        _ => return Err("This native setting has an unsupported value type".into()),
    };
    if valid { Ok(()) } else {
        Err(match setting.kind.as_str() {
            "boolean" => "Enter a boolean: true/false, yes/no, on/off, or 1/0",
            "number" => "Enter a finite number; use Reset to remove the global value",
            "array" => "Enter a valid JSON array",
            "record" => "Enter a valid JSON object",
            _ => "Enter a value matching the native setting type",
        }.into())
    }
}

pub async fn native_setting_write(
    options: StartOptions,
    key: String,
    value: Option<String>,
    reset: bool,
) -> Result<WriteResult, String> {
    let _guard = WRITE_LOCK.lock().await;
    let settings = list(&options, false).await?;
    let setting = settings.get(&key).ok_or("Unknown native setting; reload the settings list")?;
    let mut args = vec!["config", if reset { "reset" } else { "set" }, "--json", "--", key.as_str()];
    if !reset {
        let value = value.as_deref().ok_or("A value is required; use Reset to remove the global value")?;
        validate_value(setting, value)?;
        // The active native CLI uses positional args after `--`: even empty strings,
        // negative numbers and strings starting with -- remain one literal argv value.
        args.push(value);
    }
    let bytes = execute(&options, &args, true).await?;
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Native settings write returned invalid JSON; reload to check the saved value".to_string())?;
    if !response.is_object() {
        return Err("Native settings write returned an invalid response; reload to check the saved value".into());
    }
    // In particular, never return the native set response's plaintext `value`.
    // Only allow provenance labels, not arbitrary CLI strings that could contain values.
    let label = |name: &str| response.get(name).and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128
            && value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_'))
        .map(str::to_string);
    Ok(WriteResult { overridden_by: label("overriddenBy"), fallback_env: label("fallbackEnv") })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listing() -> Listing {
        serde_json::from_value(serde_json::json!({
            "mode": {"type": "enum", "description": "", "value": "a (not|choices)"},
            "text": {"type": "string", "description": "", "value": "x"},
            "items": {"type": "array", "description": ""},
            "token": {"type": "string", "description": "", "redacted": true, "value": "must not escape"}
        })).unwrap()
    }

    #[test]
    fn metadata_uses_known_keys_and_final_enum_suffix() {
        let values = listing();
        let parsed = metadata("\u{1b}[34m[native]\u{1b}[0m\r\n  mode = a (not|choices) (a|b)\r\n  text = x (fake|choices)\n  unknown = x (a|b)", &values);
        assert_eq!(parsed["mode"].group.as_deref(), Some("native"));
        assert_eq!(parsed["mode"].choices, Some(vec!["a".into(), "b".into()]));
        assert!(parsed["text"].choices.is_none());
        assert!(!parsed.contains_key("unknown"));
        assert!(metadata("  mode = format drift", &values)["mode"].choices.is_none());
    }

    #[test]
    fn redaction_wins_over_value_and_structured_types_are_checked() {
        let values = listing();
        assert_eq!(visible_fields(&values["token"]), serde_json::from_value::<Map<String, Value>>(serde_json::json!({"redacted": true})).unwrap());
        assert!(validate_value(&values["items"], "[]").is_ok());
        assert!(validate_value(&values["items"], "{}").is_err());
        assert!(validate_value(&values["text"], "").is_ok());
        assert!(validate_value(&values["text"], "--json").is_ok());
    }

    #[test]
    fn numbers_match_finite_native_spellings() {
        for number in ["-1.5", ".5", "1e3", "0xff", "0o17", "0b10"] {
            assert!(finite_number(number));
        }
        for number in ["", "NaN", "Infinity", "1e999", "-0xff", "[]", "1_000"] {
            assert!(!finite_number(number));
        }
    }
}
