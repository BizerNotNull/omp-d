import { expect, mock, test } from "bun:test";

const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
const commands: Array<{ generation: number; command: Record<string, unknown> }> = [];
const stopped: number[] = [];
let generation = 0;
let acknowledgePrompt: (() => void) | undefined;
let finishImageDrop: ((images: ({ mimeType: string; data: string } | null)[]) => void) | undefined;
const restoredPaths = new Map<number, string>();
const storage = new Map<string, string>([["ompd:lastCwd", "D:/project"]]);
Object.assign(globalThis, {
  window: globalThis,
  document: { title: "" },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
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
  isTauri: () => false,
  invoke: async (name: string, args: { generation: number; command: { type: string; id: string } & Record<string, unknown>; options: { cwd: string } }) => {
    if (name === "attach_frontend") return 1;
    if (name === "start_agent") {
      const owner = ++generation;
      // Exercise ready-before-invoke resolution for simultaneous clients.
      frame(owner, { type: "ready", protocolVersion: 1 });
      return { generation: owner, pid: owner, cwd: args.options.cwd, program: "omp", args: [] };
    }
    if (name === "stop_agent") { stopped.push(args.generation); return; }
    if (name === "list_sessions") return { repositoryCwd: "D:/project", directories: [], sessions: [] };
    if (name === "model_catalog") return [];
    if (name === "model_roles") return {};
    if (name === "read_dropped_images") {
      const { promise, resolve } = Promise.withResolvers<({ mimeType: string; data: string } | null)[]>();
      finishImageDrop = resolve;
      return promise;
    }
    if (name !== "rpc_send") throw new Error(`Unexpected invoke: ${name}`);
    const { generation: owner, command } = args;
    commands.push(args);
    const respond = (data?: unknown) => frame(owner, { type: "response", id: command.id, command: command.type, success: true, data });
    switch (command.type) {
      case "prompt":
        if (!command.id.startsWith("ompd-workspace-")) { acknowledgePrompt = () => respond({ agentInvoked: true }); return; }
        break;
      case "switch_session":
        restoredPaths.set(owner, String(command.sessionPath));
        respond({ cancelled: false });
        return;
      case "get_state":
        respond({ sessionId: `session-${owner}`, sessionFile: restoredPaths.get(owner) ?? `D:/sessions/${owner}.jsonl`, sessionName: `Session ${owner}`, isStreaming: owner === 1, messageCount: 1 });
        return;
      case "get_messages": respond({ messages: [{ role: "user", content: "Existing conversation", timestamp: 1 }] }); return;
      case "get_entries": respond({ entries: [], leafId: null }); return;
      case "get_available_thinking_levels": respond({ levels: [] }); return;
      case "get_available_commands": respond({ commands: [] }); return;
      case "extension_ui_response": return;
    }
    respond({});
  },
}));

// Load after installing the transport mocks; a static import runs too early.
const { useAppStore } = await import("../src/lib/omp/store");

test("switching retains background execution, drafts, dialogs and command ownership", async () => {
  await useAppStore.getState().bootstrap();
  const first = useAppStore.getState();
  const firstOwner = first.startInfo!.generation;
  first.setDraftText("Continue working");
  const prompt = first.prompt();
  first.setDraftText("first draft");
  await first.newSession();
  const second = useAppStore.getState();
  const secondOwner = second.startInfo!.generation;
  expect(second.activeRuntimeId).not.toBe(first.activeRuntimeId);
  expect(second.draftText).toBe("");
  second.setDraftText("second draft");
  expect(stopped).not.toContain(firstOwner);
  const message = { role: "assistant", content: [{ type: "text", text: "background output" }], timestamp: 1 };
  frame(firstOwner, { type: "message_start", messageId: "background", message });
  frame(firstOwner, { type: "extension_ui_request", method: "confirm", id: "same-id", title: "First confirmation" });
  frame(secondOwner, { type: "extension_ui_request", method: "confirm", id: "same-id", title: "Second confirmation" });
  expect(useAppStore.getState().pending).toEqual([]);
  expect(useAppStore.getState().dialogs[0].title).toBe("Second confirmation");
  expect(useAppStore.getState().openSessions.find((entry) => entry.id === first.activeRuntimeId)).toMatchObject({ busy: true, dialogs: 1 });
  await second.switchSession("D:\\sessions\\1.jsonl");
  expect(useAppStore.getState().startInfo?.generation).toBe(firstOwner);
  expect(useAppStore.getState().activeRuntimeId).toBe(first.activeRuntimeId);
  expect(useAppStore.getState().pending[0].message).toEqual(message);
  expect(useAppStore.getState().draftText).toBe("first draft");
  expect(useAppStore.getState().dialogs[0].title).toBe("First confirmation");
  await useAppStore.getState().answerDialog("same-id", { confirmed: true });
  expect(commands.at(-1)).toMatchObject({ generation: firstOwner, command: { type: "extension_ui_response", id: "same-id" } });
  useAppStore.getState().selectRuntime(second.activeRuntimeId);
  expect(useAppStore.getState().dialogs[0].title).toBe("Second confirmation");
  expect(useAppStore.getState().draftText).toBe("second draft");
  acknowledgePrompt!();
  await prompt;
  expect(useAppStore.getState().activeRuntimeId).toBe(second.activeRuntimeId);
  await second.disconnect();
  expect(stopped).toContain(secondOwner);
  expect(stopped).not.toContain(firstOwner);
  useAppStore.getState().selectRuntime(first.activeRuntimeId);
  expect(useAppStore.getState().status).toBe("ready");
  expect(useAppStore.getState().busy).toBe(true);
  await useAppStore.getState().disconnect();
});

test.each([
  ["\\\\?\\D:\\sessions\\saved.jsonl", "d:/sessions/saved.jsonl"],
  ["\\\\?\\UNC\\Server\\Share\\saved.jsonl", "//server/share/saved.jsonl"],
])("reopening %s reuses one runtime during and after restore", async (verbatim, listed) => {
  const get = useAppStore.getState;
  const original = get().activeRuntimeId;
  const previous = get().openSessions.length;
  const commandStart = commands.length;

  const restoring = get().switchSession(verbatim, "D:/project");
  const selected = get().activeRuntimeId;
  await Promise.all([restoring, get().switchSession(listed, "D:/project")]);
  expect(get().activeRuntimeId).toBe(selected);
  expect(get().session?.sessionFile).toBe(verbatim);

  get().setDraftText("Keep this draft when reopening");
  get().selectRuntime(original);
  await get().switchSession(listed, "D:/project");
  expect(get().activeRuntimeId).toBe(selected);
  expect(get().draftText).toBe("Keep this draft when reopening");
  expect(get().openSessions).toHaveLength(previous + 1);
  expect(commands.slice(commandStart).filter(({ command }) => command.type === "switch_session"))
    .toHaveLength(1);
  await get().disconnect();
});

test("image drops finish in the originating draft and can be sent without text", async () => {
  const get = useAppStore.getState;
  const original = get().activeRuntimeId;
  await get().switchSession("D:/sessions/drop.jsonl", "D:/project");
  const origin = get();
  const image = { mimeType: "image/png", data: "AQID" };
  const missing = "D:\\test files\\bad`image.png";
  try {
    const loading = origin.readDroppedImages(["D:\\image.png", missing]);
    origin.setDraftText("Existing draft");
    const before = commands.length;
    const blocked = origin.prompt();
    expect(commands).toHaveLength(before);
    await blocked;
    get().selectRuntime(original);
    const otherDraft = get().draftText;
    finishImageDrop!([image, null]);
    await loading;
    expect(get().draftText).toBe(otherDraft);
    expect(get().draftImages).toEqual([]);

    get().selectRuntime(origin.activeRuntimeId);
    expect(get().draftText).toBe("Existing draft ``D:\\test files\\bad`image.png``");
    expect(get().draftImages).toEqual([{ type: "image", ...image }]);
    origin.setDraftText("");
    const sent = origin.prompt();
    expect(commands.at(-1)).toMatchObject({
      generation: origin.startInfo!.generation,
      command: { type: "prompt", message: "", images: [{ type: "image", ...image }] },
    });
    acknowledgePrompt!();
    await sent;
  } finally {
    await origin.disconnect();
  }
});
