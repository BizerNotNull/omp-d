# Repository Guidelines

## Project overview

`omp-d` is a Tauri 2 desktop client for Oh My Pi (`omp`), using React 19, TypeScript, Zustand, and Rust. It launches the existing agent runtime; session persistence, tools, and artifacts remain owned by `omp`.

## Architecture & data flow

- `src/main.tsx` mounts React; `src/App.tsx` adds the error boundary. `src/components/app/AppShell.tsx` bootstraps the workspace through `useAppStore`.
- `src/lib/omp/store.ts` owns application state, async actions, hydration, and transcript/event projection. `client.ts` owns request-ID correlation, readiness, protocol negotiation, and Tauri event subscriptions; `types.ts` defines protocol/UI contracts.
- Commands flow UI → `OmpClient` → Tauri `invoke` → Rust → child stdin as JSONL. Rust emits stdout frames through `omp://frame`, plus `omp://process` and `omp://stderr` events. Correlated responses resolve requests; unsolicited frames update the store.
- Rust alone owns the child process. `agent.rs` serializes lifecycle operations and manages pipes/shutdown; `rpc_frame.rs` validates and reassembles protocol-v2 chunks. Preserve generation filtering so old-process events cannot update a new connection, including the race where `ready` arrives before `start_agent` returns.
- Workspace/UI preferences use localStorage (`ompd:lastCwd`, `ompd:prefs`). Durable conversations are omp JSONL sessions; `sessions.rs` reads bounded summaries using omp-compatible path encoding. Catalog/role queries run separately through `catalog.rs` and `catalog-extension.mjs`.

## Key directories

- `src/components/`: application UI and shared UI primitives.
- `src/lib/omp/`: protocol client, types, and central store. Keep transport/lifecycle logic out of view components.
- `src-tauri/src/`: native supervisor, IPC commands, frame decoder, session discovery, and catalog integration.
- `docs/architecture.md`: detailed lifecycle, protocol, persistence, and security reference.
- `dist/`, `node_modules/`, `src-tauri/target/`, and generated Tauri files are build/dependency outputs; do not edit them.

## Development commands

Run from the repository root:

| Command | Purpose |
| --- | --- |
| `bun install` | Install frontend/CLI dependencies |
| `bun tauri dev` | Run the desktop app with Vite |
| `bun run dev` | Start Vite only; native IPC requires Tauri |
| `bun run typecheck` | Check app and Vite-config TypeScript |
| `bun run build` | Typecheck and build the frontend |
| `bun tauri build --no-bundle` | Build a release app without installers |
| `bun tauri build` | Build the app and platform bundles |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run Rust unit tests |

No lint, formatter, or frontend test script is configured. `bun run preview` previews the frontend bundle, not the native runtime.

## Code conventions & common patterns

- Follow adjacent formatting: TypeScript uses two-space indentation, double quotes, and semicolons; Rust uses four-space indentation. Components/types use PascalCase, functions/state fields use camelCase, hooks use `use…`; Rust functions/modules use snake_case.
- Use `@/` for source-root imports where appropriate; preserve existing relative imports. TypeScript is strict and checks unused locals/parameters.
- Use Zustand `set`/`get` actions for shared state and async transitions; component-local state belongs in React. Reuse the existing client singleton and Tauri-managed `AgentState`; there is no separate dependency-injection framework.
- RPC failures use `RpcFailure`; normalize caught `unknown` errors through existing helpers and report failures via store errors/toasts. Native IPC generally returns `Result<_, String>`. Keep intentionally best-effort refreshes distinct from user-visible operation failures.
- Keep TypeScript wire types, Rust serde payloads, command registration, and `invoke` arguments synchronized. Extension UI responses use `sendRaw`; ordinary commands use correlated requests.
- Preserve ordered chunk validation, session-path encoding, serialized process starts, graceful stdin-close shutdown, and exit monitoring when changing native code.
- Treat model output as untrusted: retain Markdown rendering without raw HTML, escaped tool output, and external-link routing through the Tauri opener. The child runs with the user's normal permissions.

## Important files

- `package.json`, `bun.lock`: frontend commands and dependency lock.
- `vite.config.ts`: React/Tailwind plugins, `@` alias, strict dev port 1420, optional `TAURI_DEV_HOST` handling.
- `tsconfig.json`, `tsconfig.node.json`: separate app/config type checks.
- `components.json`, `src/index.css`: UI generator configuration and shared styling.
- `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`: native entry, command registration, managed state, and exit cleanup.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: Rust dependencies and release settings.
- `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`: Bun build hooks, window/bundle settings, and plugin permissions.
- `README.md`, `CHANGELOG.md`: setup, supported behavior, and change history.

## Runtime/tooling preferences

Use Bun 1.4+ and the committed `bun.lock`; Tauri hooks explicitly call Bun. Rust 1.85+ and platform Tauri prerequisites are required; Windows development uses MSVC 2022 and WebView2. Keep both dependency lockfiles consistent with manifest changes.

An `omp` executable must be on `PATH` or configured by absolute path in Settings. First launch selects a workspace; `OMPD_CWD` supplies a fallback when no previous workspace is stored. `PI_CODING_AGENT_DIR` overrides the session root. Browser-only Vite runs cannot validate subprocess behavior.

## Testing & QA

Rust uses inline `#[cfg(test)]`/`#[test]` modules in `rpc_frame.rs` and `sessions.rs`, covering chunk sequences, malformed input, session bucket encoding, and JSONL summary parsing. No frontend automated test suite or coverage threshold is configured.

Run the Rust test command and `bun run build` for relevant changes. Extend nearby Rust tests for decoder/session edge cases. For behavioral changes, also exercise the desktop app against a real local `omp`: verify the affected path, including streaming, abort/queues, dialogs, model listing, session switching, settings restart, or crash recovery as applicable. Typechecking and bundling alone do not validate IPC or UI behavior.
