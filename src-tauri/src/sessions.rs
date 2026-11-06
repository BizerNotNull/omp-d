//! Discovery of on-disk omp sessions for the workspace picker.
//!
//! Layout: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`.
//! Each file starts with a fixed-width title slot followed by a session header.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

const SESSION_READ_BYTES: u64 = 32 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub path: String,
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub preview: Option<String>,
    pub modified_ms: u64,
    pub size: u64,
}

/// `~/.omp/agent/sessions` (honors `PI_CODING_AGENT_DIR`).
pub fn sessions_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        let dir = PathBuf::from(dir);
        return dir.join("sessions");
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".omp").join("agent").join("sessions")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn temp_dir() -> Option<PathBuf> {
    std::env::var_os("TEMP")
        .or_else(|| std::env::var_os("TMP"))
        .map(PathBuf::from)
}

/// Strip the Windows `\\?\` verbatim prefix and normalize separators to `\`.
fn normalize_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    #[cfg(windows)]
    {
        raw.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        raw.replace('\\', "/")
    }
}

fn strip_prefix_ci<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    if prefix.is_empty() {
        return None;
    }
    let head = path.get(..prefix.len())?;
    #[cfg(windows)]
    let matches = head.eq_ignore_ascii_case(prefix);
    #[cfg(not(windows))]
    let matches = head == prefix;
    if !matches {
        return None;
    }
    let rest = &path[prefix.len()..];
    if rest.is_empty() || rest.starts_with('\\') || rest.starts_with('/') {
        Some(rest.trim_start_matches(['\\', '/']))
    } else {
        None
    }
}

fn encode_relative(prefix: &str, relative: &str) -> String {
    let encoded = relative.replace(['/', '\\', ':'], "-");
    if encoded.is_empty() {
        prefix.to_string()
    } else if prefix.ends_with('-') {
        format!("{prefix}{encoded}")
    } else {
        format!("{prefix}-{encoded}")
    }
}

fn encode_absolute(cwd: &str) -> String {
    // The reference encoder removes exactly one leading separator, which keeps
    // UNC paths distinct from local drive paths.
    let trimmed = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    format!("--{}--", trimmed.replace(['/', '\\', ':'], "-"))
}

/// Session bucket name for a cwd (see session-paths.ts).
pub fn encode_session_dir(cwd: &str, home: &str, temp: Option<&str>) -> String {
    if let Some(temp) = temp
        && let Some(relative) = strip_prefix_ci(cwd, temp)
    {
        return encode_relative("-tmp", relative);
    }
    if let Some(relative) = strip_prefix_ci(cwd, home) {
        return encode_relative("-", relative);
    }
    encode_absolute(cwd)
}

pub fn session_dir_for(cwd: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let normalized = normalize_path(&canonical);
    let home = normalize_path(&home_dir());
    let temp = temp_dir().map(|dir| normalize_path(&dir));
    let name = encode_session_dir(&normalized, &home, temp.as_deref());
    sessions_root().join(name)
}

pub fn list_sessions(cwd: &str, limit: usize) -> Result<Vec<SessionSummary>, String> {
    let resolved = std::fs::canonicalize(cwd).map_err(|e| format!("Cannot open {cwd}: {e}"))?;
    let dir = session_dir_for(&resolved);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot read {}: {error}", dir.display())),
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let Some(summary) = read_summary(&path, &resolved, modified_ms, meta.len()) else {
            continue;
        };
        // Match the picker: hide untitled, prompt-less sessions opened but never used.
        if summary.title.is_none() && summary.preview.is_none() {
            continue;
        }
        sessions.push(summary);
    }

    sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    sessions.truncate(limit);
    Ok(sessions)
}

fn read_summary(path: &Path, cwd: &Path, modified_ms: u64, size: u64) -> Option<SessionSummary> {
    let mut buf = Vec::new();
    let mut file = File::open(path).ok()?;
    let mut reader = (&mut file).take(SESSION_READ_BYTES);
    reader.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    let mut title: Option<String> = None;
    let mut header_title: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut session_cwd: Option<String> = None;
    let mut preview: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("title") => {
                if let Some(t) = value.get("title").and_then(Value::as_str) {
                    let label = clean_label(t);
                    if !label.is_empty() {
                        title = Some(label);
                    }
                }
            }
            Some("session") => {
                session_id = value.get("id").and_then(Value::as_str).map(str::to_string);
                session_cwd = value.get("cwd").and_then(Value::as_str).map(str::to_string);
                header_title = value
                    .get("title")
                    .and_then(Value::as_str)
                    .map(clean_label)
                    .filter(|label| !label.is_empty());
            }
            Some("message") if preview.is_none() => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                if message.get("role").and_then(Value::as_str) != Some("user") {
                    continue;
                }
                if message.get("synthetic").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(text) = content_text(message.get("content")) {
                    let cleaned = clean_label(&text);
                    if !cleaned.is_empty() {
                        preview = Some(cleaned);
                    }
                }
            }
            _ => {}
        }
        if session_id.is_some() && preview.is_some() {
            break;
        }
    }

    let session_id = session_id?;
    let display_title = title.or(header_title);
    Some(SessionSummary {
        path: normalize_path(path),
        session_id,
        cwd: session_cwd.unwrap_or_else(|| normalize_path(cwd)),
        title: display_title,
        preview,
        modified_ms,
        size,
    })
}

fn content_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let joined: String = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.trim().is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn clean_label(text: &str) -> String {
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let mut cleaned = String::new();
    for ch in first_line.chars().take(200) {
        if ch.is_control() {
            continue;
        }
        cleaned.push(ch);
    }
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_absolute_bucket_like_omp() {
        // Observed on disk: D:\代码D\omp-d -> --D--代码D-omp-d--
        let name = encode_session_dir(
            r"D:\代码D\omp-d",
            r"C:\Users\someone",
            Some(r"C:\Users\someone\AppData\Local\Temp"),
        );
        assert_eq!(name, "--D--代码D-omp-d--");
    }

    #[test]
    fn encodes_unc_absolute_bucket_with_single_leading_separator() {
        let name = encode_session_dir(r"\\server\share\project", r"C:\Users\someone", None);
        assert_eq!(name, "---server-share-project--");
    }

    #[test]
    fn encodes_home_relative_bucket() {
        let name = encode_session_dir(
            r"C:\Users\someone\src\app",
            r"C:\Users\someone",
            Some(r"C:\Users\someone\AppData\Local\Temp"),
        );
        assert_eq!(name, "-src-app");
    }

    #[test]
    fn encodes_temp_relative_bucket() {
        let name = encode_session_dir(
            r"C:\Users\someone\AppData\Local\Temp\scratch",
            r"C:\Users\someone",
            Some(r"C:\Users\someone\AppData\Local\Temp"),
        );
        assert_eq!(name, "-tmp-scratch");
    }

    #[test]
    fn parses_title_and_preview() {
        let dir = std::env::temp_dir().join(format!("omp-d-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-01-01_test.jsonl");
        let slot =
            serde_json::json!({"type":"title","v":1,"title":"Fix the parser","source":"auto"});
        let header = serde_json::json!({"type":"session","version":3,"id":"abc","cwd":"D:\\work","timestamp":"2026-01-01T00:00:00Z"});
        let message = serde_json::json!({"type":"message","message":{"role":"user","content":[{"type":"text","text":"Why is the parser slow?"}],"timestamp":1}});
        std::fs::write(&path, format!("{slot}\n{header}\n{message}\n")).unwrap();

        let summary = read_summary(&path, &dir, 1, 3).expect("summary");
        assert_eq!(summary.title.as_deref(), Some("Fix the parser"));
        assert_eq!(summary.preview.as_deref(), Some("Why is the parser slow?"));
        assert_eq!(summary.session_id, "abc");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
