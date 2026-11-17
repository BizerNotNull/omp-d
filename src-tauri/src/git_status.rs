//! Read-only workspace status. File counts cover the whole repository, including
//! individual untracked files (not directories); conflicts are counted separately
//! from staged/unstaged files, which may otherwise overlap. Line totals are Git's
//! tracked worktree-versus-HEAD numstat (empty tree on unborn branches), so staged
//! and unstaged edits that cancel contribute nothing. Untracked and binary file
//! contents contribute no lines; renames use Git's configured rename detection.

use std::collections::{BTreeMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub staged: u64,
    pub unstaged: u64,
    pub untracked: u64,
    pub conflicted: u64,
    pub additions: u64,
    pub deletions: u64,
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|error| format!("Cannot execute Git: {error}"))?;
    let stdout = child.stdout.take().ok_or("Git stdout is unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr is unavailable")?;
    async fn read(reader: impl tokio::io::AsyncRead + Unpin, limit: u64) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        reader.take(limit + 1).read_to_end(&mut bytes).await.map_err(|error| error.to_string())?;
        if bytes.len() as u64 > limit {
            return Err("Git output exceeds the size limit".to_string());
        }
        Ok(bytes)
    }
    let (stdout, stderr, status) = tokio::try_join!(
        read(stdout, 4 * 1024 * 1024),
        read(stderr, 64 * 1024),
        async { child.wait().await.map_err(|error| error.to_string()) },
    )?;
    Ok(Output { status, stdout, stderr })
}

fn process_error(output: &Output) -> String {
    format!("Git exited unsuccessfully ({}): {}", output.status, String::from_utf8_lossy(&output.stderr).trim())
}

const SNAPSHOT_TTL: Duration = Duration::from_secs(1);
type SnapshotSlot = Arc<tokio::sync::Mutex<Option<(Instant, Option<Arc<Snapshot>>)>>>;

struct Snapshot {
    root: PathBuf,
    base: String,
    status: GitStatus,
    files: Vec<GitChangedFile>,
    changes: tokio::sync::OnceCell<GitChanges>,
}

// Share both in-flight and recently completed scans across sessions and UI panels.
// Do not cache failures or hold a global lock across filesystem/process work.
async fn snapshot(cwd: &Path) -> Result<Option<Arc<Snapshot>>, String> {
    static CACHE: LazyLock<Mutex<VecDeque<(PathBuf, SnapshotSlot)>>> = LazyLock::new(Mutex::default);
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
    if let Some((at, value)) = &*cached
        && at.elapsed() < SNAPSHOT_TTL
    {
        return Ok(value.clone());
    }
    let value = query(cwd).await?.map(Arc::new);
    *cached = Some((Instant::now(), value.clone()));
    Ok(value)
}

pub async fn status(cwd: String) -> Result<Option<GitStatus>, String> {
    tokio::time::timeout(Duration::from_secs(5), snapshot(Path::new(&cwd)))
        .await
        .map_err(|_| "Git status timed out after 5 seconds".to_string())?
        .map(|value| value.map(|value| value.status.clone()))
}

fn parse_status(bytes: &[u8]) -> Result<(GitStatus, bool), String> {
    let mut status = GitStatus::default();
    let mut head = None;
    let mut oid = None;
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() && records.peek().is_none() {
            break;
        }
        if let Some(value) = record.strip_prefix(b"# branch.head ") {
            head = Some(value);
        } else if let Some(value) = record.strip_prefix(b"# branch.oid ") {
            oid = Some(value);
        } else if record.starts_with(b"# ") || record.starts_with(b"! ") {
            continue;
        } else if record.starts_with(b"? ") {
            status.untracked += 1;
        } else if record.starts_with(b"u ") {
            if record.splitn(11, |byte| *byte == b' ').count() != 11 {
                return Err("Git returned an invalid conflict record".into());
            }
            status.conflicted += 1;
        } else if record.starts_with(b"1 ") || record.starts_with(b"2 ") {
            let renamed = record[0] == b'2';
            let mut fields = record.splitn(if renamed { 10 } else { 9 }, |byte| *byte == b' ');
            fields.next();
            let xy = fields.next().filter(|xy| xy.len() == 2)
                .ok_or_else(|| "Git returned an invalid status record".to_string())?;
            if fields.count() != if renamed { 8 } else { 7 } {
                return Err("Git returned an invalid status record".into());
            }
            status.staged += u64::from(xy[0] != b'.');
            status.unstaged += u64::from(xy[1] != b'.');
            if renamed && records.next().filter(|path| !path.is_empty()).is_none() {
                return Err("Git returned an incomplete rename record".into());
            }
        } else {
            return Err("Git returned an unrecognized status record".into());
        }
    }
    let head = head.ok_or_else(|| "Git returned no branch header".to_string())?;
    let oid = oid.ok_or_else(|| "Git returned no commit header".to_string())?;
    status.branch = if head == b"(detached)" {
        format!("detached {}", String::from_utf8_lossy(&oid[..oid.len().min(7)]))
    } else {
        String::from_utf8_lossy(head).into_owned()
    };
    Ok((status, oid == b"(initial)"))
}

fn parse_numstat(bytes: &[u8]) -> Result<(u64, u64), String> {
    let mut additions = 0_u64;
    let mut deletions = 0_u64;
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() && records.peek().is_none() {
            break;
        }
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let added = fields.next().unwrap_or_default();
        let deleted = fields.next().ok_or_else(|| "Git returned invalid numstat".to_string())?;
        let path = fields.next().ok_or_else(|| "Git returned invalid numstat".to_string())?;
        if path.is_empty() {
            // With -z a rename has an empty path field, then two NUL paths.
            for _ in 0..2 {
                if records.next().filter(|path| !path.is_empty()).is_none() {
                    return Err("Git returned an incomplete numstat rename".into());
                }
            }
        }
        if added == b"-" && deleted == b"-" {
            continue;
        }
        let parse = |value: &[u8]| {
            std::str::from_utf8(value).ok().and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| "Git returned invalid numstat counts".to_string())
        };
        additions = additions.checked_add(parse(added)?).ok_or_else(|| "Git additions overflowed".to_string())?;
        deletions = deletions.checked_add(parse(deleted)?).ok_or_else(|| "Git deletions overflowed".to_string())?;
    }
    Ok((additions, deletions))
}

const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct GitChanges {
    pub root: String,
    pub files: Vec<GitChangedFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    #[serde(skip)]
    source: Option<String>,
}

/// Net tracked HEAD-to-worktree changes plus individual untracked files.
/// Unknown/binary/oversize line totals are null; conflicts always have null totals.
pub async fn changes(cwd: String) -> Result<Option<GitChanges>, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let Some(snapshot) = snapshot(Path::new(&cwd)).await? else { return Ok(None) };
        let changes = snapshot.changes.get_or_try_init(|| enrich_changes(&snapshot)).await?;
        Ok(Some(changes.clone()))
    }).await.map_err(|_| "Git changes timed out after 10 seconds".to_string())?
}

/// Returns Git's patch, including its explicit binary marker, for an exact listed
/// destination path. Rename patches include both source and destination.
pub async fn diff(cwd: String, path: String) -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        validate_path(&path)?;
        let snapshot = snapshot(Path::new(&cwd)).await?.ok_or("Not a Git repository")?;
        let root = &snapshot.root;
        let base = &snapshot.base;
        let file = snapshot.files.iter().find(|file| file.path == path)
            .ok_or("The requested path is not in the changed-file list")?;
        check_file(&root, &path)?;
        if let Some(source) = &file.source {
            check_file(&root, source)?;
        }
        let output = if file.status == "untracked" {
            untracked_git(&root, &path, false).await?
        } else {
            let mut args = vec!["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv",
                "--no-relative", "--no-color", "--find-renames", &base, "--"];
            if let Some(source) = &file.source {
                args.push(source);
            }
            args.push(&path);
            let output = git(&root, &args).await?;
            if !output.status.success() {
                return Err(process_error(&output));
            }
            output
        };
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }).await.map_err(|_| "Git diff timed out after 10 seconds".to_string())?
}

fn validate_path(path: &str) -> Result<(), String> {
    // Git emits repository-relative slash paths, not OS absolute paths or pathspecs.
    if path.is_empty() || path.contains('\0') || path.starts_with('/')
        || path.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(path).components().any(|part| !matches!(part, Component::Normal(_)))
        || cfg!(windows) && (path.contains('\\') || path.contains(':'))
    {
        return Err("Invalid repository-relative Git path".into());
    }
    Ok(())
}

fn git_path(bytes: &[u8]) -> Result<String, String> {
    let path = std::str::from_utf8(bytes).map_err(|_| "Git path is not valid UTF-8")?;
    validate_path(path)?;
    Ok(path.to_string())
}

fn check_file(root: &Path, path: &str) -> Result<Option<u64>, String> {
    validate_path(path)?;
    let full = root.join(path);
    // A changed entry is not permission to follow a directory symlink outside the repo.
    let parent = full.parent().ok_or("Git path has no parent")?;
    match parent.canonicalize() {
        Ok(parent) if !parent.starts_with(root) => return Err("Git path escapes the repository".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        _ => {}
    }
    match std::fs::symlink_metadata(full) {
        Ok(metadata) => {
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                return Err("Git diff only supports files and symbolic links".into());
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err("Git file exceeds the 1 MiB size limit".into());
            }
            Ok(Some(metadata.len()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

async fn untracked_git(root: &Path, path: &str, numstat: bool) -> Result<Output, String> {
    let mut args = vec!["--literal-pathspecs", "diff", "--no-index", "--no-ext-diff",
        "--no-textconv", "--no-color"];
    if numstat {
        args.extend(["--numstat", "-z"]);
    }
    args.extend(["--", "/dev/null", path]);
    let output = git(root, &args).await?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(process_error(&output));
    }
    Ok(output)
}

async fn query(cwd: &Path) -> Result<Option<Snapshot>, String> {
    let (output, root_output) = tokio::try_join!(
        git(cwd, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
        git(cwd, &["rev-parse", "--show-toplevel"]),
    )?;
    if !output.status.success() {
        if output.status.code() == Some(128)
            && output.stderr.starts_with(b"fatal: not a git repository (or any ")
        {
            return Ok(None);
        }
        return Err(process_error(&output));
    }
    let (mut status, unborn) = parse_status(&output.stdout)?;
    let status_bytes = output.stdout;
    let output = root_output;
    if !output.status.success() {
        return Err(process_error(&output));
    }
    let root_text = std::str::from_utf8(&output.stdout).map_err(|_| "Git root is not valid UTF-8")?;
    let root_text = root_text.strip_suffix('\n').ok_or("Git returned an invalid repository root")?;
    let root_text = if cfg!(windows) { root_text.strip_suffix('\r').unwrap_or(root_text) } else { root_text };
    let root = Path::new(root_text).canonicalize().map_err(|error| error.to_string())?;
    let base = if unborn {
        let output = git(&root, &["hash-object", "-t", "tree", "--stdin"]).await?;
        if !output.status.success() {
            return Err(process_error(&output));
        }
        let id = String::from_utf8(output.stdout).map_err(|_| "Invalid Git empty tree ID")?;
        let id = id.trim();
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid Git empty tree ID".into());
        }
        id.to_string()
    } else {
        "HEAD".to_string()
    };
    // --raw and --numstat share the same tree walk and rename detection.
    let output = git(&root, &["diff", "--raw", "--numstat", "-z", "--no-relative",
        "--no-ext-diff", "--no-textconv", "--find-renames", &base, "--"]).await?;
    if !output.status.success() {
        return Err(process_error(&output));
    }
    let mut files = parse_tracked_changes(&output.stdout)?;
    (status.additions, status.deletions) = files.values().try_fold((0_u64, 0_u64), |(added, deleted), file| {
        Ok::<_, String>((
            added.checked_add(file.additions.unwrap_or(0)).ok_or("Git additions overflowed")?,
            deleted.checked_add(file.deletions.unwrap_or(0)).ok_or("Git deletions overflowed")?,
        ))
    })?;
    // Porcelain v2 paths are always repository-root relative, even from a nested cwd.
    let output = status_bytes;
    let mut records = output.split(|byte| *byte == 0);
    while let Some(record) = records.next() {
        if record.starts_with(b"2 ") {
            records.next();
        } else if let Some(path) = record.strip_prefix(b"? ") {
            let path = git_path(path)?;
            let file = GitChangedFile { path: path.clone(), status: "untracked".into(),
                additions: None, deletions: None, source: None };
            files.insert(path, file);
        } else if record.starts_with(b"u ") {
            let path = record.splitn(11, |byte| *byte == b' ').nth(10)
                .ok_or("Invalid Git conflict path")?;
            let path = git_path(path)?;
            let file = files.entry(path.clone()).or_insert(GitChangedFile {
                path, status: "conflicted".into(), additions: None, deletions: None, source: None,
            });
            file.status = "conflicted".into();
            file.additions = None;
            file.deletions = None;
        }
    }
    Ok(Some(Snapshot { root, base, status, files: files.into_values().collect(),
        changes: tokio::sync::OnceCell::new() }))
}

async fn enrich_changes(snapshot: &Snapshot) -> Result<GitChanges, String> {
    let mut files = snapshot.files.clone();
    let mut pending = snapshot.files.iter().enumerate().filter(|(_, file)| file.status == "untracked");
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        while tasks.len() < 4 {
            let Some((index, file)) = pending.next() else { break };
            let root = snapshot.root.clone();
            let path = file.path.clone();
            tasks.spawn(async move {
                if !matches!(check_file(&root, &path), Ok(Some(_))) {
                    return Ok::<_, String>((index, None));
                }
                let output = untracked_git(&root, &path, true).await?;
                let counts = if output.stdout.starts_with(b"-\t-\t") {
                    None
                } else {
                    Some(parse_numstat(&output.stdout)?)
                };
                Ok((index, counts))
            });
        }
        let Some(result) = tasks.join_next().await else { break };
        let (index, counts) = result.map_err(|error| error.to_string())??;
        if let Some((added, deleted)) = counts {
            files[index].additions = Some(added);
            files[index].deletions = Some(deleted);
        }
    }
    let root = snapshot.root.to_string_lossy().into_owned();
    #[cfg(windows)]
    let root = if let Some(path) = root.strip_prefix(r"\\?\UNC\") {
        format!("//{}", path.replace('\\', "/"))
    } else {
        root.strip_prefix(r"\\?\").unwrap_or(&root).replace('\\', "/")
    };
    Ok(GitChanges { root, files })
}

fn parse_tracked_changes(mut bytes: &[u8]) -> Result<BTreeMap<String, GitChangedFile>, String> {
    fn record<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], String> {
        let end = bytes.iter().position(|byte| *byte == 0).ok_or("Incomplete Git diff record")?;
        let value = &bytes[..end];
        *bytes = &bytes[end + 1..];
        Ok(value)
    }
    let mut files = BTreeMap::new();
    while bytes.starts_with(b":") {
        let header = record(&mut bytes)?;
        let status = header.rsplit(|byte| *byte == b' ').next().ok_or("Missing Git change status")?;
        let kind = match status.first() {
            Some(b'A') => "added", Some(b'D') => "deleted", Some(b'M') => "modified",
            Some(b'R') => "renamed", Some(b'C') => "copied", Some(b'T') => "typechanged",
            Some(b'U') => "conflicted", _ => return Err("Invalid Git change status".into()),
        };
        let first = git_path(record(&mut bytes)?)?;
        let (path, source) = if kind == "renamed" || kind == "copied" {
            (git_path(record(&mut bytes)?)?, Some(first))
        } else {
            (first, None)
        };
        files.insert(path.clone(), GitChangedFile { path, status: kind.into(),
            additions: None, deletions: None, source });
    }
    apply_file_counts(&mut files, bytes)?;
    Ok(files)
}

fn apply_file_counts(files: &mut BTreeMap<String, GitChangedFile>, bytes: &[u8]) -> Result<(), String> {
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() && records.peek().is_none() {
            break;
        }
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        let added = fields.next().unwrap_or_default();
        let deleted = fields.next().ok_or("Invalid Git file counts")?;
        let path = fields.next().ok_or("Missing Git numstat path")?;
        let path = if path.is_empty() {
            git_path(records.next().ok_or("Missing Git rename source")?)?;
            git_path(records.next().ok_or("Missing Git rename destination")?)?
        } else {
            git_path(path)?
        };
        let count = |value: &[u8]| -> Result<Option<u64>, String> {
            if value == b"-" { return Ok(None); }
            Ok(Some(std::str::from_utf8(value).ok().and_then(|value| value.parse().ok())
                .ok_or("Invalid Git line count")?))
        };
        let counts = (count(added)?, count(deleted)?);
        if let Some(file) = files.get_mut(&path) {
            file.additions = counts.0;
            file.deletions = counts.1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "# branch.oid 0123456789abcdef0123456789abcdef01234567\0# branch.head feature/状态\0";

    #[test]
    fn counts_overlapping_changes_conflicts_and_individual_untracked_files() {
        let bytes = format!("{HEADER}1 MM N... 100644 100644 100644 abc def file with spaces\n.txt\0u UU N... 100644 100644 100644 100644 abc def ghi conflict.txt\0? 新 文件\n.txt\0? folder/second.txt\0");
        let (status, unborn) = parse_status(bytes.as_bytes()).unwrap();
        assert_eq!(status.branch, "feature/状态");
        assert_eq!((status.staged, status.unstaged, status.conflicted, status.untracked), (1, 1, 1, 2));
        assert!(!unborn);
    }

    #[test]
    fn consumes_rename_source_even_when_it_looks_like_a_status_record() {
        let bytes = format!("{HEADER}2 R. N... 100644 100644 100644 abc def R100 new 名\n.txt\0? old name\0? actual untracked\0");
        let (status, _) = parse_status(bytes.as_bytes()).unwrap();
        assert_eq!((status.staged, status.unstaged, status.untracked), (1, 0, 1));
        assert!(parse_status(format!("{HEADER}2 R. N... 100644 100644 100644 abc def R100 new\0").as_bytes()).is_err());
    }

    #[test]
    fn supports_unborn_and_detached_headers() {
        let (unborn, initial) = parse_status(b"# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert_eq!(unborn.branch, "main");
        assert!(initial);
        let (detached, initial) = parse_status(b"# branch.oid abcdef0123456789\0# branch.head (detached)\0").unwrap();
        assert_eq!(detached.branch, "detached abcdef0");
        assert!(!initial);
    }

    #[test]
    fn sums_numstat_with_binary_and_nul_rename_records() {
        let bytes = "3\t2\tfile with\ttabs\n名\0-\t-\tbinary\0-\t-\t\0old binary\0new binary\02\t1\t\0old\nname\0new 名\04\t0\tlast\0";
        assert_eq!(parse_numstat(bytes.as_bytes()).unwrap(), (9, 3));
        assert!(parse_numstat(b"2\t1\t\0old\0").is_err());
        assert!(parse_numstat(b"-\t2\tbad\0").is_err());
    }

    #[test]
    fn changed_paths_preserve_rename_names_and_control_characters() {
        let files = parse_tracked_changes(b":100644 100644 abc def R100\0old\tname\0new\nname\0:100644 100644 abc def M\0glob[ab].txt\02\t3\t\0old\tname\0new\nname\0-\t-\tglob[ab].txt\0").unwrap();
        assert_eq!(files["new\nname"].source.as_deref(), Some("old\tname"));
        assert_eq!(files["new\nname"].status, "renamed");
        assert_eq!(files["new\nname"].additions, Some(2));
        assert_eq!(files["new\nname"].deletions, Some(3));
        assert_eq!(files["glob[ab].txt"].additions, None);
        assert!(parse_tracked_changes(b":100644 100644 abc def R100\0old\0").is_err());
    }

    #[tokio::test]
    async fn shared_snapshot_preserves_net_changes_and_refreshes_after_expiry() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("ompd-git-cache-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let result = async {
            assert!(git(&root, &["init", "--quiet"]).await.unwrap().status.success());
            for (path, text) in [("cancel.txt", "old\n"), ("old.txt", "rename\n"), ("edited.txt", "a\n")] {
                std::fs::write(root.join(path), text).unwrap();
            }
            assert!(git(&root, &["add", "."]).await.unwrap().status.success());
            assert!(git(&root, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed"]).await.unwrap().status.success());
            std::fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
            assert!(git(&root, &["add", "-A"]).await.unwrap().status.success());
            std::fs::write(root.join("cancel.txt"), "intermediate\n").unwrap();
            assert!(git(&root, &["add", "cancel.txt"]).await.unwrap().status.success());
            std::fs::write(root.join("cancel.txt"), "old\n").unwrap();
            std::fs::write(root.join("edited.txt"), "a\nb\n").unwrap();
            for index in 0..12 {
                std::fs::write(root.join(format!("nested/{index}.txt")), "new\n").unwrap();
            }
            let (first, second) = tokio::join!(snapshot(&root), snapshot(&root));
            let first = first.unwrap().unwrap();
            assert!(Arc::ptr_eq(&first, &second.unwrap().unwrap()));
            assert_eq!((first.status.staged, first.status.unstaged, first.status.untracked), (2, 2, 12));
            assert_eq!((first.status.additions, first.status.deletions), (1, 0));
            assert!(!first.files.iter().any(|file| file.path == "cancel.txt"));
            let renamed = first.files.iter().find(|file| file.path == "new.txt").unwrap();
            assert_eq!(renamed.source.as_deref(), Some("old.txt"));
            assert_eq!(renamed.status, "renamed");
            let cwd = root.to_string_lossy().into_owned();
            let (left, right) = tokio::join!(changes(cwd.clone()), changes(cwd.clone()));
            for changes in [left.unwrap().unwrap(), right.unwrap().unwrap()] {
                for index in 0..12 {
                    let path = format!("nested/{index}.txt");
                    let file = changes.files.iter().find(|file| file.path == path).unwrap();
                    assert_eq!((file.additions, file.deletions), (Some(1), Some(0)));
                }
            }
            assert!(diff(cwd, "new.txt".into()).await.unwrap().contains("rename from old.txt"));
            std::fs::write(root.join("edited.txt"), "a\nb\nc\n").unwrap();
            tokio::time::sleep(SNAPSHOT_TTL + Duration::from_millis(10)).await;
            let refreshed = snapshot(&root).await.unwrap().unwrap();
            assert!(!Arc::ptr_eq(&first, &refreshed));
            assert_eq!((refreshed.status.additions, refreshed.status.deletions), (2, 0));
        }.await;
        std::fs::remove_dir_all(root).unwrap();
        result
    }

    #[test]
    fn rejects_escaping_or_ambiguous_repository_paths() {
        for path in ["", "/absolute", "../secret", "dir/../../secret", "dir/./file",
            "dir//file", "dir/", "nul\0file"]
        {
            assert!(validate_path(path).is_err(), "{path:?}");
        }
        assert!(validate_path("folder/文件 with\n tabs\t.txt").is_ok());
        if cfg!(windows) {
            for path in ["C:/secret", "C:secret", "dir\\..\\secret", "file:stream"] {
                assert!(validate_path(path).is_err(), "{path:?}");
            }
        }
    }

    #[tokio::test]
    async fn unborn_changes_include_untracked_text_and_binary_from_nested_workspace() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("ompd-inspector-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let result = async {
            assert!(git(&root, &["init", "--quiet"]).await.unwrap().status.success());
            std::fs::write(root.join("nested/new file.txt"), b"first\nsecond\n").unwrap();
            std::fs::write(root.join("binary"), b"binary\0data").unwrap();
            let changes = changes(root.join("nested").to_string_lossy().into_owned()).await.unwrap().unwrap();
            let text = changes.files.iter().find(|file| file.path == "nested/new file.txt").unwrap();
            assert_eq!(text.status, "untracked");
            assert_eq!((text.additions, text.deletions), (Some(2), Some(0)));
            let binary = changes.files.iter().find(|file| file.path == "binary").unwrap();
            assert_eq!((binary.additions, binary.deletions), (None, None));
            let cwd = root.to_string_lossy().into_owned();
            let patch = diff(cwd.clone(), "nested/new file.txt".into()).await.unwrap();
            assert!(patch.contains("+first") && patch.contains("+second"));
            assert!(diff(cwd.clone(), "binary".into()).await.unwrap().contains("Binary files"));
            assert!(diff(cwd, "../secret".into()).await.is_err());
        }.await;
        std::fs::remove_dir_all(root).unwrap();
        result
    }
}
