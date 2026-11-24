# Repository Guidelines

## Project overview

`omp-d` is a Tauri 2 desktop client for Oh My Pi (`omp`), using React 19, TypeScript, Zustand, and Rust. It launches the existing agent runtime; session persistence, tools, and artifacts remain owned by `omp`.

## Architecture & data flow

- `src/main.tsx` mounts React; `src/App.tsx` adds the error boundary. `src/components/app/AppShell.tsx` bootstraps the workspace through `useAppStore`.
- Each open session has an independent `OmpClient`, Zustand store, and supervised omp child. `src/lib/omp/store.ts` owns runtime state, async actions, hydration, and transcript/event projection; the stable `useAppStore` facade exposes the selected runtime. Switching sessions must leave background execution, queues, dialogs, and drafts intact. Async actions must retain their originating store/client.
- `client.ts` owns request-ID correlation, readiness, protocol negotiation, and Tauri event subscriptions; `types.ts` defines protocol/UI contracts. Commands flow UI → shared diagnostics `invoke` → Tauri → Rust → child stdin as JSONL. Rust emits `omp://frame`, `omp://process`, and `omp://stderr`; correlated responses resolve requests and unsolicited frames update the owning store.
- Rust alone owns child processes. `agent.rs` manages frontend ownership, per-runtime lifecycle serialization, pipes, shutdown, and exit monitoring; `rpc_frame.rs` validates and reassembles protocol-v2 chunks. Preserve frontend owner tokens and generation checks on sends, stops, and every event channel, including events received before `start_agent` returns. Stop/restart affects only the selected runtime; app exit stops all children.
- `navigation.ts` owns paginated sidebar history, Worktree scope, search, pins, and remembered selections separately from runtime state. Durable conversations remain omp JSONL sessions. `sessions.rs` discovers checkout/Worktree buckets and reads bounded summaries; preserve path normalization, cursor ordering, and cache invalidation.
- Workspace/UI preferences and navigation state use localStorage (`ompd:lastCwd`, `ompd:lastSession`, `ompd:lastProject`, `ompd:prefs`, plus navigation/cache keys). `model-catalog.ts` shares catalog/role snapshots and in-flight queries across runtimes; native queries use `catalog.rs` and `catalog-extension.mjs`.
- Runtime relocation (`/wt`, `/move`) adopts the cwd reported through `workspace-extension.mjs` without restarting the child or clearing the conversation. Refresh directory-scoped history, catalog, and Git data; do not infer cwd solely from the session-file path.

## Key directories

- `src/components/`: application UI and shared UI primitives.
- `src/lib/omp/`: protocol clients, per-session stores, navigation, model catalog, transcript projection, and UI contracts. Keep transport/lifecycle logic out of view components.
- `src/lib/diagnostics.ts`: shared native invocation and bounded, metadata-only frontend diagnostics.
- `src/lib/terminal/` and `src-tauri/src/terminal.rs`: ordered terminal IPC and native PTY ownership, independent of omp runtimes.
- `src-tauri/src/`: native supervisors, IPC commands, frame decoder, session discovery, Git queries, settings, authentication, and diagnostics.
- `tests/`: Bun regression tests and the browser scroll fixture. No package-level test script is configured.
- `docs/architecture.md`: detailed lifecycle, protocol, persistence, caching, and security reference.
- `dist/`, `node_modules/`, `src-tauri/target/`, and generated Tauri files are build/dependency outputs; do not edit them.

## Development commands

Run from the repository root:

| Command | Purpose |
| --- | --- |
| `bun install` | Install frontend/CLI dependencies |
| `bun tauri dev` | Run the desktop app with Tauri/Vite watchers disabled |
| `bunx tauri dev` | Run the desktop app with normal file watchers |
| `bun run dev` | Start Vite with frontend hot reload; native IPC requires Tauri |
| `bun run typecheck` | Check app and Vite-config TypeScript |
| `bun run build` | Typecheck and build the frontend |
| `bun tauri build --no-bundle` | Build a release app without installers |
| `bun tauri build` | Build the app and platform bundles |
| `bun test tests/background-sessions.test.ts` | Exercise session isolation and runtime ownership |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust unit tests |

`scripts/tauri.mjs` sets `OMPD_DEV_NO_WATCH=1` and adds `--no-watch` for `bun tauri dev`, so `/wt` can rewrite the checkout without reloading the renderer or restarting children. Restart the development app after source edits, or explicitly opt into watchers with `bunx tauri dev`. No lint or formatter script is configured. `bun run preview` previews the frontend bundle, not the native runtime.

## Code conventions & common patterns

- Follow adjacent formatting: TypeScript uses two-space indentation, double quotes, and semicolons; Rust uses four-space indentation. Components/types use PascalCase, functions/state fields use camelCase, hooks use `use…`; Rust functions/modules use snake_case.
- Use `@/` for source-root imports where appropriate; preserve existing relative imports. TypeScript is strict and checks unused locals/parameters.
- Use Zustand `set`/`get` actions for shared state and async transitions; component-local state belongs in React. Reuse the per-runtime client/store mechanism and Tauri-managed state; do not introduce a global client singleton or a second process owner.
- Import frontend native `invoke` from `@/lib/diagnostics`, not directly from Tauri core. Ordinary features inherit its timing reports. Persistent diagnostics must exclude payloads, responses, prompts, credentials, raw stderr, and exception text; Rust profiling scopes must not span `.await`.
- RPC failures use `RpcFailure`; normalize caught `unknown` errors through existing helpers and report failures via store errors/toasts. Native IPC generally returns `Result<_, String>`. Keep intentionally best-effort refreshes distinct from user-visible operation failures.
- Keep TypeScript wire types, Rust serde payloads, command registration, and `invoke` arguments synchronized. Extension UI responses use `sendRaw`; ordinary commands use correlated requests. Preserve both HTML `form` requests and legacy `ask` dialogs.
- Native settings use `omp config list --json` for effective values and global scope for editable overrides. Writes use native `config set`/`config reset`; never copy project defaults into global drafts or write launcher `--config` overlays. Preserve credential redaction, stale-scope guards, catalog invalidation, and explicit session-preserving restart. Keep the Oh My Pi and Desktop & runtime settings sections visually consistent.
- Preserve ordered chunk validation, session-path encoding, serialized process starts, graceful stdin-close shutdown, and exit monitoring when changing native code.
- Treat model and shell output as untrusted. Keep Markdown without raw HTML, escaped tool output, and external-link routing through the Tauri opener. `HtmlFormDialog` parses inert HTML and rebuilds allowlisted elements/attributes; never mount model-supplied HTML directly. Terminal output stays in xterm, without terminal-driven external-link or clipboard-write handlers. Children run with the user's normal permissions.
- Hiding the terminal panel or changing chat sessions must retain shells and scrollback. Workspace replacement, tab close, channel loss, and app exit terminate the affected PTYs and their children; preserve ordered create/input/resize/close handling.

## Important files

- `package.json`, `bun.lock`: frontend commands and dependency lock.
- `scripts/tauri.mjs`, `vite.config.ts`: watcher policy, React/Tailwind plugins, `@` alias, strict dev port 1420, and optional `TAURI_DEV_HOST` handling.
- `tsconfig.json`, `tsconfig.node.json`: separate app/config type checks.
- `components.json`, `src/index.css`: UI generator configuration and shared styling.
- `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`: native entry, command registration, managed state, and exit cleanup.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: Rust dependencies and release settings.
- `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`: Bun build hooks, window/bundle settings, and plugin permissions.
- `README.md`, `CHANGELOG.md`: setup, supported behavior, and change history. `TODO.md` tracks known gaps; do not present unsupported RPC operations as implemented.

## Runtime/tooling preferences

Use Bun 1.4+ and the committed `bun.lock`; Tauri hooks explicitly call Bun. Rust 1.85+ and platform Tauri prerequisites are required; Windows development uses MSVC 2022 and WebView2. Keep both dependency lockfiles consistent with manifest changes.

An `omp` executable must be on `PATH` or configured by absolute path in Settings. First launch selects a workspace; `OMPD_CWD` supplies a fallback when no previous workspace is stored. `PI_CODING_AGENT_DIR` overrides the session root. Browser-only Vite runs cannot validate subprocess behavior.

## Testing & QA

Frontend regression tests use `bun:test` in `tests/*.test.ts`, covering branches, navigation, background runtime ownership, store/session behavior, and rendering helpers. Run the relevant file(s) directly with `bun test tests/<name>.test.ts`; inspect the test's transport mocks and globals before extending it. Browser fixtures and mocked IPC tests do not prove native behavior.

Rust has inline `#[cfg(test)]`/`#[test]` modules, including frame decoding, session discovery/search, settings, Git queries, and terminal behavior. Extend nearby tests when changing those contracts.

Run `bun run build` for frontend changes and `cargo test --manifest-path src-tauri/Cargo.toml` for native changes. For behavioral changes, also exercise the desktop app against a real local `omp`: verify the affected path, including streaming, abort/queues, session isolation, dialogs, model listing, settings restart, terminal cleanup, or crash recovery as applicable. Session switching must not interrupt a different runtime. Typechecking and bundling alone do not validate IPC or UI behavior.
