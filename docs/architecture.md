# Architecture

## Process topology

```mermaid
flowchart LR
  UI["React renderer\n(src/)"]
  RS["Rust supervisor\n(src-tauri/src/)"]
  OMP["omp --mode rpc-ui"]
  AUTH["omp --mode rpc --no-session\n(provider login worker)"]
  FS["~/.omp/agent\nsessions, settings"]

  UI -- "invoke: start_agent / rpc_send / auth_start / auth_send" --> RS
  RS -- "JSONL commands on stdin" --> OMP
  OMP -- "JSONL frames on stdout" --> RS
  RS -- "omp://frame, omp://process, omp://stderr" --> UI
  RS -- "attempt-scoped login commands" --> AUTH
  AUTH -- "private input inbox + auth events" --> RS
  RS -- "omp://auth" --> UI
  OMP -- "session + artifact state" --> FS
  AUTH -- "provider credentials" --> FS
  RS -- "reads session headers" --> FS
```

The Rust process is the only process owner. The React layer never spawns
children; it asks the supervisor to start, send to, or stop them.

## Startup

1. `AppShell` calls `bootstrap()` once. `bootstrap` reads `ompd:lastCwd`, or the
   `OMPD_CWD` fallback through `initial_folder`, then calls `connect(cwd)`.
2. `OmpClient.start` invokes `start_agent` with `cwd`, optional `model`, optional
   binary override and extra CLI arguments. Rust canonicalizes the path, strips
   the Windows `\\?\` prefix, serializes start calls behind `start_lock`, stops
   any previous child, then spawns:

   ```
   omp --mode rpc-ui --cwd <path> [--model <model>] [extra…]
   ```

3. Rust takes stdin/stdout/stderr pipes, stores the child behind a tokio mutex,
   emits `started`, and starts three tasks: stdout reader, stderr reader, and a
   500 ms exit monitor.
4. `OmpClient.start` waits up to 45 s for the `ready` frame. On `ready` it sends
   `negotiate_protocol(2)` when advertised and resolves the start.
5. `connect` sends `set_ask_dialog(enabled: true)`, then hydrates with
   `get_state`, `get_messages`, `get_session_stats`,
   `get_available_thinking_levels` and `get_available_commands`, and loads the
   session bucket through Rust `list_sessions`. A separate `get_entries`
   request loads branch metadata without blocking transcript hydration.

## Provider login

The `/models` provider sidebar retains model availability as a separate
catalog fact. Double-clicking a provider with no available models opens its
login page; a single click still filters the model catalog.

Login runs in a separate attempt-scoped `omp --mode rpc --no-session` child.
The native supervisor supplies a temporary extension and a private extension
input request for login commands, so these commands never become chat prompts.
The extension lists OAuth methods from omp's provider registry and invokes the
same `authStorage.oauth.login` flow as the TUI. Browser URLs and prompts are
forwarded to the page; secrets remain transient and are redacted from auth
events. Cancelling stops the worker. After success, the worker refreshes that
provider's model discovery before the page reloads the CLI model catalog.

## Native configuration

`/settings`, the toolbar and the settings keyboard shortcut open the same
settings surface. `NativeSettings` reads the configured binary, project and
profile through `native_settings`; desktop launcher drafts do not change that
scope until saved.

`settings.rs` queries `omp config list --json` for the complete effective
catalog and `config list --scope global --json` for stored global overrides.
Only global values initialize editable drafts. Project/environment defaults
are descriptive and are never copied into the global layer on opening or
saving an unrelated row. Human `config list` output supplies native category
and enum metadata; format drift falls back to key-prefix groups/text editors
without dropping JSON catalog entries.

`native_setting_write` serializes global mutations and calls native
`config set` or `config reset` with literal argv, native validation and a
30-second timeout. Reset removes one global key. Writes return provenance
labels only, never the CLI's plaintext credential value. Credential drafts
stay blank until explicitly replaced, and subprocess errors are sanitized.
Successful writes refresh effective summaries without discarding other row
drafts. Replaced scopes and stale requests cannot update the current editor.

Changes persist in omp's configuration, independently of the running agent.
The explicit restart action uses the existing session-preserving restart path.
Native terminal appearance settings do not change the desktop renderer.
Config commands do not accept launcher `--config` flags; the editor warns
about that difference and never writes an overlay or project file.


## Conversation forks

`get_entries` supplies flat persisted entries and the active leaf. `branches.ts`
matches active-path user entries to transcript messages by role, timestamp and
content, including attachments. Alternatives share their nearest preceding
message entry; non-message metadata does not split that group. Nested forks
remain separate. Traversals are iterative for long histories.
It builds the tree locally from parent IDs, avoiding the native JSON decoder's
depth limit on nested `get_tree` responses. Branch metadata refreshes cannot
disable the composer, sending, queue removal or abort controls.

Editing stays local until Save & fork. The store calls `navigate_tree` on the
original user entry with summarization disabled; omp moves to its parent.
Only a successful, non-cancelled navigation submits the edited prompt with the
original images. Branch arrows navigate directly to a saved descendant leaf,
preferring the current leaf for the active alternative and the newest tail
for inactive alternatives. No new session file or local branch database is
created. An unanswered user-only leaf follows omp's draft-restoration behavior.

`branching` locks prompt submission and other session transitions. Branching
also requires idle streaming, background work and queues. Generation and
conversation-revision checks discard stale hydration/navigation results.
After navigation the store clears branch-specific transient UI state and
refreshes messages, tree and session state. Failed prompt submission restores
the edited text and attachments to the composer. An unavailable entries API
reports a warning and leaves edit/branch controls absent.

## Framing

`rpc_frame.rs` implements the protocol-v2 decoder:

- a normal object is passed through;
- `rpc_chunk` frames validate `chunkId`, `index`, `count` and `byteLength`;
- each payload must be canonical base64 and at most 256 KiB;
- indices must be contiguous, the declared byte length must match, and the
  reassembled bytes must be strict UTF-8 JSON;
- a frame arriving mid-sequence, or any mismatch, aborts the sequence.

If the decoder returns a logical frame, Rust emits `omp://frame` with
`{ generation, frame }`. The renderer drops frames whose generation differs from
the active client, which prevents a replaced process from mutating UI state.

## Request correlation

`OmpClient` assigns `ui-N` ids, registers a pending entry, writes the command
through `rpc_send`, and resolves on the `response` frame with that id. Failures
become `RpcFailure` with the RPC `code`. A failure after an acknowledged prompt
arrives as a later `prompt_result` frame instead of a response; the store
surfaces it as a toast and notice.

Extension UI answers are fire-and-forget frames without a response.

## Transcript projection

The store keeps two lists:

- `messages` — committed messages from `get_messages` or completed
  `message_end` frames;
- `pending` — messages currently streaming, keyed by the RPC `messageId`.

`message_start` inserts a pending message, `message_update` replaces it with the
full snapshot the runtime provides, and `message_end` moves it to `messages`
unless a timestamp/role/tool-call key already exists. On `session_settled` (and
after a session change) the store re-reads the full transcript, clears pending,
and deduplicates by the same key.

Tool calls are looked up by `toolCallId`: assistant `toolCall` blocks render a
card with the matching `toolResult`; orphan results render standalone.
`tool_execution_start/update/end` populate a live `toolRuns` map for running
state and partial output. Terminal output is passed through `stripAnsi()`.

## Sessions

A cwd maps to a session bucket exactly as `session-paths.ts` does:
home-relative `-…`, temp-relative `-tmp-…`, otherwise `--<absolute>--`, with
path separators and `:` replaced by `-`. The lister reads at most 32 KiB per
file, folds the fixed-width title slot into the header, keeps the first
non-synthetic user message as preview, and hides untitled sessions with no
prompt (matching the interactive picker).

- New session: `new_session`, then clear local transcript/dialog/session state
  and rehydrate.
- Switch: `switch_session(sessionPath)`, same clearing, same rehydration.
- Rename: `set_session_name`, then refresh state and the bucket list.
- First prompt auto-title: if the session has no name and no messages, the first
  prompt text (first line, 64 chars) is sent as `set_session_name` after the
  prompt is acknowledged.
- Restart: `restart()` re-spawns via `connect`, then reopens the remembered
  `sessionFile` with `switch_session`, so the conversation survives settings
  changes, crashes and manual restarts.

## Composer status

The row below the input shows the current goal status, thinking level, enabled
fast/slow modes, context usage, and extension status marks. The mode slot
appears only while a goal exists, as `/goal` plus its status; the objective
itself stays in the Activity rail. `/prewalk` is not rendered: the installed
runtime does not expose prewalk state through `get_state`, so the client never
infers activation from composer text or notices. TODO.md tracks querying that
state over RPC.

`git_status(cwd)` runs read-only Git commands in Rust with a five-second timeout
and no Windows console window. The active composer refreshes on mount, focus,
turn activity changes, and every ten seconds. Requests are coalesced and results
from replaced connections/workspaces are ignored.

File counts cover the whole repository: staged and unstaged counts can overlap,
conflicts are separate, and untracked files are counted individually. Line totals
compare tracked working files against HEAD (the empty tree for unborn branches);
binary contents and untracked files are excluded. Worktrees and detached HEAD
are supported. Non-repositories and Git failures have distinct labels; failed
refreshes clear old values.


## Failure handling

- Closing stdin lets omp drain accepted commands and exit cleanly. Rust waits 5 s,
  then falls back to `taskkill /PID /T /F` on Windows (or `kill -TERM`
  elsewhere).
- `kill_on_drop(true)` covers ordinary Rust drops.
- The exit monitor exists because tool descendants can inherit stdout and keep
  the pipe open after the agent process is gone; it polls `try_wait()` and emits
  an `exit` event with the code.
- On EOF/exit/read error the client rejects pending requests, emits
  `disconnected`, and the UI shows the restart affordance. A restart preserves
  the last session file.
- `stop_agent` and `start_agent` share a mutex so overlapping invocations cannot
  stop each other's freshly spawned child.

## Extension UI mapping

| RPC method                   | UI                                                       |
| ---------------------------- | -------------------------------------------------------- |
| `select`                     | modal option list                                        |
| `confirm`                    | modal confirm/cancel                                     |
| `input`                      | modal single-line input, optional password type          |
| `editor`                     | modal textarea, submits the edited text                  |
| `ask`                        | questionnaire with multi-select, recommended badge, free text |
| `notify`                     | toast                                                    |
| `setStatus` / `setWidget`    | Activity rail status lines and widget blocks             |
| `setTitle`                   | document title                                           |
| `set_editor_text`            | composer draft                                           |
| `open_url`                   | system opener                                            |
| `cancel`                     | removes the matching dialog                              |

## Security boundary

The renderer is untrusted with model output: Markdown is rendered through
`react-markdown` without raw HTML, tool output is escaped text, and links are
routed through the Tauri opener instead of in-page navigation. The agent itself
runs as the user, with the permissions of a normal `omp` process; the UI does not
add or remove tool capabilities.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml` covers frame reassembly,
  malformed chunk sequences, path encoding and session parsing.
- `bun run build` runs the strict TypeScript check and the production bundle.
- Live checks against a local `omp` instance covered streaming, tool cards,
  edit diffs, steering and follow-up queues, abort, `ask` dialogs, model listing,
  session switching, rename, settings restart and crash recovery.
