import { invoke } from "@/lib/diagnostics";
import { create } from "zustand";
import type { SessionListing, SessionSummary } from "./types";

export type SessionView = "recent" | "running" | "pinned";

/** Windows paths are case insensitive; Unix paths are not. */
export function sessionPathKey(path: string | undefined): string {
  if (!path) return "";
  let normalized = path.replace(/\\/g, "/");
  // omp can report verbatim Windows paths; native listings use ordinary paths.
  if (normalized.startsWith("//?/")) {
    const unprefixed = normalized.slice(4);
    if (/^[a-z]:\//i.test(unprefixed)) normalized = unprefixed;
    else if (/^unc\//i.test(unprefixed)) normalized = `//${unprefixed.slice(4)}`;
  }
  normalized = normalized.replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

interface NavigationPreferences {
  view: SessionView;
  worktreeScope: string;
  query: string;
  pinnedSessions: string[];
  pinnedWorktrees: string[];
  recentWorktrees: string[];
  recentProjects: string[];
  lastWorktreeByProject: Record<string, string>;
  lastSessionByWorktree: Record<string, string>;
  scrollPositionByScope: Record<string, number>;
}

export interface SessionNavigationState extends NavigationPreferences {
  repositoryCwd?: string;
  sessionListing?: SessionListing;
  sessionsLoading: boolean;
  replacingSessions: boolean;
  loadingMore: boolean;
  error?: string;
  switchingProject?: string;
  switchingWorktree?: string;
  selectProject: (cwd: string) => Promise<void>;
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
  recentWorktrees: [], recentProjects: [], lastWorktreeByProject: {}, lastSessionByWorktree: {}, scrollPositionByScope: {},
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
      recentProjects: strings(saved.recentProjects),
      lastWorktreeByProject: record<string>(saved.lastWorktreeByProject, "string"),
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
function activateFilters(patch: Partial<NavigationPreferences & Pick<SessionNavigationState, "repositoryCwd">> = {}) {
  window.clearTimeout(searchTimer);
  searchTimer = undefined;
  const previous = useSessionNavigation.getState();
  const state = { ...previous, ...patch };
  const key = cacheKey(state);
  const metadata = sessionPathKey(previous.sessionListing?.repositoryCwd) === sessionPathKey(state.repositoryCwd)
    ? previous.sessionListing : undefined;
  // A response for these filters may still be in flight when the user returns to them.
  requests.set(key, (requests.get(key) ?? 0) + 1);
  useSessionNavigation.setState({
    ...patch,
    sessionListing: metadata ? { ...metadata, sessions: [], nextCursor: null } : undefined,
    sessionsLoading: Boolean(state.repositoryCwd),
    replacingSessions: Boolean(state.repositoryCwd),
    loadingMore: false,
    error: undefined,
  });
  if (!state.repositoryCwd) return;
  if (state.query.trim()) {
    searchTimer = window.setTimeout(() => { searchTimer = undefined; void fetchPage(false); }, 200);
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
  // Only a listing already displayed for these filters can stay on screen.
  useSessionNavigation.setState({
    sessionsLoading: true, replacingSessions: !more && (!cached || state.sessionListing !== cached),
    loadingMore: more, error: undefined,
  });
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
      const current = useSessionNavigation.getState();
      const root = sessionPathKey(result.repositoryCwd);
      const directories = new Set(result.directories.map((item) => sessionPathKey(item.cwd)));
      const lastCwd = current.recentWorktrees.find((cwd) => directories.has(sessionPathKey(cwd))) ?? result.repositoryCwd;
      useSessionNavigation.setState({
        repositoryCwd: result.repositoryCwd, sessionListing: listing,
        sessionsLoading: false, replacingSessions: false, loadingMore: false,
        recentProjects: [result.repositoryCwd, ...current.recentProjects.filter((cwd) => sessionPathKey(cwd) !== root && !directories.has(sessionPathKey(cwd)))].slice(0, 30),
        lastWorktreeByProject: { ...current.lastWorktreeByProject, [root]: lastCwd },
      });
    }
  } catch (error) {
    if (requests.get(key) === request && cacheKey(useSessionNavigation.getState()) === key) {
      useSessionNavigation.setState({
        sessionsLoading: false, replacingSessions: false, loadingMore: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const useSessionNavigation = create<SessionNavigationState>()((set, get) => ({
  ...preferences(), sessionsLoading: false, replacingSessions: false, loadingMore: false,
  setView: (view) => { if (view !== get().view) activateFilters({ view }); },
  setWorktreeScope: (worktreeScope) => { ++selectionRequest; activateFilters({ worktreeScope }); },
  setQuery: (query) => { if (query !== get().query) activateFilters({ query }); },
  toggleSessionPin: (path) => activateFilters({ pinnedSessions: toggle(get().pinnedSessions, path) }),
  toggleWorktreePin: (cwd) => set({ pinnedWorktrees: toggle(get().pinnedWorktrees, cwd) }),
  rememberScroll: (key, offset) => set({ scrollPositionByScope: { ...get().scrollPositionByScope, [key]: offset } }),
  loadMore: () => fetchPage(true),
  refresh: async () => { if (searchTimer === undefined) await fetchPage(false); },
  selectProject: async (cwd) => {
    if (get().switchingProject || get().switchingWorktree) return;
    const request = ++selectionRequest;
    set({ switchingProject: cwd, error: undefined });
    try {
      // Resolve before changing context so an unavailable folder leaves the current project usable.
      const listing = await invoke<SessionListing>("list_sessions", { cwd, limit: 0 });
      if (request !== selectionRequest) return;
      const root = listing.repositoryCwd;
      const remembered = get().lastWorktreeByProject[sessionPathKey(root)];
      const target = listing.directories.find((item) => sessionPathKey(item.cwd) === sessionPathKey(remembered))?.cwd ?? cwd;
      set({ repositoryCwd: root, sessionListing: listing, query: "", view: "recent" });
      await get().selectWorktree(target);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ switchingProject: undefined, switchingWorktree: undefined });
    }
  },
  selectWorktree: async (scope) => {
    if (get().switchingWorktree) return;
    if (scope !== "all") set({ switchingWorktree: scope });
    get().setWorktreeScope(scope);
    const request = selectionRequest;
    if (scope === "all") return;
    const remembered = get().lastSessionByWorktree[sessionPathKey(scope)];
    try {
      set({ recentWorktrees: [scope, ...get().recentWorktrees.filter((cwd) => sessionPathKey(cwd) !== sessionPathKey(scope))].slice(0, 30) });
      if (runtimeActions?.selectOpenSession(scope, remembered)) return;
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
    } finally {
      // Project switches clear both flags together so the resolved worktree stays visible.
      if (!get().switchingProject) set({ switchingWorktree: undefined });
    }
  },
}));

let serializedPreferences = "";
useSessionNavigation.subscribe((state) => {
  const { view, worktreeScope, query, pinnedSessions, pinnedWorktrees, recentWorktrees, recentProjects, lastWorktreeByProject, lastSessionByWorktree, scrollPositionByScope } = state;
  const serialized = JSON.stringify({ view, worktreeScope, query, pinnedSessions, pinnedWorktrees, recentWorktrees, recentProjects, lastWorktreeByProject, lastSessionByWorktree, scrollPositionByScope });
  if (serialized === serializedPreferences) return;
  serializedPreferences = serialized;
  try { localStorage.setItem(STORAGE_KEY, serialized); } catch { /* Navigation remains available when storage is full. */ }
});

/** Session selection preserves list navigation; a different project starts unscoped. */
export function rememberActiveSession(cwd: string, path?: string) {
  const state = useSessionNavigation.getState();
  const key = sessionPathKey(cwd);
  // Background publications must not undo a project switch before its runtime is selected.
  if (state.switchingProject && state.sessionListing
    && !state.sessionListing.directories.some((entry) => sessionPathKey(entry.cwd) === key)) return;
  const knownProject = state.sessionListing?.directories.some((entry) => sessionPathKey(entry.cwd) === key)
    || sessionPathKey(state.repositoryCwd) === key;
  const repositoryCwd = knownProject || (state.repositoryCwd && !state.sessionListing) ? state.repositoryCwd : cwd;
  const changedProject = sessionPathKey(repositoryCwd) !== sessionPathKey(state.repositoryCwd);
  const recentWorktrees = state.recentWorktrees[0] && sessionPathKey(state.recentWorktrees[0]) === key
    ? state.recentWorktrees : [cwd, ...state.recentWorktrees.filter((entry) => sessionPathKey(entry) !== key)].slice(0, 30);
  const lastSessionByWorktree = path && state.lastSessionByWorktree[key] !== path
    ? { ...state.lastSessionByWorktree, [key]: path } : state.lastSessionByWorktree;
  if (changedProject || recentWorktrees !== state.recentWorktrees || lastSessionByWorktree !== state.lastSessionByWorktree) {
    const patch = { repositoryCwd, recentWorktrees, lastSessionByWorktree,
      lastWorktreeByProject: repositoryCwd ? { ...state.lastWorktreeByProject, [sessionPathKey(repositoryCwd)]: cwd } : state.lastWorktreeByProject };
    if (changedProject) activateFilters({ ...patch, worktreeScope: "all" });
    else useSessionNavigation.setState(patch);
  }
}
