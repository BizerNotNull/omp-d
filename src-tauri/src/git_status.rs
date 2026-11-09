//! Read-only workspace status. File counts cover the whole repository, including
//! individual untracked files (not directories); conflicts are counted separately
//! from staged/unstaged files, which may otherwise overlap. Line totals are Git's
//! tracked worktree-versus-HEAD numstat (empty tree on unborn branches), so staged
//! and unstaged edits that cancel contribute nothing. Untracked and binary file
//! contents contribute no lines; renames use Git's configured rename detection.

use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
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
    command.output().await.map_err(|error| format!("Cannot execute Git: {error}"))
}

fn process_error(output: &Output) -> String {
    format!("Git exited unsuccessfully ({}): {}", output.status, String::from_utf8_lossy(&output.stderr).trim())
}

pub async fn status(cwd: String) -> Result<Option<GitStatus>, String> {
    tokio::time::timeout(Duration::from_secs(5), query(Path::new(&cwd)))
        .await
        .map_err(|_| "Git status timed out after 5 seconds".to_string())?
}

async fn query(cwd: &Path) -> Result<Option<GitStatus>, String> {
    let output = git(cwd, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).await?;
    if !output.status.success() {
        // A missing executable, inaccessible cwd, unsafe repository, corrupt index,
        // or any other process failure is an error, not an empty workspace status.
        if output.status.code() == Some(128)
            && output.stderr.starts_with(b"fatal: not a git repository (or any ")
        {
            return Ok(None);
        }
        return Err(process_error(&output));
    }
    let (mut status, unborn) = parse_status(&output.stdout)?;
    let empty_tree;
    let base = if unborn {
        // Compute, but never write, the empty tree ID; works for SHA-1 and SHA-256.
        let output = git(cwd, &["hash-object", "-t", "tree", "--stdin"]).await?;
        if !output.status.success() {
            return Err(process_error(&output));
        }
        empty_tree = String::from_utf8(output.stdout).map_err(|_| "Git returned an invalid empty tree ID".to_string())?;
        let id = empty_tree.trim();
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Git returned an invalid empty tree ID".into());
        }
        id
    } else {
        "HEAD"
    };
    let output = git(cwd, &["diff", "--numstat", "-z", "--no-relative", "--no-ext-diff", "--no-textconv", base, "--"]).await?;
    if !output.status.success() {
        return Err(process_error(&output));
    }
    (status.additions, status.deletions) = parse_numstat(&output.stdout)?;
    Ok(Some(status))
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
}
