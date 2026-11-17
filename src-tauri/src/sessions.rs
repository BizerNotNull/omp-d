//! Discovery of on-disk omp sessions for the workspace picker.
//!
//! Layout: `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`.
//! Each file starts with a fixed-width title slot followed by a session header.

use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

const SESSION_READ_BYTES: u64 = 32 * 1024;
const DISCOVERY_TTL: Duration = Duration::from_secs(2);
const SUMMARY_CACHE_LIMIT: usize = 4096;

type Discovery = (PathBuf, Vec<SessionDirectory>);
type DiscoverySlot = Arc<tokio::sync::Mutex<Option<(Instant, Discovery)>>>;

// Per-directory single-flight: unrelated projects never wait for each other's Git.
async fn cached_directories(cwd: &Path) -> Result<Discovery, String> {
    static CACHE: LazyLock<Mutex<VecDeque<(PathBuf, DiscoverySlot)>>> = LazyLock::new(Mutex::default);
    let slot = {
        let mut cache = CACHE.lock().unwrap();
        if let Some(index) = cache.iter().position(|(path, _)| path == cwd) {
            let entry = cache.remove(index).unwrap();
            let slot = entry.1.clone();
            cache.push_back(entry);
            slot
        } else {
            let slot = Arc::new(tokio::sync::Mutex::new(None));
            if cache.len() == 32 { cache.pop_front(); }
            cache.push_back((cwd.to_path_buf(), slot.clone()));
            slot
        }
    };
    let mut cached = slot.lock().await;
    if let Some((at, discovery)) = &*cached
        && at.elapsed() < DISCOVERY_TTL
    {
        return Ok(discovery.clone());
    }
    let discovery = discover_directories(cwd).await?;
    *cached = Some((Instant::now(), discovery.clone()));
    Ok(discovery)
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    size: u64,
}

impl FileStamp {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            size: metadata.len(),
        }
    }
}

#[derive(Clone)]
struct CachedSession {
    stamp: FileStamp,
    summary: Option<SessionSummary>,
    visible: bool,
    search: Option<(String, bool)>,
    accessed: Instant,
}

fn cached_summary(file: &SessionFile, query: Option<&str>) -> Option<SessionSummary> {
    static CACHE: LazyLock<Mutex<HashMap<String, CachedSession>>> = LazyLock::new(Mutex::default);
    let previous = {
        let mut cache = CACHE.lock().unwrap();
        let entry = cache.get_mut(&file.path)
            .filter(|entry| entry.stamp == file.stamp && file.stamp.modified.is_some());
        if let Some(entry) = entry {
            entry.accessed = Instant::now();
            if !entry.visible { return None; }
            match query {
                None => return entry.summary.clone(),
                Some(query) if entry.search.as_ref().is_some_and(|(previous, _)| previous == query) => {
                    return if entry.search.as_ref().is_some_and(|(_, matches)| *matches) {
                        entry.summary.clone()
                    } else { None };
                }
                _ => Some(entry.clone()),
            }
        } else {
            None
        }
    };
    let mut cached = previous.unwrap_or_else(|| {
        let summary = read_summary(Path::new(&file.path), Path::new(&file.cwd), file.modified_ms, file.size);
        let visible = summary.as_ref().is_some_and(|summary|
            summary.title.is_some() || summary.preview.is_some() || session_matches(Path::new(&file.path), ""));
        CachedSession {
            stamp: file.stamp.clone(), summary, visible, search: None, accessed: Instant::now(),
        }
    });
    let matches = cached.visible && query.is_none_or(|query| {
        if let Some((previous, matches)) = &cached.search
            && previous == query
        {
            return *matches;
        }
        let matches = session_matches(Path::new(&file.path), query);
        cached.search = Some((query.to_owned(), matches));
        matches
    });
    cached.accessed = Instant::now();
    let result = if matches { cached.summary.clone() } else { None };
    // Do not publish a snapshot read while a writer was appending or renaming.
    if std::fs::metadata(&file.path).ok().is_some_and(|metadata|
        FileStamp::from_metadata(&metadata) == file.stamp)
    {
        let mut cache = CACHE.lock().unwrap();
        if cache.len() >= SUMMARY_CACHE_LIMIT && !cache.contains_key(&file.path)
            && let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.accessed).map(|(path, _)| path.clone())
        {
            cache.remove(&oldest);
        }
        cache.insert(file.path.clone(), cached);
    }
    result
}

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
    pub sessions: Vec<SessionSummary>,
    pub next_cursor: Option<SessionCursor>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCursor {
    pub modified_ms: u64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDirectory {
    pub cwd: String,
    pub is_worktree: bool,
    pub branch: Option<String>,
}

struct Worktree {
    cwd: PathBuf,
    bare: bool,
    branch: Option<String>,
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
            current = Some(Worktree { cwd: PathBuf::from(path), bare: false, branch: None });
        } else {
            let worktree = current.as_mut().ok_or_else(invalid)?;
            if field == b"bare" {
                worktree.bare = true;
            } else if let Some(branch) = field.strip_prefix(b"branch ") {
                let branch = std::str::from_utf8(branch).map_err(|_| invalid())?;
                worktree.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_owned());
            } else if field != b"detached"
                && !field.starts_with(b"HEAD ")
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

async fn discover_directories(cwd: &Path) -> Result<(PathBuf, Vec<SessionDirectory>), String> {
    let output = tokio::time::timeout(Duration::from_secs(5), git_worktrees(cwd))
        .await
        .map_err(|_| "Git worktree discovery timed out after 5 seconds".to_string())??;
    let cwd = cwd.to_path_buf();
    tokio::task::spawn_blocking(move || directories_from_git(&cwd, output))
        .await.map_err(|error| format!("Session discovery failed: {error}"))?
}

fn directories_from_git(cwd: &Path, output: Output) -> Result<(PathBuf, Vec<SessionDirectory>), String> {
    if !output.status.success() {
        if output.status.code() == Some(128)
            && output.stderr.starts_with(b"fatal: not a git repository (or any ")
        {
            return Ok((cwd.to_path_buf(), vec![SessionDirectory {
                cwd: normalize_path(cwd), is_worktree: false, branch: None,
            }]));
        }
        return Err(format!(
            "Git worktree discovery failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let worktrees = parse_worktrees(&output.stdout)?;
    let mut directories: Vec<SessionDirectory> = Vec::with_capacity(worktrees.len() + 1);
    let mut repository = None;
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
            || directories.iter().any(|directory| same_path(&directory.cwd, &normalize_path(&path)))
        {
            return Err(format!("Invalid worktree directory {}", path.display()));
        }
        if index == 0 {
            repository = Some(path.clone());
        }
        directories.push(SessionDirectory {
            cwd: normalize_path(&path), is_worktree: index != 0, branch: worktree.branch,
        });
    }
    // Git guarantees that the main repository is the first porcelain record.
    let repository = repository.ok_or_else(|| "Git returned no repository".to_string())?;
    if !directories.iter().any(|directory| same_path(&directory.cwd, &normalize_path(cwd))) {
        let containing = directories.iter()
            .filter(|directory| Path::new(&normalize_path(cwd)).starts_with(&directory.cwd))
            .max_by_key(|directory| Path::new(&directory.cwd).components().count())
            .ok_or_else(|| "Active directory is absent from Git's worktree listing".to_string())?;
        directories.push(SessionDirectory {
            cwd: normalize_path(cwd), is_worktree: containing.is_worktree, branch: containing.branch.clone(),
        });
    }
    directories[1..].sort_by(|a, b| a.cwd.cmp(&b.cwd));
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

pub async fn list_sessions(
    cwd: &str,
    limit: usize,
    cursor: Option<SessionCursor>,
    scope: Option<String>,
    query: Option<String>,
    paths: Option<Vec<String>>,
) -> Result<SessionListing, String> {
    let cwd = cwd.to_owned();
    let resolved = tokio::task::spawn_blocking(move || {
        std::fs::canonicalize(&cwd).map_err(|error| format!("Cannot open {cwd}: {error}"))
    }).await.map_err(|error| format!("Session discovery failed: {error}"))??;
    let (repository, directories) = cached_directories(&resolved).await?;
    tokio::task::spawn_blocking(move || {
        listing_from_directories(repository, directories, &sessions_root(), limit,
            cursor.as_ref(), scope.as_deref(), query.as_deref(), paths.as_deref())
    }).await.map_err(|error| format!("Session listing failed: {error}"))?
}

fn same_path(a: &str, b: &str) -> bool {
    let a = normalize_path(Path::new(a));
    let b = normalize_path(Path::new(b));
    #[cfg(windows)]
    { a.eq_ignore_ascii_case(&b) }
    #[cfg(not(windows))]
    { a == b }
}

fn listing_from_directories(
    repository: PathBuf,
    directories: Vec<SessionDirectory>,
    root: &Path,
    limit: usize,
    cursor: Option<&SessionCursor>,
    scope: Option<&str>,
    query: Option<&str>,
    paths: Option<&[String]>,
) -> Result<SessionListing, String> {
    let query = query.map(str::trim).filter(|query| !query.is_empty()).map(str::to_lowercase);
    let mut candidates = Vec::new();
    for directory in &directories {
        if scope.is_some_and(|scope| !same_path(scope, &directory.cwd)) {
            continue;
        }
        let cwd = Path::new(&directory.cwd);
        let directory_matches = query.as_ref().is_some_and(|query| {
            directory.branch.as_ref().is_some_and(|branch| branch.to_lowercase().contains(query))
                || cwd.file_name().is_some_and(|name| name.to_string_lossy().to_lowercase().contains(query))
        });
        candidates.extend(read_bucket(&session_dir_for(cwd, root), cwd, paths)?
            .into_iter().map(|file| (file, directory_matches)));
    }
    candidates.sort_by(|(a, _), (b, _)| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.path.cmp(&b.path)));
    candidates.dedup_by(|(a, _), (b, _)| a.path == b.path);
    let limit = limit.max(1);
    let mut sessions = Vec::new();
    for (file, directory_matches) in candidates {
        if cursor.is_some_and(|cursor| file.modified_ms > cursor.modified_ms
            || (file.modified_ms == cursor.modified_ms && file.path <= cursor.path))
        {
            continue;
        }
        let Some(summary) = cached_summary(&file, query.as_deref().filter(|_| !directory_matches)) else {
            continue;
        };
        sessions.push(summary);
        if sessions.len() > limit {
            break;
        }
    }
    let has_more = sessions.len() > limit;
    sessions.truncate(limit);
    let next_cursor = if has_more {
        sessions.last().map(|session| SessionCursor {
            modified_ms: session.modified_ms, path: session.path.clone(),
        })
    } else { None };
    Ok(SessionListing { repository_cwd: normalize_path(&repository), directories, sessions, next_cursor })
}

/// Scan decoded JSON string values without retaining a line or message. A single
/// tool-result line can be gigabytes long; memory stays O(query + nesting).
fn session_matches(path: &Path, query: &str) -> bool {
    let Ok(file) = File::open(path) else { return false };
    let mut reader = BufReader::new(file);
    let pattern: Vec<char> = query.chars().collect();
    let mut fallback = vec![0; pattern.len()];
    for index in 1..pattern.len() {
        let mut matched = fallback[index - 1];
        while matched > 0 && pattern[index] != pattern[matched] {
            matched = fallback[matched - 1];
        }
        if pattern[index] == pattern[matched] {
            matched += 1;
        }
        fallback[index] = matched;
    }
    struct Frame {
        object: bool,
        expecting_key: bool,
        searchable: bool,
        message: bool,
        key: String,
    }
    let mut stack: Vec<Frame> = Vec::new();
    while let Some(byte) = next_byte(&mut reader) {
        let searchable = stack.last().is_some_and(|frame|
            (frame.searchable && frame.key != "type")
                || (stack.len() == 1 && frame.key == "title")
                || (frame.message && matches!(frame.key.as_str(), "content" | "text" | "output")));
        let message = stack.len() == 1 && stack.last().is_some_and(|frame| frame.key == "message");
        match byte {
            b'{' | b'[' => {
                if stack.len() == 128 {
                    return false;
                }
                stack.push(Frame {
                    object: byte == b'{', expecting_key: byte == b'{', searchable, message, key: String::new(),
                });
            }
            b'}' | b']' => { stack.pop(); }
            b',' => {
                if let Some(frame) = stack.last_mut() {
                    frame.expecting_key = frame.object;
                    frame.key.clear();
                }
            }
            b'"' => {
                let is_key = stack.last().is_some_and(|frame| frame.expecting_key);
                let mut key = String::new();
                let mut matched = 0;
                loop {
                    // Most session content is unescaped ASCII. Process a buffered
                    // run directly instead of decoding and refilling per byte.
                    let available = match reader.fill_buf() {
                        Ok(bytes) => bytes,
                        Err(_) => return false,
                    };
                    let length = available.iter().position(|byte|
                        !matches!(*byte, 0x20..=0x7e) || matches!(*byte, b'"' | b'\\'))
                        .unwrap_or(available.len());
                    if length > 0 {
                        if is_key {
                            for byte in &available[..length] {
                                if key.len() < 64 { key.push(*byte as char); }
                            }
                        } else if searchable {
                            for byte in &available[..length] {
                                if pattern.is_empty() {
                                    if !byte.is_ascii_whitespace() { return true; }
                                    continue;
                                }
                                let ch = byte.to_ascii_lowercase() as char;
                                while matched > 0 && ch != pattern[matched] {
                                    matched = fallback[matched - 1];
                                }
                                if ch == pattern[matched] { matched += 1; }
                                if matched == pattern.len() { return true; }
                            }
                        }
                        reader.consume(length);
                        continue;
                    }
                    let Some(byte) = next_byte(&mut reader) else { return false };
                    if byte == b'"' {
                        break;
                    }
                    let Some(ch) = json_character(&mut reader, byte) else { return false };
                    if is_key {
                        if key.len() < 64 {
                            key.push(ch);
                        }
                    } else if searchable {
                        if pattern.is_empty() {
                            if !ch.is_whitespace() {
                                return true;
                            }
                            continue;
                        }
                        for ch in ch.to_lowercase() {
                            while matched > 0 && ch != pattern[matched] {
                                matched = fallback[matched - 1];
                            }
                            if ch == pattern[matched] {
                                matched += 1;
                            }
                            if matched == pattern.len() {
                                return true;
                            }
                        }
                    }
                }
                if is_key {
                    if let Some(frame) = stack.last_mut() {
                        frame.key = key;
                        frame.expecting_key = false;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

fn next_byte(reader: &mut impl BufRead) -> Option<u8> {
    let byte = *reader.fill_buf().ok()?.first()?;
    reader.consume(1);
    Some(byte)
}

fn json_character(reader: &mut impl BufRead, byte: u8) -> Option<char> {
    if byte == b'\\' {
        return match next_byte(reader)? {
            b'"' => Some('"'),
            b'\\' => Some('\\'),
            b'/' => Some('/'),
            b'b' => Some('\u{8}'),
            b'f' => Some('\u{c}'),
            b'n' => Some('\n'),
            b'r' => Some('\r'),
            b't' => Some('\t'),
            b'u' => {
                let first = json_hex_quad(reader)?;
                let codepoint = if (0xd800..=0xdbff).contains(&first) {
                    if next_byte(reader)? != b'\\' || next_byte(reader)? != b'u' {
                        return None;
                    }
                    let second = json_hex_quad(reader)?;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return None;
                    }
                    0x10000 + ((first - 0xd800) << 10) + second - 0xdc00
                } else { first };
                char::from_u32(codepoint)
            }
            _ => None,
        };
    }
    if byte.is_ascii() {
        return Some(byte as char);
    }
    let length = match byte {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return None,
    };
    let mut bytes = [0; 4];
    bytes[0] = byte;
    for slot in &mut bytes[1..length] {
        *slot = next_byte(reader)?;
    }
    std::str::from_utf8(&bytes[..length]).ok()?.chars().next()
}

fn json_hex_quad(reader: &mut impl BufRead) -> Option<u32> {
    let mut value = 0;
    for _ in 0..4 {
        value = value * 16 + (next_byte(reader)? as char).to_digit(16)?;
    }
    Some(value)
}

struct SessionFile {
    path: String,
    cwd: String,
    modified_ms: u64,
    size: u64,
    stamp: FileStamp,
}

fn read_bucket(dir: &Path, cwd: &Path, paths: Option<&[String]>) -> Result<Vec<SessionFile>, String> {
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
        if paths.is_some_and(|paths| !paths.iter().any(|candidate| same_path(candidate, &normalize_path(&path)))) {
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
        sessions.push(SessionFile {
            path: normalize_path(&path), cwd: normalize_path(cwd), modified_ms, size: meta.len(),
            stamp: FileStamp::from_metadata(&meta),
        });
    }

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
        assert_eq!(directories.len(), 2);
        assert_eq!(directories[0].cwd, normalize_path(&main));
        assert!(!directories[0].is_worktree);
        assert!(directories[0].branch.is_some());
        assert_eq!(directories[1].cwd, normalize_path(&linked));
        assert!(directories[1].is_worktree);
        assert_eq!(directories[1].branch, None);
        assert_eq!(discover_directories(&linked).await.unwrap(), (repository.clone(), directories.clone()));

        let root = temp.0.join("sessions");
        write_session(&root, &main, "main", Some("Main session"));
        write_session(&root, &main, "hidden", None);
        write_session(&root, &linked, "linked-one", Some("Linked one"));
        write_session(&root, &linked, "linked-two", Some("Linked two"));
        let listing = listing_from_directories(repository, directories, &root, 1, None, None, None, None).unwrap();
        assert_eq!(listing.sessions.len(), 1);
        assert_eq!(listing.directories.len(), 2);
        assert!(listing.next_cursor.is_some());

        for (checkout, is_worktree) in [(&main, false), (&linked, true)] {
            let subdir = checkout.join("nested");
            std::fs::create_dir(&subdir).unwrap();
            let (repository, directories) = discover_directories(&subdir).await.unwrap();
            assert_eq!(repository, main);
            assert!(directories.iter().any(|directory|
                directory.cwd == normalize_path(&subdir) && directory.is_worktree == is_worktree));
            let listing = listing_from_directories(repository, directories, &root, 40, None, None, None, None).unwrap();
            assert!(listing.directories.iter().any(|directory| directory.cwd == normalize_path(&subdir)));
            assert!(!listing.sessions.iter().any(|session| session.cwd == normalize_path(&subdir)));
        }

        // Saved buckets remain reachable after a registered checkout disappears.
        std::fs::remove_dir_all(&linked).unwrap();
        let (repository, directories) = discover_directories(&main).await.unwrap();
        assert!(directories.iter().any(|directory| directory.cwd == normalize_path(&linked) && directory.is_worktree));
        let listing = listing_from_directories(repository, directories, &root, 40, None, None, None, None).unwrap();
        assert_eq!(listing.sessions.iter().filter(|session| session.cwd == normalize_path(&linked)).count(), 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn keeps_non_git_and_bare_repository_headings() {
        let temp = TempDir::new();
        let (repository, directories) = discover_directories(&temp.0).await.unwrap();
        assert_eq!(repository, temp.0);
        assert_eq!(directories, vec![SessionDirectory {
            cwd: normalize_path(&temp.0), is_worktree: false, branch: None,
        }]);
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
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert_eq!(trees[1].branch, None);
        assert!(parse_worktrees(b"worktree /repo\0HEAD abc\0").is_err());
        assert!(parse_worktrees(b"HEAD abc\0\0").is_err());
        assert!(parse_worktrees(b"worktree /repo\0unknown field\0\0").is_err());
    }

    fn directory(cwd: &Path, branch: &str) -> SessionDirectory {
        SessionDirectory {
            cwd: normalize_path(cwd), is_worktree: false, branch: Some(branch.to_owned()),
        }
    }

    #[test]
    fn search_keeps_matches_across_buffer_ascii_unicode_and_escape_boundaries() {
        let temp = TempDir::new();
        let path = temp.0.join("search.jsonl");
        let prefix = "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"";
        let padding = "a".repeat(8190 - prefix.len());
        std::fs::write(&path, format!(
            "{prefix}{padding}Ab\\u0043中\\ud83d\\ude80 tail\"}}}}\n"
        )).unwrap();
        assert!(session_matches(&path, "abc中🚀 tail"));
        assert!(session_matches(&path, "aaaaabc中"));
        assert!(!session_matches(&path, "abc中🚀 absent"));
        assert!(!session_matches(&path, "content"));
    }

    #[test]
    fn cached_pages_observe_renames_appends_search_changes_and_deletions() {
        let temp = TempDir::new();
        let cwd = &temp.0;
        let root = cwd.join("sessions");
        let page = |query: Option<&str>| listing_from_directories(
            cwd.clone(), vec![directory(cwd, "main")], &root, 50, None, None, query, None,
        ).unwrap().sessions;
        write_session(&root, cwd, "test", Some("Before"));
        let path = session_dir_for(cwd, &root).join("test.jsonl");
        let timestamp = std::time::UNIX_EPOCH + Duration::from_secs(123456);
        let set_modified = |time| File::options().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(time)).unwrap();
        set_modified(timestamp + Duration::from_nanos(100));
        assert_eq!(page(None)[0].title.as_deref(), Some("Before"));
        assert_eq!(page(Some("before"))[0].session_id, "test");
        assert!(page(Some("absent")).is_empty());
        assert!(page(Some("absent")).is_empty());
        // Same-size rename within the same millisecond must invalidate the cache.
        write_session(&root, cwd, "test", Some("After!"));
        set_modified(timestamp + Duration::from_nanos(200));
        assert_eq!(page(None)[0].title.as_deref(), Some("After!"));
        assert!(page(Some("before")).is_empty());
        assert_eq!(page(Some("after!"))[0].session_id, "test");
        assert!(page(Some("appended")).is_empty());
        use std::io::Write;
        writeln!(File::options().append(true).open(&path).unwrap(),
            "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"appended\"}}}}").unwrap();
        // Size changes invalidate even if a filesystem preserves the timestamp.
        set_modified(timestamp + Duration::from_nanos(200));
        assert_eq!(page(Some("appended"))[0].preview.as_deref(), Some("appended"));
        std::fs::remove_file(path).unwrap();
        assert!(page(None).is_empty());
        write_session(&root, cwd, "hidden", None);
        assert!(page(None).is_empty());
        write_session(&root, cwd, "hidden", Some("Now visible"));
        assert_eq!(page(None)[0].title.as_deref(), Some("Now visible"));
    }

    #[test]
    fn flat_pages_cover_all_history_with_exclusive_tied_cursors() {
        let temp = TempDir::new();
        let main = temp.0.join("main");
        let linked = temp.0.join("linked");
        let root = temp.0.join("sessions");
        let directories = vec![directory(&main, "main"), directory(&linked, "feature")];
        let timestamp = std::time::UNIX_EPOCH + Duration::from_secs(123456);
        for index in 0..83 {
            let cwd = if index % 2 == 0 { &main } else { &linked };
            let id = format!("session-{index:03}");
            write_session(&root, cwd, &id, Some(&id));
            File::options().write(true).open(session_dir_for(cwd, &root).join(format!("{id}.jsonl")))
                .unwrap().set_times(std::fs::FileTimes::new().set_modified(timestamp)).unwrap();
        }
        let mut cursor = None;
        let mut seen = Vec::new();
        loop {
            let page = listing_from_directories(main.clone(), directories.clone(), &root, 7,
                cursor.as_ref(), None, None, None).unwrap();
            assert_eq!(page.directories, directories);
            assert!(page.sessions.len() <= 7);
            assert!(page.sessions.iter().all(|session| session.modified_ms == 123456000));
            seen.extend(page.sessions.into_iter().map(|session| session.path));
            cursor = page.next_cursor;
            if cursor.is_none() { break; }
        }
        assert_eq!(seen.len(), 83);
        assert!(seen.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn filters_precede_pages_and_search_streams_late_decoded_message_text() {
        let temp = TempDir::new();
        let main = temp.0.join("checkout");
        let linked = temp.0.join("linked-name");
        let root = temp.0.join("sessions");
        let directories = vec![directory(&main, "main"), directory(&linked, "topic/needle")];
        for index in 0..61 {
            let id = format!("new-{index:03}");
            write_session(&root, &main, &id, Some("Recent"));
        }
        write_session(&root, &main, "old", None);
        let old = session_dir_for(&main, &root).join("old.jsonl");
        let mut file = File::options().append(true).open(&old).unwrap();
        use std::io::Write;
        write!(file, "{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}Late \\u4e2d\\u6587 \\ud83d\\ude80 needle\"}}]}}}}\n",
            "padding".repeat(20000)).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1))).unwrap();
        write_session(&root, &linked, "linked", Some("Linked"));

        let page = listing_from_directories(main.clone(), directories.clone(), &root, 1,
            None, Some(&normalize_path(&main)), Some("中文 🚀 NEEDLE"), None).unwrap();
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].session_id, "old");
        assert!(page.next_cursor.is_none());
        let pinned = vec![normalize_path(&old)];
        let page = listing_from_directories(main.clone(), directories.clone(), &root, 1,
            None, None, None, Some(&pinned)).unwrap();
        assert_eq!(page.sessions[0].session_id, "old");
        assert!(page.next_cursor.is_none());
        for query in ["topic/needle", "linked-name"] {
            let page = listing_from_directories(main.clone(), directories.clone(), &root, 1,
                None, None, Some(query), None).unwrap();
            assert_eq!(page.sessions[0].session_id, "linked");
        }
        assert!(listing_from_directories(main, directories, &root, 1,
            None, None, None, Some(&[])).unwrap().sessions.is_empty());
        assert!(!session_matches(&old, "never-present"));
        assert!(!session_matches(&old, "assistant"));
        assert!(!session_matches(&old, "text"));
        assert!(session_matches(&old, ""));
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
