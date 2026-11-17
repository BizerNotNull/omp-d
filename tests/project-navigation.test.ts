import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionListing } from "../src/lib/omp/types";

const storage = new Map<string, string>();
Object.assign(globalThis, {
  window: globalThis,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});
const listing: SessionListing = {
  repositoryCwd: "D:/beta",
  directories: [{ cwd: "D:/beta", isWorktree: false }, { cwd: "D:/trees/beta-task", isWorktree: true }],
  sessions: [],
};
let fail = false;
let resolving: PromiseWithResolvers<void> | undefined;
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: async () => {
    if (resolving) await resolving.promise;
    if (fail) throw new Error("Project folder unavailable");
    return listing;
  },
}));
const { configureSessionNavigation, rememberActiveSession, useSessionNavigation: navigation } = await import("../src/lib/omp/navigation");
const selected: { cwd: string; path?: string }[] = [];

beforeEach(() => {
  fail = false;
  resolving = undefined;
  selected.length = 0;
  storage.clear();
  navigation.setState({
    ...navigation.getInitialState(), repositoryCwd: "D:/alpha",
    sessionListing: { repositoryCwd: "D:/alpha", directories: [{ cwd: "D:/alpha", isWorktree: false }], sessions: [] },
    recentProjects: ["D:/alpha"], recentWorktrees: ["D:/alpha"],
    lastWorktreeByProject: { "d:/beta": "D:/trees/beta-task" },
    lastSessionByWorktree: { "d:/trees/beta-task": "D:/sessions/beta.jsonl" },
  }, true);
  configureSessionNavigation({
    selectOpenSession: (cwd, path) => { selected.push({ cwd, path }); rememberActiveSession(cwd, path); return true; },
    newSession: async () => { throw new Error("Must reuse the existing session"); },
    switchSession: async () => { throw new Error("Must reuse the existing session"); },
  });
});

test("returning to a project restores its worktree and session and persists repository roots", async () => {
  await navigation.getState().selectProject("d:\\BETA");
  expect(selected).toEqual([{ cwd: "D:/trees/beta-task", path: "D:/sessions/beta.jsonl" }]);
  expect(navigation.getState().repositoryCwd).toBe("D:/beta");
  expect(navigation.getState().worktreeScope).toBe("D:/trees/beta-task");
  expect(navigation.getState().recentProjects).toEqual(["D:/beta", "D:/alpha"]);
  const saved = JSON.parse(storage.get("ompd:sessionNavigation")!);
  expect(saved.lastWorktreeByProject["d:/beta"]).toBe("D:/trees/beta-task");
  expect(saved.recentProjects).toEqual(["D:/beta", "D:/alpha"]);
});

test("an unavailable project preserves the selected project and reports the failure", async () => {
  fail = true;
  await navigation.getState().selectProject("D:/missing");
  expect(navigation.getState().repositoryCwd).toBe("D:/alpha");
  expect(navigation.getState().sessionListing?.repositoryCwd).toBe("D:/alpha");
  expect(navigation.getState().error).toBe("Project folder unavailable");
  expect(navigation.getState().switchingProject).toBeUndefined();
  expect(selected).toEqual([]);
});

test("a background runtime publication cannot redirect an in-flight project selection", async () => {
  resolving = Promise.withResolvers<void>();
  configureSessionNavigation({
    selectOpenSession: (cwd, path) => {
      rememberActiveSession("D:/alpha", "D:/sessions/alpha.jsonl");
      expect(navigation.getState().repositoryCwd).toBe("D:/beta");
      selected.push({ cwd, path });
      rememberActiveSession(cwd, path);
      return true;
    },
    newSession: async () => {}, switchSession: async () => {},
  });
  const opening = navigation.getState().selectProject("D:/beta");
  resolving.resolve();
  await opening;
  expect(navigation.getState().repositoryCwd).toBe("D:/beta");
  expect(selected).toEqual([{ cwd: "D:/trees/beta-task", path: "D:/sessions/beta.jsonl" }]);
});
