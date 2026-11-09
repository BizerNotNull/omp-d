import { beforeEach, expect, mock, test } from "bun:test";

let starts: PromiseWithResolvers<{ cwd: string }>[] = [];
let lists: { cwd: string; result: PromiseWithResolvers<{ path: string; title: string }[]> }[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: { cwd: string }) => {
    if (command === "list_sessions") {
      const result = Promise.withResolvers<{ path: string; title: string }[]>();
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
    send: async () => ({}),
  },
}));
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {} },
});
Object.assign(globalThis, { document: { title: "" }, window: { setTimeout: () => 0 } });
// Import after installing transport mocks and globals required at module initialization.
const { useAppStore: store } = await import("../src/lib/omp/store");
const oldSession = { path: "A/old.jsonl", title: "Old folder" };
const newSession = { path: "B/new.jsonl", title: "New folder" };

beforeEach(() => {
  starts = [];
  lists = [];
  store.setState(store.getInitialState(), true);
  store.setState({ cwd: "A", sessions: [oldSession], status: "ready" });
});

test("switching clears old sessions during startup and ignores an old folder response", async () => {
  const oldLoad = store.getState().loadSessions();
  const connecting = store.getState().connect("B");
  expect(store.getState()).toMatchObject({ cwd: "B", sessions: [], sessionsLoading: true });
  lists[0].result.resolve([oldSession]);
  await oldLoad;
  expect(store.getState()).toMatchObject({ sessions: [], sessionsLoading: true });

  starts[0].resolve({ cwd: "B" });
  while (lists.length < 2) await Promise.resolve();
  expect(lists[1].cwd).toBe("B");
  lists[1].result.resolve([newSession]);
  await connecting;
  expect(store.getState()).toMatchObject({ sessions: [newSession], sessionsLoading: false });
});

test("an obsolete folder failure cannot clear loading or show a warning", async () => {
  const oldLoad = store.getState().loadSessions();
  const connecting = store.getState().connect("B");
  lists[0].result.reject(new Error("Old folder failed"));
  await oldLoad;
  expect(store.getState()).toMatchObject({ sessions: [], sessionsLoading: true, notifications: [] });
  starts[0].reject(new Error("Agent failed"));
  await connecting;
  expect(store.getState()).toMatchObject({ status: "error", sessions: [], sessionsLoading: false });
});

test("the latest list request wins even when older requests finish last", async () => {
  const older = store.getState().loadSessions();
  const newer = store.getState().loadSessions();
  lists[1].result.resolve([newSession]);
  await newer;
  lists[0].result.resolve([oldSession]);
  await older;
  expect(store.getState()).toMatchObject({ sessions: [newSession], sessionsLoading: false });
});

test("a current list failure ends loading and reports the failure", async () => {
  const loading = store.getState().loadSessions();
  lists[0].result.reject(new Error("Access denied"));
  await loading;
  expect(store.getState().sessionsLoading).toBe(false);
  expect(store.getState().notifications).toMatchObject([{ kind: "warning", message: "Session list failed: Access denied" }]);
});
