# Changelog

## Unreleased

### Added
- Render SVG and Mermaid fences, theme-aware SVG image blocks, previews of written `.svg`/`.mmd`/`.mermaid` files, and numeric comparison charts below compatible tables. Figures remain visible in collapsed tool cards; partial tool-result images appear during execution.
- Embedded xterm.js terminal backed by native PTYs: workspace shells, persistent hidden tabs, resizable/maximizable bottom panel, keyboard toggle, exit status, and process-tree cleanup.
- Edit sent user messages with a pencil and Save & fork in the current omp session, using its `/tree` navigation. The edited prompt is sent to the agent; original branches and image attachments remain available.
- Per-message branch counters and previous/next arrows restore saved conversation tails in the same session without resubmitting prompts.
- Group Recent Sessions under the main repository directory, with nested linked-worktree directories marked by a branch icon.

### Fixed
- Show a conversation spinner while waiting for the first model token, including before an assistant message starts and while its content is empty.
- Follow the relocated session directory after `/wt` and `/move` without restarting the agent; refresh the workspace, recent sessions, model catalog, and Git status.
- Reconcile the workspace when local slash commands finish, even when the observed session-file path is unchanged; keep internal workspace-query completions out of user turn state.
- Display slash-command errors from `command_output` as error notifications and retain command output in Activity, including `/wt` branch-name conflicts.
- Fix long-chat page/input freezes: load flat session entries instead of nested tree responses, and keep branch metadata loading independent of transcript hydration and composer controls.
- Keep `bun tauri dev` open during `/wt <branch>` by disabling native watcher auto-restarts; frontend hot reload remains enabled. Use `bunx tauri dev` to opt into native watching
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
