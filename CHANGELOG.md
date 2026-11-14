# Changelog

## Unreleased

### Added
- Unified session-first navigation across Worktrees: Recent, Running and Pinned views, global full-content search, searchable Worktree filtering, cursor-paginated virtualized history, cached pages and remembered scroll positions
- Persist session/Worktree pins and last-opened conversations; restore each Worktree's session without changing the list when opening a conversation directly
- Show the execution Worktree in the session header and composer, with target selection before the first message

### Changed
- Keep open sessions running in independent background runtimes when switching sessions, starting a new session, or opening another workspace, preserving streaming state, queues, dialogs and composer drafts

### Removed
- Group Recent Sessions under the main repository directory with nested linked-worktree directories marked by a branch icon
- Use the pen beside the Recent repository name to start a new session; remove the separate New session button
## 0.1.0 — 2026-11-06

Initial desktop client for Oh My Pi.

### Agent transport

- Spawns `omp --mode rpc-ui` as a supervised child process over stdio.
- Negotiates RPC protocol v2 and reassembles `rpc_chunk` frames in Rust, with declared-length, base64, ordering and strict-UTF-8 validation.
- Tags every frame with a process generation so replaced agents cannot mutate the active UI.
- Serializes start/stop calls, polls the direct child for exit, and falls back from graceful stdin close to a process-tree kill.

### Chat

- Streaming assistant text, thinking blocks, tool cards, tool output, image results and edit diffs.
- Markdown with GFM tables, line breaks and syntax-highlighted code.
- Tool cards show summaries, running state, ANSI-stripped output, details and diff hunks.
- Steering and follow-up queues with removable chips, abort, prompt error surfacing, notices and toasts.
- Image paste in the composer, slash-command autocomplete from `available_commands_update`.

### Sessions and state

- Recent sessions from the project bucket: switch, create, rename, and hide unused stubs.
- First-prompt auto titles and manual rename via `set_session_name`.
- Automatic transcript reconciliation on `session_settled`.
- Restart that reopens the previous session file.
- Model picker, thinking-level menu, context/token/cost status bar, TODOs, running tools, notices, status marks and widgets.
- Extension dialogs for select/confirm/input/editor/ask, plus notify, title, editor text and URL handling.

### App

- Tauri 2 + React 19 + shadcn/ui on Base UI.
- Settings for binary path, initial model, extra arguments, theme, runtime details, stderr diagnostics and process stop.
- Dark and light themes, responsive layout down to the 900×600 window minimum.
- Custom π application icon.
