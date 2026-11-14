import { expect, test } from "bun:test";
import { projectInspectorAgents, sessionChangedPaths } from "../src/lib/omp/inspector";
import type { ToolRun } from "../src/lib/omp/store";

const run = (overrides: Partial<ToolRun>): ToolRun => ({ toolCallId: overrides.toolName ?? "call", toolName: "task", status: "success", startedAt: 1, updatedAt: 2, ...overrides });

test("terminal lifecycle replaces a running task snapshot and child output is retained", () => {
  const agents = projectInspectorAgents({ call: run({ details: { progress: [{ id: "Review", status: "running", currentTool: "read", currentToolArgs: "auth.ts" }] } }) }, [], {
    Review: { id: "Review", agent: "reviewer", index: 0, status: "failed", lastUpdate: 3, description: "Review auth" },
  }, { Review: [{ role: "assistant", content: [{ type: "text", text: "Refresh token is not invalidated." }], timestamp: 3 }] });
  expect(agents[0]).toMatchObject({ id: "Review", status: "error", snapshot: false, output: "Refresh token is not invalidated." });
});

test("successful multi-file edit entries remain visible after another file fails", () => {
  const paths = sessionChangedPaths([], {
    edit: run({ toolName: "edit", status: "error", details: { perFileResults: [
      { path: "src/auth.ts", diff: "+fix", isError: false },
      { path: "src/failed.ts", diff: "+not applied", isError: true },
    ] } }),
    read: run({ toolName: "read", args: { path: "src/read-only.ts" } }),
    dispatch: run({ toolName: "write", args: { path: "xd://some-tool" } }),
    pending: run({ toolCallId: "pending", toolName: "write", status: "running", args: { path: "pending.ts" } }),
    preview: run({ toolName: "ast_edit", details: { applied: false, fileReplacements: [{ path: "preview.ts", count: 1 }] } }),
  });
  expect([...paths]).toEqual(["src/auth.ts"]);
});

test("restored transcript resolves successful file writes without streaming state", () => {
  const paths = sessionChangedPaths([
    { role: "assistant", content: [{ type: "toolCall", id: "write", name: "write", arguments: { path: "./auth.ts" } }], timestamp: 1 },
    { role: "toolResult", toolCallId: "write", toolName: "write", content: [], details: { resolvedPath: "D:\\project\\auth.ts" }, isError: false, timestamp: 2 },
  ], {});
  expect([...paths]).toEqual(["D:/project/auth.ts"]);
});
