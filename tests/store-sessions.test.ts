import { beforeEach, expect, mock, test } from "bun:test";
import type { AgentMessage, ImageContent, RpcCommand, SessionEntries, SessionListing, SessionTree } from "../src/lib/omp/types";

let starts: PromiseWithResolvers<{ cwd: string }>[] = [];
let lists: { cwd: string; result: PromiseWithResolvers<SessionListing> }[] = [];
let send: (command: RpcCommand) => Promise<{ data?: unknown }> = async () => ({});
mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { cwd: string }) => {
    if (command === "list_sessions") {
      const result = Promise.withResolvers<SessionListing>();
      lists.push({ cwd: args.cwd, result });
      return result.promise;
    }
    return Promise.resolve(command === "model_roles" ? {} : []);
  },
}));
mock.module("../src/lib/omp/client", () => ({
  RpcFailure: class extends Error {},
  omp: {
    generation: 1,
    start: () => {
      const result = Promise.withResolvers<{ cwd: string }>();
      starts.push(result);
      return result.promise;
    },
    send: (command: RpcCommand) => send(command),
  },
}));
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});
Object.assign(globalThis, { document: { title: "" }, window: { setTimeout: () => 0 } });
// Import after installing transport mocks and globals required at module initialization.
const { useAppStore: store } = await import("../src/lib/omp/store");
const oldListing: SessionListing = {
  repositoryCwd: "A",
  directories: [{ cwd: "A", isWorktree: false, sessions: [{ path: "A/old.jsonl", sessionId: "old", cwd: "A", title: "Old folder", modifiedMs: 1, size: 1 }] }],
};
const newListing: SessionListing = {
  repositoryCwd: "B",
  directories: [{ cwd: "B", isWorktree: false, sessions: [{ path: "B/new.jsonl", sessionId: "new", cwd: "B", title: "New folder", modifiedMs: 2, size: 1 }] }],
};

beforeEach(() => {
  starts = [];
  lists = [];
  send = async () => ({});
  store.setState(store.getInitialState(), true);
  store.setState({ cwd: "A", sessionListing: oldListing, status: "ready" });
});

test("switching clears old sessions during startup and ignores an old folder response", async () => {
  const oldLoad = store.getState().loadSessions();
  const connecting = store.getState().connect("B");
  expect(store.getState()).toMatchObject({ cwd: "B", sessionListing: undefined, sessionsLoading: true });
  lists[0].result.resolve(oldListing);
  await oldLoad;
  expect(store.getState()).toMatchObject({ sessionListing: undefined, sessionsLoading: true });

  starts[0].resolve({ cwd: "B" });
  while (lists.length < 2) await Promise.resolve();
  expect(lists[1].cwd).toBe("B");
  lists[1].result.resolve(newListing);
  await connecting;
  expect(store.getState()).toMatchObject({ sessionListing: newListing, sessionsLoading: false });
});

test("an obsolete folder failure cannot clear loading or show a warning", async () => {
  const oldLoad = store.getState().loadSessions();
  const connecting = store.getState().connect("B");
  lists[0].result.reject(new Error("Old folder failed"));
  await oldLoad;
  expect(store.getState()).toMatchObject({ sessionListing: undefined, sessionsLoading: true, notifications: [] });
  starts[0].reject(new Error("Agent failed"));
  await connecting;
  expect(store.getState()).toMatchObject({ status: "error", sessionListing: undefined, sessionsLoading: false });
});

test("the latest list request wins even when older requests finish last", async () => {
  const older = store.getState().loadSessions();
  const newer = store.getState().loadSessions();
  lists[1].result.resolve(newListing);
  await newer;
  lists[0].result.resolve(oldListing);
  await older;
  expect(store.getState()).toMatchObject({ sessionListing: newListing, sessionsLoading: false });
});

test("a current list failure ends loading and reports the failure", async () => {
  const loading = store.getState().loadSessions();
  lists[0].result.reject(new Error("Access denied"));
  await loading;
  expect(store.getState().sessionsLoading).toBe(false);
  expect(store.getState().notifications).toMatchObject([{ kind: "warning", message: "Session list failed: Access denied" }]);
});

test("selecting a worktree session starts its workspace before reopening the session", async () => {
  const targetPath = newListing.directories[0].sessions[0].path;
  store.setState({
    sessionListing: { repositoryCwd: "A", directories: [...oldListing.directories, { ...newListing.directories[0], isWorktree: true }] },
  });
  const switches: { cwd: string | undefined; path: unknown }[] = [];
  send = async (command) => {
    if (command.type === "switch_session") switches.push({ cwd: store.getState().cwd, path: command.sessionPath });
    return {};
  };
  const switching = store.getState().switchSession(targetPath);
  expect(store.getState().cwd).toBe("B");
  expect(switches).toEqual([]);
  starts[0].resolve({ cwd: "B" });
  while (lists.length < 1) await Promise.resolve();
  lists[0].result.resolve(newListing);
  while (lists.length < 2) await Promise.resolve();
  lists[1].result.resolve(newListing);
  await switching;
  expect(switches).toEqual([{ cwd: "B", path: targetPath }]);
  expect(store.getState().sessionListing).toEqual(newListing);
});

test("local command completion reconciles cwd even when the session file is unchanged", async () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "keep this conversation" }], timestamp: 1 },
  ];
  const session = { sessionFile: "A/old.jsonl", sessionId: "same-session", isStreaming: false };
  let runtimeCwd = "A";
  send = async (command) => {
    if (command.type === "get_state") return { data: session };
    if (command.type === "get_messages") return { data: { messages } };
    if (command.type === "prompt" && command.message === "/ompd-workspace") {
      store.getState().applyFrame({
        type: "extension_ui_request", method: "setStatus",
        statusKey: "ompd:workspace", statusText: runtimeCwd,
      });
      store.getState().applyFrame({
        type: "prompt_result", id: command.id, agentInvoked: false,
        status: "completed", sessionSettled: true,
      });
    }
    return {};
  };
  await store.getState().refreshAll();
  runtimeCwd = "B";
  store.getState().applyFrame({
    type: "prompt_result", id: "user-wt", agentInvoked: false,
    status: "completed", sessionSettled: true,
  });
  await store.getState().refreshAll();
  expect(store.getState().cwd).toBe("B");
  expect(store.getState().session?.sessionId).toBe("same-session");
  expect(store.getState().messages).toEqual(messages);
  expect(starts).toEqual([]);
  for (const list of lists) list.result.resolve(list.cwd === "A" ? oldListing : newListing);
});

test("an internal workspace query completion cannot stop an active agent turn", () => {
  store.setState({ busy: true });
  store.getState().applyFrame({
    type: "prompt_result", id: "ompd-workspace-123", agentInvoked: false,
    status: "completed", sessionSettled: true,
  });
  expect(store.getState().busy).toBe(true);
  expect(lists).toEqual([]);
});

test("slash command errors are visible without changing the current workspace", () => {
  const output = "Worktree creation failed: Branch 'test' already exists; pick another name.";
  const message = `Error: ${output}`;
  store.getState().applyFrame({ type: "command_output", text: output });
  expect(store.getState().notifications).toMatchObject([{ kind: "error", message }]);
  expect(store.getState().notices).toMatchObject([{ kind: "error", message }]);
  expect(store.getState().cwd).toBe("A");
  expect(store.getState().sessionListing).toEqual(oldListing);
});

test("informational command output is retained without an error notification", () => {
  store.getState().applyFrame({ type: "command_output", text: "Moved to worktree B on branch feature." });
  expect(store.getState().notifications).toEqual([]);
  expect(store.getState().notices).toMatchObject([{ kind: "info", message: "Moved to worktree B on branch feature." }]);
});
function forkState() {
  const image: ImageContent = { type: "image", mimeType: "image/png", data: "attachment" };
  const original: AgentMessage = { role: "user", content: [{ type: "text", text: "original" }, image], timestamp: 1 };
  const answer: AgentMessage = { role: "assistant", content: [{ type: "text", text: "original answer" }], timestamp: 2 };
  const tree: SessionTree = {
    tree: [{
      entry: { type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: original },
      children: [{
        entry: { type: "message", id: "answer", parentId: "user", timestamp: "2026-01-01T00:00:02Z", message: answer },
        children: [],
      }],
    }],
    leafId: "answer",
  };
  store.setState({
    messages: [original, answer],
    sessionTree: tree,
    messageBranches: [{ entryId: "user", alternatives: [{ entryId: "user", leafId: "answer" }], index: 0 }, undefined],
  });
  return { original, answer, image, tree };
}

function entryResponse(tree: SessionTree) {
  return { entries: tree.tree.flatMap((node) => [node.entry, ...node.children.map((child) => child.entry)]), leafId: tree.leafId };
}

test("a cancelled fork preserves the current conversation and never submits the edit", async () => {
  const { original, answer } = forkState();
  send = async (command) => {
    if (command.type !== "navigate_tree") throw new Error("Cancelled navigation must not submit");
    return { data: { cancelled: true } };
  };
  expect(await store.getState().forkMessage("user", "edited")).toBe(false);
  expect(store.getState()).toMatchObject({ messages: [original, answer], branching: false, busy: false });
  expect(store.getState().notifications).toMatchObject([{ kind: "warning", message: "Conversation branch change was cancelled." }]);
});

test("fork navigation locks submissions and preserves attachments on the new branch", async () => {
  const { image, tree } = forkState();
  const navigation = Promise.withResolvers<{ data: { cancelled: boolean } }>();
  const edited: AgentMessage = { role: "user", content: [{ type: "text", text: "edited" }, image], timestamp: 3 };
  tree.tree.push({
    entry: { type: "message", id: "edited", parentId: null, timestamp: "2026-01-01T00:00:03Z", message: edited },
    children: [],
  });
  let submitted: RpcCommand | undefined;
  send = async (command) => {
    if (command.type === "navigate_tree") return navigation.promise;
    if (command.type === "prompt") {
      submitted = command;
      tree.leafId = "edited";
      return { data: { agentInvoked: false } };
    }
    if (command.type === "get_messages") return { data: { messages: [edited] } };
    if (command.type === "get_entries") return { data: entryResponse(tree) };
    return {};
  };
  const fork = store.getState().forkMessage("user", "edited");
  expect(store.getState().branching).toBe(true);
  expect(await store.getState().prompt("unrelated")).toBe(false);
  expect(await store.getState().switchBranch("answer")).toBe(false);
  expect(submitted).toBeUndefined();
  navigation.resolve({ data: { cancelled: false } });
  expect(await fork).toBe(true);
  expect(submitted).toMatchObject({ type: "prompt", message: "edited", images: [image] });
  expect(store.getState()).toMatchObject({ branching: false, messages: [edited] });
  expect(store.getState().messageBranches[0]).toMatchObject({ entryId: "edited", index: 1 });
});

test("failed fork submission restores an editable draft with its attachments", async () => {
  const { tree, image } = forkState();
  send = async (command) => {
    if (command.type === "navigate_tree") return { data: { cancelled: false } };
    if (command.type === "prompt") throw new Error("Provider unavailable");
    if (command.type === "get_messages") return { data: { messages: [] } };
    if (command.type === "get_entries") return { data: entryResponse({ ...tree, leafId: null }) };
    return {};
  };
  expect(await store.getState().forkMessage("user", "retry this")).toBe(false);
  expect(store.getState()).toMatchObject({
    branching: false, busy: false, messages: [], editorText: "retry this", editorImages: [image],
  });
  expect(store.getState().notifications).toMatchObject([{ kind: "error", message: "Conversation branch failed: Provider unavailable" }]);
});

test("branch switching restores a saved tail without submitting another prompt", async () => {
  const { tree, original, answer } = forkState();
  const other: AgentMessage = { role: "user", content: "other", timestamp: 3 };
  store.setState({
    messages: [other],
    messageBranches: [{ entryId: "other", alternatives: [{ entryId: "user", leafId: "answer" }, { entryId: "other", leafId: "other" }], index: 1 }],
  });
  send = async (command) => {
    if (command.type === "prompt") throw new Error("Switching must not regenerate");
    if (command.type === "navigate_tree") return { data: { cancelled: false } };
    if (command.type === "get_messages") return { data: { messages: [original, answer] } };
    if (command.type === "get_entries") return { data: entryResponse(tree) };
    return {};
  };
  expect(await store.getState().switchBranch("answer")).toBe(true);
  expect(store.getState()).toMatchObject({ messages: [original, answer], branching: false });
  expect(store.getState().messageBranches[0]?.entryId).toBe("user");
});

test("delayed branch metadata never blocks transcript hydration or ordinary prompts", async () => {
  const { tree, original, answer } = forkState();
  store.setState({ messages: [], sessionTree: undefined, messageBranches: [] });
  const entries = Promise.withResolvers<{ data: SessionEntries }>();
  send = async (command) => {
    if (command.type === "get_entries") return entries.promise;
    if (command.type === "get_messages") return { data: { messages: [original, answer] } };
    if (command.type === "get_state") return { data: { sessionName: "Regression", isStreaming: false } };
    return {};
  };
  const hydration = store.getState().refreshAll();
  const branches = store.getState().refreshTree();
  try {
    await hydration;
    expect(store.getState()).toMatchObject({ messages: [original, answer], treeLoading: true });
    expect(await store.getState().prompt("a normal follow-up")).toBe(true);
  } finally {
    entries.resolve({ data: entryResponse(tree) });
    await branches;
  }
  expect(store.getState().treeLoading).toBe(false);
  expect(store.getState().messageBranches[0]?.entryId).toBe("user");
});

test("partial tool images display before message hydration and final content replaces them", () => {
  const image: ImageContent = { type: "image", mimeType: "image/png", data: "AA==" };
  store.getState().applyFrame({
    type: "tool_execution_update", toolCallId: "image-tool", toolName: "read",
    partialResult: { content: [image] },
  });
  expect(store.getState().toolRuns["image-tool"].images).toEqual([image]);
  store.getState().applyFrame({
    type: "tool_execution_end", toolCallId: "image-tool", toolName: "read", isError: false,
    result: { content: [{ type: "text", text: "No final image" }] },
  });
  expect(store.getState().toolRuns["image-tool"].images).toEqual([]);
});
