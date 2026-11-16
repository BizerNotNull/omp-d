import {
  invoke as nativeInvoke,
  isTauri,
  type InvokeArgs,
  type InvokeOptions,
} from "@tauri-apps/api/core";

type ErrorSource = "window_error" | "unhandled_rejection" | "react_boundary";
type FrontendReport =
  | { kind: "ipc"; command: string; durationMs: number; success: boolean }
  | { kind: "error"; source: ErrorSource };

// Sampling is shared by every caller, including terminal traffic. No payloads,
// results, exception values, RPC types or correlation IDs enter this module.
const WINDOW_MS = 1_000;
const MAX_SUCCESSES = 20;
const MAX_FAILURES = 10;
const MAX_IN_FLIGHT = 8;
let windowStarted = 0;
let successes = 0;
let failures = 0;
let inFlight = 0;
const sampledCommands = new Set<string>();

function reportFrontend(report: FrontendReport): void {
  try {
    if (typeof window === "undefined" || !isTauri() || inFlight >= MAX_IN_FLIGHT) return;
    const now = performance.now();
    if (now - windowStarted >= WINDOW_MS) {
      windowStarted = now;
      successes = 0;
      failures = 0;
      sampledCommands.clear();
    }
    if (report.kind === "ipc" && report.success) {
      if (successes >= MAX_SUCCESSES || sampledCommands.has(report.command)) return;
      sampledCommands.add(report.command);
      successes++;
    } else {
      if (failures >= MAX_FAILURES) return;
      failures++;
    }
    inFlight++;
    // Defer the native call; diagnostics must never alter application outcomes.
    void Promise.resolve()
      .then(() => nativeInvoke("report_frontend", { report }))
      .then(() => { inFlight--; }, () => { inFlight--; });
  } catch {
    // Browser previews and unavailable native diagnostics remain best effort.
  }
}

export function reportFrontendError(source: ErrorSource): void {
  reportFrontend({ kind: "error", source });
}

/** Only fixed application-owned labels belong here, never RPC types or IDs. */
export function reportRpcCompletion(started: number, success: boolean): void {
  reportFrontend({
    kind: "ipc",
    command: "rpc_complete",
    durationMs: performance.now() - started,
    success,
  });
}

/** Drop-in core invoke API; arguments, values and rejection identities survive. */
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (cmd === "report_frontend") return nativeInvoke<T>(cmd, args, options);
  const started = performance.now();
  try {
    const result = await nativeInvoke<T>(cmd, args, options);
    reportFrontend({ kind: "ipc", command: cmd, durationMs: performance.now() - started, success: true });
    return result;
  } catch (error) {
    reportFrontend({ kind: "ipc", command: cmd, durationMs: performance.now() - started, success: false });
    throw error;
  }
}

let uninstall: (() => void) | undefined;

/** Install outside React effects so StrictMode never duplicates global hooks. */
export function installDiagnostics(): () => void {
  if (uninstall) return uninstall;
  if (typeof window === "undefined") return () => {};
  const onError = () => reportFrontendError("window_error");
  const onRejection = () => reportFrontendError("unhandled_rejection");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  uninstall = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    uninstall = undefined;
  };
  return uninstall;
}

if (import.meta.hot) import.meta.hot.dispose(() => uninstall?.());
