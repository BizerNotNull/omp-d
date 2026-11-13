import { expect, mock, test } from "bun:test";

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
const commands: Array<{ generation: number; command: Record<string, unknown> }> = [];
const stopped: number[] = [];
let generation = 0;
let acknowledgePrompt: (() => void) | undefined;
const storage = new Map<string, string>([["ompd:lastCwd", "D:/project"]]);
Object.assign(globalThis, {
  window: globalThis,
  document: { title: "" },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

function emit(name: string, payload: unknown) {
  for (const callback of listeners.get(name) ?? []) callback({ payload });
}
function frame(owner: number, value: Record<string, unknown>) {
  emit("omp://frame", { generation: owner, frame: value });
}

mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    const callbacks = listeners.get(name) ?? new Set();
    callbacks.add(callback);
    listeners.set(name, callbacks);
    return () => callbacks.delete(callback);
  },
}));
mock.module("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: { generation: number; command: { type: string; id: string } & Record<string, unknown>; options: { cwd: string } }) => {
    if (name === "start_agent") {
      const owner = ++generation;
      // Exercise ready-before-invoke resolution for simultaneous clients.
      frame(owner, { type: "ready", protocolVersion: 1 });
      return { generation: owner, pid: owner, cwd: args.options.cwd, program: "omp", args: [] };
    }
    if (name === "stop_agent") { stopped.push(args.generation); return; }
    if (name === "list_sessions") return { repositoryCwd: "D:/project", directories: [] };
    if (name === "model_catalog") return [];
    if (name === "model_roles") return {};
    if (name !== "rpc_send") throw new Error(`Unexpected invoke: ${name}`);
    const { generation: owner, command } = args;
    commands.push(args);
    const respond = (data?: unknown) => frame(owner, { type: "response", id: command.id, command: command.type, success: true, data });
    switch (command.type) {
      case "prompt":
        if (!command.id.startsWith("ompd-workspace-")) { acknowledgePrompt = () => respond({ agentInvoked: true }); return; }
        break;
      case "get_state":
        respond({ sessionId: `session-${owner}`, sessionFile: `D:/sessions/${owner}.jsonl`, sessionName: `Session ${owner}`, isStreaming: owner === 1, messageCount: 1 });
        return;
      case "get_messages": respond({ messages: [] }); return;
      case "get_entries": respond({ entries: [], leafId: null }); return;
      case "get_available_thinking_levels": respond({ levels: [] }); return;
      case "get_available_commands": respond({ commands: [] }); return;
      case "extension_ui_response": return;
    }
    respond({});
  },
}));

test("switching retains background execution, drafts, dialogs and command ownership", async () => {
  // Load after installing the transport mocks; a static import runs too early.
  const { useAppStore } = await import("../src/lib/omp/store");
  await useAppStore.getState().bootstrap();
  const first = useAppStore.getState();
  first.setDraftText("first draft");
  const prompt = first.prompt("Continue working");
  expect(first.activeRuntimeId).toBe(1);
  await first.newSession();
  const second = useAppStore.getState();
  expect(second.activeRuntimeId).toBe(2);
  expect(second.draftText).toBe("");
  second.setDraftText("second draft");
  expect(stopped).toEqual([]);
  const message = { role: "assistant", content: [{ type: "text", text: "background output" }], timestamp: 1 };
  frame(1, { type: "message_start", messageId: "background", message });
  frame(1, { type: "extension_ui_request", method: "confirm", id: "same-id", title: "First confirmation" });
  frame(2, { type: "extension_ui_request", method: "confirm", id: "same-id", title: "Second confirmation" });
  expect(useAppStore.getState().pending).toEqual([]);
  expect(useAppStore.getState().dialogs[0].title).toBe("Second confirmation");
  expect(useAppStore.getState().openSessions.find((entry) => entry.id === 1)).toMatchObject({ busy: true, dialogs: 1 });
  await second.switchSession("D:\\sessions\\1.jsonl");
  expect(generation).toBe(2);
  expect(useAppStore.getState().activeRuntimeId).toBe(1);
  expect(useAppStore.getState().pending[0].message).toEqual(message);
  expect(useAppStore.getState().draftText).toBe("first draft");
  expect(useAppStore.getState().dialogs[0].title).toBe("First confirmation");
  await useAppStore.getState().answerDialog("same-id", { confirmed: true });
  expect(commands.at(-1)).toMatchObject({ generation: 1, command: { type: "extension_ui_response", id: "same-id" } });
  useAppStore.getState().selectRuntime(2);
  expect(useAppStore.getState().dialogs[0].title).toBe("Second confirmation");
  expect(useAppStore.getState().draftText).toBe("second draft");
  acknowledgePrompt!();
  expect(await prompt).toBe(true);
  expect(useAppStore.getState().activeRuntimeId).toBe(2);
  await second.disconnect();
  expect(stopped).toEqual([2]);
  useAppStore.getState().selectRuntime(1);
  expect(useAppStore.getState().status).toBe("ready");
  expect(useAppStore.getState().busy).toBe(true);
  await useAppStore.getState().disconnect();
});
