//! Discovery of on-disk omp sessions for the workspace picker.
//!
//! Layout: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`.
//! Each file starts with a fixed-width title slot followed by a session header.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListing {
    pub repository_cwd: String,
    pub directories: Vec<SessionDirectory>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirectory {
    pub cwd: String,
    pub is_worktree: bool,
    pub sessions: Vec<SessionSummary>,
}

struct Worktree {
    cwd: PathBuf,
    bare: bool,
}

async fn git_worktrees(cwd: &Path) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.arg("--no-optional-locks");
    // Selecting a bare repository is explicit; name its git-dir so Git's
    // safe.bareRepository=explicit policy does not reject implicit discovery.
    if cwd.join("HEAD").is_file() && cwd.join("config").is_file() && !cwd.join(".git").exists() {
        command.arg("--git-dir").arg(normalize_path(cwd));
    }
    command
        .args(["worktree", "list", "--porcelain", "-z"])
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command.output().await.map_err(|error| format!("Cannot execute Git: {error}"))
}

fn parse_worktrees(bytes: &[u8]) -> Result<Vec<Worktree>, String> {
    let invalid = || "Git returned an invalid worktree listing".to_string();
    if !bytes.ends_with(&[0, 0]) {
        return Err(invalid());
    }
    let mut worktrees = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in bytes.split(|byte| *byte == 0) {
        if field.is_empty() {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
        } else if let Some(path) = field.strip_prefix(b"worktree ") {
            if current.is_some() || path.is_empty() {
                return Err(invalid());
            }
            let path = std::str::from_utf8(path).map_err(|_| invalid())?;
            current = Some(Worktree { cwd: PathBuf::from(path), bare: false });
        } else {
            let worktree = current.as_mut().ok_or_else(invalid)?;
            if field == b"bare" {
                worktree.bare = true;
            } else if field != b"detached"
                && !field.starts_with(b"HEAD ")
                && !field.starts_with(b"branch ")
                && field != b"locked"
                && !field.starts_with(b"locked ")
                && field != b"prunable"
                && !field.starts_with(b"prunable ")
            {
                return Err(invalid());
            }
        }
    }
    if worktrees.is_empty() {
        return Err(invalid());
    }
    Ok(worktrees)
}

async fn discover_directories(cwd: &Path) -> Result<(PathBuf, Vec<(PathBuf, bool)>), String> {
    let output = tokio::time::timeout(Duration::from_secs(5), git_worktrees(cwd))
        .await
        .map_err(|_| "Git worktree discovery timed out after 5 seconds".to_string())??;
    if !output.status.success() {
        if output.status.code() == Some(128)
            && output.stderr.starts_with(b"fatal: not a git repository (or any ")
        {
            return Ok((cwd.to_path_buf(), vec![(cwd.to_path_buf(), false)]));
        }
        return Err(format!(
            "Git worktree discovery failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let worktrees = parse_worktrees(&output.stdout)?;
    let mut directories = Vec::with_capacity(worktrees.len() + 1);
    for (index, worktree) in worktrees.into_iter().enumerate() {
        // Retain missing/prunable registrations and their saved session buckets;
        // discovery must never prune or silently discard the user's worktrees.
        if (index != 0 && worktree.bare) || !worktree.cwd.is_absolute() {
            return Err(format!("Invalid registered worktree {}", worktree.cwd.display()));
        }
        let path = match std::fs::canonicalize(&worktree.cwd) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Canonicalize the surviving ancestor so Windows verbatim
                // prefixes and symlinked parents match existing checkout paths.
                let ancestor = worktree.cwd.ancestors().skip(1).find(|path| path.is_dir())
                    .ok_or_else(|| format!("Cannot resolve worktree {}", worktree.cwd.display()))?;
                let parent = std::fs::canonicalize(ancestor)
                    .map_err(|error| format!("Cannot open worktree ancestor {}: {error}", ancestor.display()))?;
                parent.join(worktree.cwd.strip_prefix(ancestor)
                    .map_err(|error| format!("Cannot resolve worktree {}: {error}", worktree.cwd.display()))?)
            }
            Err(error) => return Err(format!("Cannot open worktree {}: {error}", worktree.cwd.display())),
        };
        if (path.exists() && !path.is_dir())
            || directories.iter().any(|(existing, _)| existing == &path)
        {
            return Err(format!("Invalid worktree directory {}", path.display()));
        }
        directories.push((path, index != 0));
    }
    // Git guarantees that the main repository is the first porcelain record.
    let repository = directories[0].0.clone();
    if !directories.iter().any(|(path, _)| path == cwd) {
        let containing = directories.iter()
            .filter(|(path, _)| cwd.starts_with(path))
            .max_by_key(|(path, _)| path.components().count())
            .ok_or_else(|| "Active directory is absent from Git's worktree listing".to_string())?;
        directories.push((cwd.to_path_buf(), containing.1));
    }
    directories[1..].sort_by(|a, b| a.0.cmp(&b.0));
    Ok((repository, directories))
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
        raw.to_string()
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

fn session_dir_for(cwd: &Path, root: &Path) -> PathBuf {
    let normalized = normalize_path(cwd);
    let home = normalize_path(&home_dir());
    let temp = temp_dir().map(|dir| normalize_path(&dir));
    let name = encode_session_dir(&normalized, &home, temp.as_deref());
    root.join(name)
}

pub async fn list_sessions(cwd: &str, limit: usize) -> Result<SessionListing, String> {
    let resolved = std::fs::canonicalize(cwd).map_err(|e| format!("Cannot open {cwd}: {e}"))?;
    let (repository, directories) = discover_directories(&resolved).await?;
    listing_from_directories(repository, directories, &sessions_root(), limit)
}

fn listing_from_directories(
    repository: PathBuf,
    directories: Vec<(PathBuf, bool)>,
    root: &Path,
    limit: usize,
) -> Result<SessionListing, String> {
    let directories = directories.into_iter().map(|(cwd, is_worktree)| {
        let sessions = read_bucket(&session_dir_for(&cwd, root), &cwd, limit)?;
        Ok(SessionDirectory { cwd: normalize_path(&cwd), is_worktree, sessions })
    }).collect::<Result<Vec<_>, String>>()?;
    Ok(SessionListing { repository_cwd: normalize_path(&repository), directories })
}

fn read_bucket(dir: &Path, cwd: &Path, limit: usize) -> Result<Vec<SessionSummary>, String> {
    let entries = match std::fs::read_dir(dir) {
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
        let Some(summary) = read_summary(&path, cwd, modified_ms, meta.len()) else {
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
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "omp-d-sessions-{}-{nonce}-{sequence}", std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(std::fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn fixture_git(cwd: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        command.args(args).current_dir(cwd)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let output = tokio::time::timeout(Duration::from_secs(5), command.output())
            .await.unwrap().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    fn write_session(root: &Path, cwd: &Path, id: &str, title: Option<&str>) {
        let dir = session_dir_for(cwd, root);
        std::fs::create_dir_all(&dir).unwrap();
        let header = serde_json::json!({"type":"session","id":id,"title":title});
        std::fs::write(dir.join(format!("{id}.jsonl")), format!("{header}\n")).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn groups_main_linked_and_subdirectories_with_isolated_buckets() {
        let temp = TempDir::new();
        let main = temp.0.join("main repository");
        let linked = temp.0.join("linked detached");
        std::fs::create_dir(&main).unwrap();
        fixture_git(&main, &["init"]).await;
        fixture_git(&main, &[
            "-c", "user.name=Session Test", "-c", "user.email=session@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture",
        ]).await;
        fixture_git(&main, &["worktree", "add", "--detach", &normalize_path(&linked)]).await;
        let main = std::fs::canonicalize(main).unwrap();
        let linked = std::fs::canonicalize(linked).unwrap();
        let (repository, directories) = discover_directories(&main).await.unwrap();
        assert_eq!(repository, main);
        assert_eq!(directories, vec![(main.clone(), false), (linked.clone(), true)]);
        assert_eq!(discover_directories(&linked).await.unwrap(), (repository.clone(), directories.clone()));

        let root = temp.0.join("sessions");
        write_session(&root, &main, "main", Some("Main session"));
        write_session(&root, &main, "hidden", None);
        write_session(&root, &linked, "linked-one", Some("Linked one"));
        write_session(&root, &linked, "linked-two", Some("Linked two"));
        let listing = listing_from_directories(repository, directories, &root, 1).unwrap();
        assert_eq!(listing.directories[0].sessions.len(), 1);
        assert_eq!(listing.directories[0].sessions[0].session_id, "main");
        assert_eq!(listing.directories[1].sessions.len(), 1);
        assert!(listing.directories[1].sessions[0].session_id.starts_with("linked-"));

        for (checkout, is_worktree) in [(&main, false), (&linked, true)] {
            let subdir = checkout.join("nested");
            std::fs::create_dir(&subdir).unwrap();
            let (repository, directories) = discover_directories(&subdir).await.unwrap();
            assert_eq!(repository, main);
            assert!(directories.contains(&(subdir.clone(), is_worktree)));
            let listing = listing_from_directories(repository, directories, &root, 40).unwrap();
            assert!(listing.directories.iter().find(|dir| dir.cwd == normalize_path(&subdir))
                .unwrap().sessions.is_empty());
        }

        // Saved buckets remain reachable after a registered checkout disappears.
        std::fs::remove_dir_all(&linked).unwrap();
        let (repository, directories) = discover_directories(&main).await.unwrap();
        assert!(directories.contains(&(linked.clone(), true)));
        let listing = listing_from_directories(repository, directories, &root, 40).unwrap();
        assert_eq!(listing.directories.iter().find(|dir| dir.is_worktree).unwrap().sessions.len(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn keeps_non_git_and_bare_repository_headings() {
        let temp = TempDir::new();
        let (repository, directories) = discover_directories(&temp.0).await.unwrap();
        assert_eq!(repository, temp.0);
        assert_eq!(directories, vec![(temp.0.clone(), false)]);
        fixture_git(&temp.0, &["init", "--bare"]).await;
        assert_eq!(discover_directories(&temp.0).await.unwrap(), (repository, directories));
    }

    #[test]
    fn parses_nul_delimited_paths_and_rejects_incomplete_listing() {
        let trees = parse_worktrees(
            b"worktree /repo with\nnewline\0HEAD abc\0branch refs/heads/main\0\0\
              worktree /linked\0HEAD abc\0detached\0locked reason\nhere\0prunable stale\0\0"
        ).unwrap();
        assert_eq!(trees.len(), 2);
        assert_eq!(trees[0].cwd, PathBuf::from("/repo with\nnewline"));
        assert!(!trees[1].bare);
        assert!(parse_worktrees(b"worktree /repo\0HEAD abc\0").is_err());
        assert!(parse_worktrees(b"HEAD abc\0\0").is_err());
        assert!(parse_worktrees(b"worktree /repo\0unknown field\0\0").is_err());
    }


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
        let temp = TempDir::new();
        let dir = &temp.0;
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
    }
}
