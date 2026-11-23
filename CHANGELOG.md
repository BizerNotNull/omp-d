# Changelog

## Unreleased

### Added
- The model workspace edits global role assignments, ordered fallback chains, default thinking, and context-compaction thresholds. It shows workspace-resolved settings separately from live session values

### Changed
- The empty conversation reads tips from a bundled JSON file
- The model workspace separates the searchable catalog from global policy. The catalog groups providers by availability, uses a provider sidebar on desktop and a dropdown in narrow windows, and keeps the current model and thinking level in view
- The model catalog shares search and list styles with the project and Worktree pickers, with compact model rows and no separate results card. Roles and fallback rules use two panes on desktop and a single pane in narrow windows. Save and cancel stay visible while editor fields scroll
- Runtime Policy groups thinking and retry separately from compaction and model-specific thresholds. Settings stack in narrow windows, with the save action fixed below the scrolling form
- The status row below the composer no longer shows the thinking level. It can still be changed in the session toolbar
- `/settings` opens a full page styled like `/models`, with a section sidebar on desktop and a dropdown in narrow windows. Content fills the right pane; desktop launch preferences and runtime details sit side by side when space allows. Back returns to the previous view.

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
