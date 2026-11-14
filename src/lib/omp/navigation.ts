import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { SessionListing, SessionSummary } from "./types";

export type SessionView = "recent" | "running" | "pinned";

/** Windows paths are case insensitive; Unix paths are not. */
export function sessionPathKey(path: string | undefined): string {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

interface NavigationPreferences {
  view: SessionView;
  worktreeScope: string;
  query: string;
  pinnedSessions: string[];
  pinnedWorktrees: string[];
  recentWorktrees: string[];
  lastSessionByWorktree: Record<string, string>;
  scrollPositionByScope: Record<string, number>;
}

export interface SessionNavigationState extends NavigationPreferences {
  repositoryCwd?: string;
  sessionListing?: SessionListing;
  sessionsLoading: boolean;
  error?: string;
  setView: (view: SessionView) => void;
  setWorktreeScope: (scope: string) => void;
  setQuery: (query: string) => void;
  toggleSessionPin: (path: string) => void;
  toggleWorktreePin: (cwd: string) => void;
  rememberScroll: (key: string, offset: number) => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  selectWorktree: (scope: string) => Promise<void>;
}

const STORAGE_KEY = "ompd:sessionNavigation";
const defaults: NavigationPreferences = {
  view: "recent", worktreeScope: "all", query: "", pinnedSessions: [], pinnedWorktrees: [],
  recentWorktrees: [], lastSessionByWorktree: {}, scrollPositionByScope: {},
};
function preferences(): NavigationPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    const record = <T,>(value: unknown, kind: "string" | "number"): Record<string, T> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === kind)) : {};
    return {
      view: ["recent", "running", "pinned"].includes(saved.view) ? saved.view : "recent",
      worktreeScope: typeof saved.worktreeScope === "string" ? saved.worktreeScope : "all",
      query: typeof saved.query === "string" ? saved.query : "",
      pinnedSessions: strings(saved.pinnedSessions), pinnedWorktrees: strings(saved.pinnedWorktrees),
      recentWorktrees: strings(saved.recentWorktrees),
      lastSessionByWorktree: record<string>(saved.lastSessionByWorktree, "string"),
      scrollPositionByScope: record<number>(saved.scrollPositionByScope, "number"),
    };
  } catch { return defaults; }
}

// Runtime integration is injected after facade initialization: neither store imports the other.
let runtimeActions: {
  newSession: (cwd: string) => Promise<void>;
  switchSession: (path: string, cwd: string) => Promise<void>;
  selectOpenSession: (cwd: string, path?: string) => boolean;
} | undefined;
export function configureSessionNavigation(actions: NonNullable<typeof runtimeActions>) {
  runtimeActions = actions;
}

const pages = new Map<string, SessionListing>();
const requests = new Map<string, number>();
let selectionRequest = 0;
let searchTimer: number | undefined;
function cacheKey(state: SessionNavigationState): string {
  return JSON.stringify([sessionPathKey(state.repositoryCwd), sessionPathKey(state.worktreeScope),
    state.query.trim(), state.view, [...state.pinnedSessions].map(sessionPathKey).sort()]);
}
function toggle(paths: string[], path: string): string[] {
  const key = sessionPathKey(path);
  return paths.some((entry) => sessionPathKey(entry) === key)
    ? paths.filter((entry) => sessionPathKey(entry) !== key) : [...paths, path];
}
function sorted(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.sort((a, b) => b.modifiedMs - a.modifiedMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function activateFilters() {
  window.clearTimeout(searchTimer);
  const state = useSessionNavigation.getState();
  const metadata = sessionPathKey(state.sessionListing?.repositoryCwd) === sessionPathKey(state.repositoryCwd)
    ? state.sessionListing : undefined;
  useSessionNavigation.setState({
    sessionListing: pages.get(cacheKey(state)) ?? (metadata ? { ...metadata, sessions: [], nextCursor: null } : undefined),
    sessionsLoading: false,
    error: undefined,
  });
  if (state.query.trim()) {
    useSessionNavigation.setState({ sessionsLoading: true });
    searchTimer = window.setTimeout(() => { void fetchPage(false); }, 200);
  } else {
    void fetchPage(false);
  }
}
async function fetchPage(more: boolean): Promise<void> {
  const state = useSessionNavigation.getState();
  if (!state.repositoryCwd) return;
  const key = cacheKey(state);
  const cached = pages.get(key);
  if (more && (!cached?.nextCursor || state.sessionsLoading)) return;
  const request = (requests.get(key) ?? 0) + 1;
  requests.set(key, request);
  useSessionNavigation.setState({ sessionsLoading: true, error: undefined });
  try {
    const sessions = new Map<string, SessionSummary>();
    if (more) for (const session of cached?.sessions ?? []) sessions.set(sessionPathKey(session.path), session);
    const boundary = cached?.sessions[cached.sessions.length - 1];
    let cursor = more ? cached?.nextCursor : undefined;
    let result: SessionListing;
    // Refresh through the previous deepest row, not merely the previous row count:
    // inserted sessions must not push retained history behind the refreshed cursor.
    do {
      result = await invoke<SessionListing>("list_sessions", {
        cwd: state.repositoryCwd,
        limit: more ? 50 : Math.max(50, cached?.sessions.length ?? 0),
        cursor,
        scope: state.query.trim() || state.worktreeScope === "all" ? undefined : state.worktreeScope,
        query: state.query.trim() || undefined,
        paths: state.view === "pinned" ? state.pinnedSessions : undefined,
      });
      if (requests.get(key) !== request) return;
      for (const session of result.sessions) sessions.set(sessionPathKey(session.path), session);
      cursor = result.nextCursor;
    } while (!more && boundary && cursor &&
      (cursor.modifiedMs > boundary.modifiedMs ||
        (cursor.modifiedMs === boundary.modifiedMs && cursor.path < boundary.path)));
    const listing = { ...result, sessions: sorted([...sessions.values()]) };
    pages.set(key, listing);
    // The first response resolves a project folder to its repository root.
    const resolvedKey = cacheKey({ ...state, repositoryCwd: result.repositoryCwd });
    pages.set(resolvedKey, listing);
    if (cacheKey(useSessionNavigation.getState()) === key) {
      useSessionNavigation.setState({ repositoryCwd: result.repositoryCwd, sessionListing: listing, sessionsLoading: false });
    }
  } catch (error) {
    if (requests.get(key) === request && cacheKey(useSessionNavigation.getState()) === key) {
      useSessionNavigation.setState({ sessionsLoading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const useSessionNavigation = create<SessionNavigationState>()((set, get) => ({
  ...preferences(), sessionsLoading: false,
  setView: (view) => { set({ view }); activateFilters(); },
  setWorktreeScope: (worktreeScope) => { ++selectionRequest; set({ worktreeScope }); activateFilters(); },
  setQuery: (query) => { set({ query }); activateFilters(); },
  toggleSessionPin: (path) => {
    set({ pinnedSessions: toggle(get().pinnedSessions, path) });
    activateFilters();
  },
  toggleWorktreePin: (cwd) => set({ pinnedWorktrees: toggle(get().pinnedWorktrees, cwd) }),
  rememberScroll: (key, offset) => set({ scrollPositionByScope: { ...get().scrollPositionByScope, [key]: offset } }),
  loadMore: () => fetchPage(true),
  refresh: () => fetchPage(false),
  selectWorktree: async (scope) => {
    get().setWorktreeScope(scope);
    const request = selectionRequest;
    if (scope === "all") return;
    set({ recentWorktrees: [scope, ...get().recentWorktrees.filter((cwd) => sessionPathKey(cwd) !== sessionPathKey(scope))].slice(0, 30) });
    const remembered = get().lastSessionByWorktree[sessionPathKey(scope)];
    if (runtimeActions?.selectOpenSession(scope, remembered)) return;
    try {
      let session: SessionSummary | undefined;
      if (remembered) {
        const listing = await invoke<SessionListing>("list_sessions", { cwd: get().repositoryCwd ?? scope, scope, paths: [remembered], limit: 1 });
        session = listing.sessions[0];
      }
      if (!session) {
        const listing = await invoke<SessionListing>("list_sessions", { cwd: get().repositoryCwd ?? scope, scope, limit: 1 });
        session = listing.sessions[0];
      }
      if (request !== selectionRequest) return;
      if (session) await runtimeActions?.switchSession(session.path, session.cwd);
      else await runtimeActions?.newSession(scope);
    } catch (error) {
      if (request === selectionRequest) set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
}));

let serializedPreferences = "";
useSessionNavigation.subscribe((state) => {
  const { view, worktreeScope, query, pinnedSessions, pinnedWorktrees, recentWorktrees, lastSessionByWorktree, scrollPositionByScope } = state;
  const serialized = JSON.stringify({ view, worktreeScope, query, pinnedSessions, pinnedWorktrees, recentWorktrees, lastSessionByWorktree, scrollPositionByScope });
  if (serialized === serializedPreferences) return;
  serializedPreferences = serialized;
  try { localStorage.setItem(STORAGE_KEY, serialized); } catch { /* Navigation remains available when storage is full. */ }
});

/** Session selection preserves list navigation; a different project starts unscoped. */
export function rememberActiveSession(cwd: string, path?: string) {
  const state = useSessionNavigation.getState();
  const key = sessionPathKey(cwd);
  const knownProject = state.sessionListing?.directories.some((entry) => sessionPathKey(entry.cwd) === key)
    || sessionPathKey(state.repositoryCwd) === key;
  const repositoryCwd = knownProject || (state.repositoryCwd && !state.sessionListing) ? state.repositoryCwd : cwd;
  const changedProject = sessionPathKey(repositoryCwd) !== sessionPathKey(state.repositoryCwd);
  const recentWorktrees = state.recentWorktrees[0] && sessionPathKey(state.recentWorktrees[0]) === key
    ? state.recentWorktrees : [cwd, ...state.recentWorktrees.filter((entry) => sessionPathKey(entry) !== key)].slice(0, 30);
  const lastSessionByWorktree = path && state.lastSessionByWorktree[key] !== path
    ? { ...state.lastSessionByWorktree, [key]: path } : state.lastSessionByWorktree;
  if (changedProject || recentWorktrees !== state.recentWorktrees || lastSessionByWorktree !== state.lastSessionByWorktree) {
    useSessionNavigation.setState({ repositoryCwd, recentWorktrees, lastSessionByWorktree,
      worktreeScope: changedProject ? "all" : state.worktreeScope });
  }
  if (changedProject) activateFilters();
}
