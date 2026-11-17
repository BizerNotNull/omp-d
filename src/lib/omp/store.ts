import { invoke } from "@/lib/diagnostics";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { OmpClient, RpcFailure, type OmpClientEvent } from "./client";
import { catalogCacheKey, catalogSnapshot, fetchCatalog, splitExtraArgs, subscribeCatalog } from "./model-catalog";
import { projectMessageBranches, sessionTreeFromEntries, type MessageBranch } from "./branches";
import { configureSessionNavigation, rememberActiveSession, sessionPathKey, useSessionNavigation } from "./navigation";
import type {
  AgentMessage,
  AvailableCommand,
  ExtensionUIRequest,
  ExtensionUIResponse,
  GoalModeState,
  GitStatus,
  ImageContent,
  Model,
  NavigateTreeResult,
  PromptResultFrame,
  RpcCommand,
  RpcFrame,
  RpcSessionState,
  SessionStats,
  SessionListing,
  SessionTree,
  SessionEntries,
  StartInfo,
  SubagentSnapshot,
  SubagentProgress,
  SubagentMessagesResult,
  TodoPhase,
} from "./types";
import { firstLine, imageBlocks, modelLabel, stripPrivateUse } from "./format";

const LAST_CWD_KEY = "ompd:lastCwd";
const LAST_SESSION_KEY = "ompd:lastSession";
const LAST_PROJECT_KEY = "ompd:lastProject";
const PREFS_KEY = "ompd:prefs";

export interface Preferences {
  binary: string;
  extraArgs: string;
  model: string;
  theme: "dark" | "light";
}

const DEFAULT_PREFS: Preferences = { binary: "omp", extraArgs: "", model: "", theme: "dark" };

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    return {
      binary: typeof (parsed as Preferences).binary === "string" ? (parsed as Preferences).binary : DEFAULT_PREFS.binary,
      extraArgs:
        typeof (parsed as Preferences).extraArgs === "string" ? (parsed as Preferences).extraArgs : DEFAULT_PREFS.extraArgs,
      model: typeof (parsed as Preferences).model === "string" ? (parsed as Preferences).model : DEFAULT_PREFS.model,
      theme: (parsed as Preferences).theme === "light" ? "light" : "dark",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePreferences(prefs: Preferences) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export type DialogRequest = Extract<
  ExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" }
>;

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  title?: string;
  message: string;
}

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "running" | "success" | "error";
  startedAt: number;
  updatedAt: number;
  output?: string;
  images?: ImageContent[];
  details?: unknown;
}

export interface NoticeItem {
  id: number;
  kind: "info" | "warning" | "error" | "progress";
  message: string;
  at: number;
}

export interface PendingMessage {
  messageId: string;
  message: AgentMessage;
}

export type ConnectionStatus = "idle" | "starting" | "ready" | "error" | "stopped";


export interface OpenSession {
  id: number;
  path?: string;
  cwd?: string;
  title: string;
  busy: boolean;
  modifiedMs: number;
  dialogs: number;
  status: ConnectionStatus;
}

interface AppState {
  initialized: boolean;
  activeRuntimeId: number;
  openSessions: OpenSession[];
  protocolVersion?: number;
  selectRuntime: (id: number) => void;
  draftText: string;
  draftImages: ImageContent[];
  setDraftText: (text: string) => void;
  setDraftImages: (images: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => void;
  status: ConnectionStatus;
  error?: string;
  cwd?: string;
  startInfo?: StartInfo;
  preferences: Preferences;

  session?: RpcSessionState;
  stats?: SessionStats;
  gitStatus?: GitStatus | null;
  gitStatusError?: string;
  messages: AgentMessage[];
  messageKeys: Set<string>;
  pending: PendingMessage[];
  toolRuns: Record<string, ToolRun>;
  subagents: Record<string, SubagentSnapshot>;
  subagentsAvailable?: boolean;
  subagentMessages: Record<string, AgentMessage[]>;
  refreshSubagents: () => Promise<void>;
  refreshSubagentMessages: (id: string) => Promise<void>;
  queue: { steering: string[]; followUp: string[]; liveSteered?: number };
  busy: boolean;
  sessionTree?: SessionTree;
  messageBranches: Array<MessageBranch | undefined>;
  treeLoading: boolean;
  branching: boolean;

  commands: AvailableCommand[];
  thinkingLevels: string[];
  models?: Model[];
  modelRoles: Record<string, string>;
  modelsLoading: boolean;
  modelsError?: string;
  rolesLoading: boolean;
  rolesError?: string;

  sessionListing?: SessionListing;
  sessionsLoading: boolean;

  dialogs: DialogRequest[];
  notifications: Toast[];
  notices: NoticeItem[];
  statusMarks: Record<string, string>;
  widgets: Record<string, string[]>;
  diagnostics: string[];
  editorToken: number;

  bootstrap: () => Promise<void>;
  connect: (cwd: string, prefs?: Partial<Preferences>) => Promise<void>;
  restart: () => Promise<void>;
  disconnect: () => Promise<void>;
  updatePreferences: (partial: Partial<Preferences>) => void;
  openProjectDialog: () => Promise<void>;

  refreshAll: () => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshState: () => Promise<void>;
  refreshGitStatus: () => Promise<void>;
  refreshMessages: () => Promise<void>;
  forkMessage: (entryId: string, text: string) => Promise<boolean>;
  switchBranch: (entryId: string) => Promise<boolean>;
  loadSessions: () => Promise<void>;

  prompt: (text: string, images?: ImageContent[], behavior?: "steer" | "followUp") => Promise<boolean>;
  abort: () => Promise<void>;
  compact: () => Promise<void>;
  removeQueued: (message: string, queue: "steering" | "followUp") => Promise<void>;

  newSession: (targetCwd?: string) => Promise<void>;
  switchSession: (path: string, cwd?: string) => Promise<void>;
  renameSession: (name: string) => Promise<void>;

  fetchModels: (force?: boolean) => Promise<void>;
  setModel: (provider: string, id: string) => Promise<boolean>;
  setThinkingLevel: (level: string) => Promise<void>;

  answerDialog: (dialogId: string, response: Omit<ExtensionUIResponse, "type" | "id">) => Promise<void>;
  cancelDialog: (dialogId: string) => Promise<void>;
  dismissToast: (id: number) => void;
  setEditorText: (text: string) => void;

  applyFrame: (frame: RpcFrame) => void;
  handleEvent: (event: OmpClientEvent) => void;
}

let toastSeq = 0;
let noticeSeq = 0;
let initialized = false;
const runtimeModifiedTimes = new Map<number, number>();
function createRuntimeStore(id: number, initialSessionPath?: string) {
const omp = new OmpClient();
let connectTicket = 0;
let catalogSubscription: (() => void) | undefined;
let subscribedCatalogKey: string | undefined;
function bindCatalog(key: string) {
  if (key === subscribedCatalogKey) return;
  catalogSubscription?.();
  subscribedCatalogKey = key;
  catalogSubscription = subscribeCatalog(key, (snapshot) => {
    if (runtime.getState().status === "starting" || runtime.getState().status === "ready") runtime.setState(snapshot);
  });
}
runtimeModifiedTimes.set(id, initialSessionPath ? 0 : Date.now());
let refreshing: Promise<void> | undefined;
let refreshAgain = false;
let gitRefreshKey: string | undefined;
let conversationRevision = 0;
let treeRequest = 0;
let treeWarningGeneration: number | undefined;
let workspaceQuerySeq = 0;
let subagentSubscriptionGeneration: number | undefined;
let subagentRefresh: Promise<void> | undefined;
let subagentEventRevision = 0;
const subagentMessageRequests = new Map<string, number>();

function messageKey(message: AgentMessage): string {
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
  if (message.role === "toolResult") return `toolResult:${message.toolCallId}:${timestamp}`;
  if (message.role === "assistant") {
    const firstCall = Array.isArray(message.content)
      ? message.content.find((block) => block.type === "toolCall")
      : undefined;
    const callId = firstCall && "id" in firstCall ? String(firstCall.id) : "";
    return `assistant:${timestamp}:${callId}`;
  }
  return `${message.role}:${timestamp}`;
}

function withMessageKeys(messages: AgentMessage[]): { messages: AgentMessage[]; messageKeys: Set<string> } {
  return { messages, messageKeys: new Set(messages.map(messageKey)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function describeError(error: unknown): string {
  if (error instanceof RpcFailure) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

const runtime = create<AppState>()((set, get) => ({
  initialized: true,
  activeRuntimeId: id,
  openSessions: [],
  selectRuntime,
  draftText: "",
  draftImages: [],
  setDraftText: (draftText) => set({ draftText }),
  setDraftImages: (images) => set((state) => ({ draftImages: typeof images === "function" ? images(state.draftImages) : images })),
  status: "idle",
  preferences: loadPreferences(),

  messages: [],
  messageKeys: new Set<string>(),
  pending: [],
  toolRuns: {},
  subagents: {},
  subagentMessages: {},
  queue: { steering: [], followUp: [] },
  busy: false,
  messageBranches: [],
  treeLoading: false,
  branching: false,

  commands: [],
  thinkingLevels: [],
  modelsLoading: false,
  rolesLoading: false,
  modelRoles: {},
  sessionListing: undefined,
  sessionsLoading: false,

  dialogs: [],
  notifications: [],
  notices: [],
  statusMarks: {},
  widgets: {},
  diagnostics: [],
  editorToken: 0,

  bootstrap: async () => {
    if (initialized) return;
    if (get().cwd && get().status !== "idle") return;
    initialized = true;
    set({ initialized: true });
    // Each runtime subscribes at construction, including while it is hidden.
    let cwd = localStorage.getItem(LAST_CWD_KEY);
    const previousSession = localStorage.getItem(LAST_SESSION_KEY);
    const project = localStorage.getItem(LAST_PROJECT_KEY);
    if (project) useSessionNavigation.setState({ repositoryCwd: project });
    if (previousSession && cwd) {
      try {
        const listing = await invoke<SessionListing>("list_sessions", { cwd: project ?? cwd, paths: [previousSession], limit: 1 });
        const previous = listing.sessions[0];
        if (previous) {
          initialSessionPath = previous.path;
          cwd = previous.cwd;
        }
      } catch {
        // Let connect report an unavailable project rather than fail bootstrap early.
      }
    }
    if (!cwd) {
      const initial = await invoke<string | null>("initial_folder");
      if (!initial) {
        set({ status: "idle" });
        return;
      }
      await get().connect(initial);
      return;
    }
    await get().connect(cwd);
  },

  connect: async (cwd, prefs) => {
    const ticket = ++connectTicket;
    ++conversationRevision;
    subagentRefresh = undefined;
    subagentSubscriptionGeneration = undefined;
    runtimeModifiedTimes.set(id, initialSessionPath ? 0 : Date.now());
    const entry = runtimes.get(id);
    if (entry && initialSessionPath) entry.path = initialSessionPath;
    const preferences = { ...get().preferences, ...prefs };
    const cachedCatalog = catalogSnapshot(catalogCacheKey(cwd, preferences));
    set({
      status: "starting",
      error: undefined,
      cwd,
      preferences,
      ...cachedCatalog,
      messages: withMessageKeys([]).messages,
      messageKeys: new Set<string>(),
      pending: [],
      toolRuns: {},
      subagents: {},
      subagentMessages: {},
      subagentsAvailable: undefined,
      sessionTree: undefined,
      messageBranches: [],
      treeLoading: false,
      branching: false,
      dialogs: [],
      notices: [],
      statusMarks: {},
      widgets: {},
      session: undefined,
      stats: undefined,
      gitStatus: undefined,
      gitStatusError: undefined,
    });
    set({ busy: false, queue: { steering: [], followUp: [] }, startInfo: undefined, protocolVersion: undefined });
    bindCatalog(catalogCacheKey(cwd, preferences));
    savePreferences(preferences);
    try {
      const extraArgs = splitExtraArgs(preferences.extraArgs);
      const info = await omp.start({
        cwd,
        binary: preferences.binary.trim() || "omp",
        model: preferences.model.trim() || null,
        extraArgs,
      });
      if (ticket !== connectTicket) return;
      if (activeRuntime === runtime) localStorage.setItem(LAST_CWD_KEY, info.cwd);
      set({ startInfo: info, cwd: info.cwd });
      void get().fetchModels();
      await omp.send({ type: "set_ask_dialog", enabled: true }).catch(() => {});
      if (initialSessionPath) {
        const response = await omp.send<{ cancelled: boolean }>({ type: "switch_session", sessionPath: initialSessionPath });
        if (response.data?.cancelled) throw new Error("Session switch was cancelled.");
        initialSessionPath = undefined;
      }
      set({ status: "ready" });
      await get().refreshAll();
      if (ticket !== connectTicket) return;
      await get().loadSessions();
    } catch (error) {
      if (ticket !== connectTicket) return;
      set({ status: "error", error: describeError(error), sessionsLoading: false });
    }
  },

  restart: async () => {
    const cwd = get().cwd;
    const previousSession = get().session?.sessionFile ?? initialSessionPath;
    if (!cwd) return;
    initialSessionPath = previousSession;
    await get().connect(cwd);
  },

  disconnect: async () => {
    ++connectTicket;
    catalogSubscription?.();
    subscribedCatalogKey = undefined;
    await omp.stop();
    set({ status: "stopped", subagents: {}, subagentMessages: {}, subagentsAvailable: undefined, busy: false, branching: false, treeLoading: false, queue: { steering: [], followUp: [] }, modelsLoading: false, rolesLoading: false, sessionsLoading: false });
  },

  updatePreferences: (partial) => {
    const previous = get().preferences;
    const preferences = { ...get().preferences, ...partial };
    savePreferences(preferences);
    set({ preferences });
    for (const entry of runtimes.values()) {
      if (entry.store !== runtime) {
        entry.store.setState({ preferences });
        const cwd = entry.store.getState().cwd;
        if (cwd && catalogCacheKey(cwd, previous) !== catalogCacheKey(cwd, preferences)) void entry.store.getState().fetchModels(true);
      }
    }
    const cwd = get().cwd;
    if (cwd && catalogCacheKey(cwd, previous) !== catalogCacheKey(cwd, preferences)) {
      bindCatalog(catalogCacheKey(cwd, preferences));
      void get().fetchModels(true);
    }
  },

  openProjectDialog: async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open a project folder" });
    if (typeof selected === "string" && selected) {
      await openRuntime(selected);
    }
  },

  refreshSubagents: async () => {
    if (get().status !== "ready" || get().subagentsAvailable === false) return;
    if (subagentRefresh) return subagentRefresh;
    const generation = omp.generation;
    const revision = conversationRevision;
    const current = () => generation === omp.generation && revision === conversationRevision && get().status === "ready";
    const refresh = async () => {
      try {
        if (subagentSubscriptionGeneration !== generation) {
          await omp.send({ type: "set_subagent_subscription", level: "progress" });
          if (!current()) return;
          subagentSubscriptionGeneration = generation;
        }
        const eventRevision = subagentEventRevision;
        const response = await omp.send<{ subagents: SubagentSnapshot[] }>({ type: "get_subagents" });
        if (!current()) return;
        set((state) => {
          const subagents = { ...state.subagents };
          // Events observed during the query are newer than its snapshot.
          if (eventRevision === subagentEventRevision) {
            for (const agent of response.data?.subagents ?? []) subagents[agent.id] = agent;
          }
          return { subagents, subagentsAvailable: true };
        });
      } catch {
        // Optional RPC capability: older omp versions must not show startup errors.
        if (current()) set({ subagentsAvailable: false });
      }
    };
    const pending = refresh();
    subagentRefresh = pending;
    try { await pending; } finally { if (subagentRefresh === pending) subagentRefresh = undefined; }
  },

  refreshSubagentMessages: async (subagentId) => {
    if (get().subagentsAvailable !== true || get().status !== "ready") return;
    const generation = omp.generation;
    const revision = conversationRevision;
    const request = (subagentMessageRequests.get(subagentId) ?? 0) + 1;
    subagentMessageRequests.set(subagentId, request);
    try {
      const sessionFile = get().subagents[subagentId]?.sessionFile;
      const response = await omp.send<SubagentMessagesResult>({
        type: "get_subagent_messages",
        ...(sessionFile ? { sessionFile } : { subagentId }),
      });
      if (generation !== omp.generation || revision !== conversationRevision || get().status !== "ready"
        || subagentMessageRequests.get(subagentId) !== request) return;
      if (response.data) set((state) => ({
        subagentMessages: { ...state.subagentMessages, [subagentId]: response.data!.messages },
      }));
    } catch {
      // A historical/removed agent may no longer have an available transcript.
    }
  },

  refreshAll: async () => {
    if (refreshing) {
      refreshAgain = true;
      await refreshing;
      return;
    }
    const { promise, resolve: complete } = Promise.withResolvers<void>();
    refreshing = promise;
    const generation = omp.generation;
    const revision = conversationRevision;
    void get().refreshTree();
    void get().refreshSubagents();
    try {
      const [state, messages, stats, levels, commands] = await Promise.all([
        omp.send<RpcSessionState>({ type: "get_state" }).catch(() => undefined),
        omp.send<{ messages: AgentMessage[] }>({ type: "get_messages" }).catch(() => undefined),
        omp.send<SessionStats>({ type: "get_session_stats" }).catch(() => undefined),
        omp.send<{ levels: string[] }>({ type: "get_available_thinking_levels" }).catch(() => undefined),
        omp.send<{ commands: AvailableCommand[] }>({ type: "get_available_commands" }).catch(() => undefined),
      ]);
      if (omp.generation !== generation || revision !== conversationRevision) return;
      const session = state?.data;
      const transcript = messages?.data?.messages;
      if (transcript) runtimeModifiedTimes.set(id, transcript.reduce((modified, message) =>
        Math.max(modified, typeof message.timestamp === "number" ? message.timestamp : 0), runtimeModifiedTimes.get(id) ?? 0));
      if (session) {
        await syncSessionWorkspace(set, () => omp.generation === generation && revision === conversationRevision);
        if (omp.generation !== generation || revision !== conversationRevision) return;
      }
      set((current) => ({
        session: session ?? current.session,
        stats: stats?.data ?? current.stats,
        ...(transcript ? withMessageKeys(transcript) : { messages: current.messages, messageKeys: current.messageKeys }),
        messageBranches: current.sessionTree ? projectMessageBranches(current.sessionTree, transcript ?? current.messages) : [],
        pending: transcript ? [] : current.pending,
        thinkingLevels: levels?.data?.levels ?? current.thinkingLevels,
        commands: commands?.data?.commands ?? current.commands,
        queue: session?.queuedMessages
          ? {
              steering: session.queuedMessages.steering ?? [],
              followUp: session.queuedMessages.followUp ?? [],
              liveSteered: session.queuedMessages.liveSteered,
            }
          : current.queue,
        busy: Boolean(session?.isStreaming ?? current.busy),
        toolRuns: transcript ? {} : current.toolRuns,
      }));
      if (session?.sessionName) setTitle(`${session.sessionName} — omp-d`);
    } catch (error) {
      if (omp.generation === generation && get().status === "ready") {
        pushToast(set, "warning", describeError(error));
      }
    } finally {
      refreshing = undefined;
      if (refreshAgain) {
        refreshAgain = false;
        await get().refreshAll();
      }
      complete();
    }
  },

  refreshTree: async () => {
    const generation = omp.generation;
    const revision = conversationRevision;
    const request = ++treeRequest;
    const current = () => generation === omp.generation && revision === conversationRevision && request === treeRequest && get().status === "ready";
    set({ treeLoading: true });
    try {
      const response = await omp.send<SessionEntries>({ type: "get_entries" });
      if (!current()) return;
      if (!response.data) throw new Error("The runtime did not return session entries.");
      const sessionTree = sessionTreeFromEntries(response.data);
      set((state) => ({ sessionTree, messageBranches: projectMessageBranches(sessionTree, state.messages) }));
    } catch (error) {
      if (!current()) return;
      set({ sessionTree: undefined, messageBranches: [] });
      if (treeWarningGeneration !== generation) {
        treeWarningGeneration = generation;
        pushToast(set, "warning", `Conversation branches unavailable: ${describeError(error)}`);
      }
    } finally {
      if (current()) set({ treeLoading: false });
    }
  },

  refreshGitStatus: async () => {
    const { cwd, status } = get();
    if (!cwd || status !== "ready") return;
    const ticket = connectTicket;
    const key = `${ticket}:${cwd}`;
    if (gitRefreshKey === key) return;
    gitRefreshKey = key;
    try {
      const gitStatus = await invoke<GitStatus | null>("git_status", { cwd });
      if (ticket === connectTicket && get().cwd === cwd && get().status === "ready") {
        set({ gitStatus, gitStatusError: undefined });
      }
    } catch (error) {
      if (ticket === connectTicket && get().cwd === cwd && get().status === "ready") {
        set({ gitStatus: undefined, gitStatusError: describeError(error) });
      }
    } finally {
      if (gitRefreshKey === key) gitRefreshKey = undefined;
    }
  },

  refreshState: async () => {
    const generation = omp.generation;
    const revision = conversationRevision;
    try {
      const res = await omp.send<RpcSessionState>({ type: "get_state" });
      if (!res.data) return;
      const session = res.data;
      const current = () => omp.generation === generation && revision === conversationRevision;
      if (!current()) return;
      await syncSessionWorkspace(set, current);
      if (!current()) return;
      setTitle(session.sessionName ? `${stripPrivateUse(session.sessionName)} — omp-d` : "omp-d — Oh My Pi");
      set((state) => ({
        session,
        busy: Boolean(session.isStreaming),
        queue: {
          steering: session.queuedMessages?.steering ?? state.queue.steering,
          followUp: session.queuedMessages?.followUp ?? state.queue.followUp,
          liveSteered: session.queuedMessages?.liveSteered,
        },
      }));
    } catch {
      // State refresh is best-effort; command failures surface through toasts.
    }
  },

  refreshMessages: async () => {
    const generation = omp.generation;
    const revision = conversationRevision;
    try {
      const res = await omp.send<{ messages: AgentMessage[] }>({ type: "get_messages" });
      if (generation !== omp.generation || revision !== conversationRevision) return;
      if (res.data?.messages) runtimeModifiedTimes.set(id, res.data.messages.reduce((modified, message) =>
        Math.max(modified, typeof message.timestamp === "number" ? message.timestamp : 0), runtimeModifiedTimes.get(id) ?? 0));
      set((state) => ({
        ...withMessageKeys(res.data?.messages ?? []),
        messageBranches: state.sessionTree ? projectMessageBranches(state.sessionTree, res.data?.messages ?? []) : [],
        pending: [],
      }));
    } catch {
      // ignore
    }
  },

  forkMessage: async (entryId, text) => {
    if (!text.trim()) return false;
    const state = get();
    const index = state.messageBranches.findIndex((branch) => branch?.entryId === entryId);
    if (index < 0) return false;
    return navigateConversation(set, get, entryId, { text, images: imageBlocks(state.messages[index]?.content) });
  },

  switchBranch: async (entryId) => {
    const valid = get().messageBranches.some((branch) => branch?.alternatives.some((choice) => choice.leafId === entryId));
    if (!valid) return false;
    return navigateConversation(set, get, entryId);
  },
  loadSessions: async () => {
    if (activeRuntime !== runtime) return;
    await useSessionNavigation.getState().refresh();
  },

  prompt: async (text, images, behavior) => {
    const trimmed = text.trim();
    if (get().branching) return false;
    if (!trimmed) return false;
    const shouldTitle = !get().session?.sessionName && (get().session?.messageCount ?? 0) === 0 && !trimmed.startsWith("/");
    // Goal lifecycle commands must not mark an idle session as streaming.
    if (/^\/(?:goal|guided-goal)(?:\s|$)/.test(trimmed)) {
      try {
        if (images?.length) throw new Error("Goal commands do not accept image attachments.");
        if (trimmed.startsWith("/guided-goal")) {
          throw new Error("Guided goals are not supported by the installed omp RPC API.");
        }
        const args = trimmed.slice(5).trim();
        const [subcommand = "", ...words] = args.split(/\s+/);
        const rest = words.join(" ");
        let op: "get" | "create" | "pause" | "resume" | "drop";
        let objective: string | undefined;
        switch (subcommand) {
          case "":
          case "show":
            op = "get";
            break;
          case "set":
            if (!rest) throw new Error("Usage: /goal set <objective>");
            op = "create";
            objective = args.slice(3).trim();
            break;
          case "pause":
          case "resume":
          case "drop":
            if (rest) throw new Error(`Usage: /goal ${subcommand}`);
            op = subcommand;
            break;
          case "budget":
            throw new Error("Budget editing is not supported by the installed omp RPC API.");
          default:
            op = "create";
            objective = args;
        }
        if (op === "get" && rest) throw new Error("Usage: /goal show");
        const response = await omp.send<{ state: GoalModeState | null }>({ type: "goal", op, ...(objective ? { objective } : {}) });
        if (response.data) {
          const goalState = response.data.state;
          set((state) => state.session ? { session: { ...state.session, goal: goalState } } : {});
          const goal = goalState?.goal;
          pushNotice(set, "info", goal
            ? `Goal ${goal.status}: ${goal.objective}`
            : "No current goal. Use /goal set <objective> to start one.");
        }
        await get().refreshState();
        return true;
      } catch (error) {
        pushToast(set, "error", describeError(error));
        return false;
      }
    }
    try {
      set({ busy: true });
      const command: RpcCommand = { type: "prompt", message: trimmed };
      if (images?.length) command.images = images;
      if (behavior) command.streamingBehavior = behavior;
      const response = await omp.send<{ agentInvoked?: boolean }>(command).catch((error) => {
        set({ busy: false });
        throw error;
      });
      if (response.data?.agentInvoked === false) {
        set({ busy: false });
        await get().refreshAll();
      }
      if (shouldTitle) {
        const name = firstLine(trimmed, 64);
        await omp.send({ type: "set_session_name", name }).catch(() => {});
        await get().refreshState();
        await get().loadSessions();
      }
      return true;
    } catch (error) {
      pushToast(set, "error", describeError(error));
      return false;
    }
  },

  abort: async () => {
    try {
      await omp.send({ type: "abort" }, { timeoutMs: 30_000 });
      await get().refreshState();
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
  },

  compact: async () => {
    if (get().branching) return;
    set({ busy: true });
    pushNotice(set, "progress", "Compacting conversation…");
    try {
      await omp.send({ type: "compact", customInstructions: "" }, { timeoutMs: 300_000 });
      pushToast(set, "success", "Compaction finished.");
      await get().refreshAll();
    } catch (error) {
      pushToast(set, "error", describeError(error));
    } finally {
      set({ busy: false });
    }
  },

  removeQueued: async (message, queue) => {
    try {
      await omp.send({ type: "remove_queued_message", message, queue });
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
  },

  newSession: async (targetCwd) => {
    const state = get();
    const navigation = useSessionNavigation.getState();
    const cwd = targetCwd ?? state.cwd ?? navigation.recentWorktrees[0] ?? navigation.repositoryCwd;
    if (!cwd || state.branching) return;
    const draft = state.messages.length === 0 ? { draftText: state.draftText, draftImages: state.draftImages } : undefined;
    const created = await openRuntime(cwd);
    if (draft) created.setState(draft);
  },

  switchSession: async (path, targetCwd) => {
    if (get().branching) return;
    const existing = [...runtimes.values()].find((entry) =>
      sessionPathKey(entry.store.getState().session?.sessionFile ?? entry.path) === sessionPathKey(path));
    if (existing) {
      selectRuntime(existing.store.getState().activeRuntimeId);
      return;
    }
    const navigation = useSessionNavigation.getState();
    const cwd = targetCwd ?? navigation.sessionListing?.sessions.find((entry) =>
      sessionPathKey(entry.path) === sessionPathKey(path))?.cwd ?? get().cwd;
    if (cwd) await openRuntime(cwd, path);
  },

  renameSession: async (name) => {
    const value = name.trim();
    if (!value) return;
    try {
      await omp.send({ type: "set_session_name", name: value });
      await get().refreshState();
      await get().loadSessions();
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
  },

  fetchModels: async (force = false) => {
    const { cwd, preferences, status } = get();
    if (!cwd || (status !== "ready" && status !== "starting")) return;
    const key = catalogCacheKey(cwd, preferences);
    bindCatalog(key);
    await fetchCatalog(key, { cwd, binary: preferences.binary.trim() || "omp", extraArgs: splitExtraArgs(preferences.extraArgs) }, force);
  },

  setModel: async (provider, id) => {
    try {
      const res = await omp.send<Model>({ type: "set_model", provider, modelId: id });
      await get().refreshState();
      pushToast(set, "success", `Model set to ${modelLabel(res.data)}.`);
      return true;
    } catch (error) {
      pushToast(set, "error", describeError(error));
      return false;
    }
  },

  setThinkingLevel: async (level) => {
    try {
      await omp.send({ type: "set_thinking_level", level });
      await get().refreshState();
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
  },

  answerDialog: async (dialogId, response) => {
    set((state) => ({ dialogs: state.dialogs.filter((dialog) => dialog.id !== dialogId) }));
    try {
      await omp.sendRaw({ type: "extension_ui_response", id: dialogId, ...response });
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
  },

  cancelDialog: async (dialogId) => {
    await get().answerDialog(dialogId, { cancelled: true });
  },

  dismissToast: (id) => set((state) => ({ notifications: state.notifications.filter((toast) => toast.id !== id) })),

  setEditorText: (text) => set((state) => ({ draftText: text, draftImages: [], editorToken: state.editorToken + 1 })),

  applyFrame: (frame) => {
    if (frame.type === "message_start" || frame.type === "message_update" || frame.type === "message_end") {
      runtimeModifiedTimes.set(id, Date.now());
    }
    switch (frame.type) {
      case "subagent_lifecycle": {
        const payload = frame.payload;
        if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.agent !== "string"
          || typeof payload.index !== "number") return;
        const status = payload.status === "started" ? "running" : payload.status;
        if (status !== "running" && status !== "completed" && status !== "failed" && status !== "aborted") return;
        ++subagentEventRevision;
        set((state) => ({
          subagentsAvailable: true,
          subagents: { ...state.subagents, [payload.id as string]: {
            ...state.subagents[payload.id as string],
            id: payload.id as string,
            agent: payload.agent as string,
            index: payload.index as number,
            status,
            description: typeof payload.description === "string" ? payload.description : state.subagents[payload.id as string]?.description,
            sessionFile: typeof payload.sessionFile === "string" ? payload.sessionFile : state.subagents[payload.id as string]?.sessionFile,
            parentToolCallId: typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : state.subagents[payload.id as string]?.parentToolCallId,
            lastUpdate: Date.now(),
          } },
        }));
        return;
      }
      case "subagent_progress": {
        const payload = frame.payload;
        const progress = isRecord(payload) && isRecord(payload.progress) ? payload.progress : undefined;
        if (!progress || typeof progress.id !== "string" || typeof progress.agent !== "string") return;
        if (!["pending", "running", "completed", "failed", "aborted"].includes(String(progress.status))) return;
        ++subagentEventRevision;
        const agentProgress = progress as unknown as SubagentProgress;
        set((state) => ({
          subagentsAvailable: true,
          subagents: { ...state.subagents, [agentProgress.id]: {
            ...state.subagents[agentProgress.id],
            id: agentProgress.id,
            agent: agentProgress.agent,
            index: agentProgress.index,
            status: agentProgress.status,
            description: agentProgress.description,
            task: agentProgress.task,
            assignment: agentProgress.assignment,
            parentToolCallId: typeof (payload as Record<string, unknown>).parentToolCallId === "string"
              ? (payload as Record<string, unknown>).parentToolCallId as string : state.subagents[agentProgress.id]?.parentToolCallId,
            lastUpdate: Date.now(),
            progress: agentProgress,
          } },
        }));
        return;
      }
      case "message_start": {
        const messageId = String(frame.messageId ?? "");
        const message = frame.message as AgentMessage | undefined;
        if (!messageId || !message) return;
        set((state) => ({
          pending: [...state.pending.filter((entry) => entry.messageId !== messageId), { messageId, message }],
        }));
        return;
      }
      case "message_update": {
        const messageId = String(frame.messageId ?? "");
        const message = frame.message as AgentMessage | undefined;
        if (!messageId || !message) return;
        set((state) => {
          const exists = state.pending.some((entry) => entry.messageId === messageId);
          return exists
            ? { pending: state.pending.map((entry) => (entry.messageId === messageId ? { messageId, message } : entry)) }
            : { pending: [...state.pending, { messageId, message }] };
        });
        return;
      }
      case "message_end": {
        const messageId = String(frame.messageId ?? "");
        const message = frame.message as AgentMessage | undefined;
        if (!message) return;
        set((state) => {
          const pending = state.pending.filter((entry) => entry.messageId !== messageId);
          const key = messageKey(message);
          if (state.messageKeys.has(key)) return { pending };
          const messageKeys = new Set(state.messageKeys);
          messageKeys.add(key);
          return { pending, messages: [...state.messages, message], messageKeys };
        });
        return;
      }
      case "agent_start":
        set({ busy: true });
        return;
      case "agent_end": {
        const terminal = frame.isTerminal !== false;
        if (terminal) set({ busy: false });
        return;
      }
      case "turn_end":
      case "turn_start":
        return;
      case "tool_execution_start":
        upsertToolRun(set, frame, "running");
        return;
      case "tool_execution_update":
        upsertToolRun(set, frame, "running");
        return;
      case "tool_execution_end":
        upsertToolRun(set, frame, frame.isError ? "error" : "success");
        return;
      case "queue_update":
        set({
          queue: {
            steering: Array.isArray(frame.steering) ? (frame.steering as string[]) : [],
            followUp: Array.isArray(frame.followUp) ? (frame.followUp as string[]) : [],
            liveSteered: typeof frame.liveSteered === "number" ? frame.liveSteered : undefined,
          },
        });
        return;
      case "command_output": {
        const text = typeof frame.text === "string" ? frame.text.trim() : "";
        if (!text) return;
        // Some runtime versions emit a plain "… failed:" message instead
        // of the conventional "Error:" prefix.
        const isError = /^(?:Error:\s|[^:\r\n]*\bfailed:\s)/i.test(text);
        const message = isError && !/^Error:\s/i.test(text) ? `Error: ${text}` : text;
        pushNotice(set, isError ? "error" : "info", message);
        if (isError) pushToast(set, "error", message);
        return;
      }
      case "notice": {
        const level = (frame.level as string) ?? "info";
        const raw = String(frame.message ?? "").replace(/\s+/g, " ").trim();
        if (!raw) return;
        const message = raw.length > 280 ? `${raw.slice(0, 280)}…` : raw;
        pushNotice(set, level === "error" ? "error" : level === "warning" ? "warning" : "info", message);
        if (level === "warning" || level === "error") {
          pushToast(set, level as Toast["kind"], raw.length > 800 ? `${raw.slice(0, 800)}…` : raw);
        }
        return;
      }
      case "prompt_result": {
        const result = frame as unknown as PromptResultFrame;
        // Internal workspace queries are local prompts too; they must not
        // recursively refresh the session or change the user's busy state.
        if (result.id?.startsWith("ompd-workspace-")) return;
        if (result.status === "error") {
          pushToast(set, "error", result.error?.message ?? "The prompt failed.");
        } else if (result.status === "aborted") {
          pushNotice(set, "info", "Run aborted.");
        }
        if (result.error?.message) pushNotice(set, "error", result.error.message);
        if (result.sessionSettled) set({ busy: false });
        if (!result.agentInvoked) {
          void get().refreshAll();
          void get().loadSessions();
        }
        return;
      }
      case "session_settled":
        set({ busy: false });
        void get().refreshAll();
        void get().loadSessions();
        return;
      case "config_update":
        void get().refreshAll();
        return;
      case "model_changed":
      case "thinking_level_changed":
        void get().refreshState();
        return;
      case "goal_updated": {
        const goalState = frame.state as GoalModeState | undefined;
        if (!goalState && frame.goal) {
          void get().refreshState();
          return;
        }
        set((state) => state.session
          ? { session: { ...state.session, goal: goalState ?? null } }
          : {});
        return;
      }
      case "available_commands_update": {
        const commands = frame.commands as AvailableCommand[] | undefined;
        if (commands) set({ commands });
        return;
      }
      case "auto_compaction_start":
      case "manual_compaction_start":
        pushNotice(set, "progress", "Compacting conversation…");
        set({ busy: true });
        return;
      case "auto_compaction_end":
      case "manual_compaction_end": {
        const frameError = typeof frame.errorMessage === "string" ? frame.errorMessage : undefined;
        if (frameError) pushToast(set, "warning", frameError);
        pushNotice(set, "info", "Compaction finished.");
        void get().refreshAll();
        return;
      }
      case "auto_retry_start":
        pushNotice(set, "progress", `Retrying request (attempt ${frame.attempt ?? "?"} of ${frame.maxAttempts ?? "?"})…`);
        return;
      case "auto_retry_end":
        if (frame.success === false && typeof frame.finalError === "string") {
          pushToast(set, "error", frame.finalError);
        }
        return;
      case "extension_ui_request":
        handleExtensionRequest(frame as unknown as ExtensionUIRequest, set, get);
        return;
      case "extension_error":
        pushToast(set, "warning", `${frame.extensionPath ?? "Extension"}: ${frame.error ?? "failed"}`);
        return;
      case "rpc_frame_error":
        pushToast(set, "warning", String(frame.error ?? "A frame exceeded the transport limit."));
        return;
      default:
        return;
    }
  },

  handleEvent: (event) => {
    switch (event.type) {
      case "frame":
        get().applyFrame(event.frame);
        return;
      case "ready":
        set({ protocolVersion: event.ready.protocolVersion });
        return;
      case "disconnected":
        catalogSubscription?.();
        subscribedCatalogKey = undefined;
        set({ status: "stopped", subagents: {}, subagentMessages: {}, subagentsAvailable: undefined, busy: false, branching: false, treeLoading: false, error: event.reason, modelsLoading: false, rolesLoading: false });
        return;
      case "protocol":
        appendDiagnostic(set, `${event.event.kind}: ${event.event.message}`);
        if (event.event.kind === "protocol_error") pushToast(set, "warning", event.event.message);
        return;
      case "stderr":
        appendDiagnostic(set, event.line);
        return;
      case "process":
        if (event.event.kind === "error") {
          catalogSubscription?.();
          subscribedCatalogKey = undefined;
          set({ status: "error", subagents: {}, subagentMessages: {}, subagentsAvailable: undefined, error: event.event.message, busy: false, branching: false, treeLoading: false, modelsLoading: false, rolesLoading: false });
        }
        return;
    }
  },
}));

/* ---------------------------------------------------------------- helpers */

type SetState = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

async function syncSessionWorkspace(
  set: SetState,
  current: () => boolean,
) {
  try {
    await omp.send({
      type: "prompt",
      id: `ompd-workspace-${++workspaceQuerySeq}`,
      message: "/ompd-workspace",
    });
  } catch (error) {
    if (current()) pushToast(set, "warning", `Workspace refresh failed: ${describeError(error)}`);
  }
}
async function navigateConversation(
  set: SetState,
  get: () => AppState,
  entryId: string,
  draft?: { text: string; images: ImageContent[] },
): Promise<boolean> {
  const state = get();
  if (state.status !== "ready" || state.busy || state.branching || state.treeLoading
    || state.session?.hasPendingAsyncWork || state.queue.steering.length || state.queue.followUp.length) return false;
  const generation = omp.generation;
  const revision = ++conversationRevision;
  const current = () => generation === omp.generation && revision === conversationRevision && get().status === "ready";
  let moved = false;
  set({ branching: true });
  try {
    const response = await omp.send<NavigateTreeResult>({ type: "navigate_tree", entryId, summarize: false });
    if (!current()) return false;
    if (!response.data) throw new Error("The runtime did not return a tree navigation result.");
    if (response.data.cancelled || response.data.aborted) {
      pushToast(set, "warning", "Conversation branch change was cancelled.");
      return false;
    }
    moved = true;
    set({ pending: [], toolRuns: {}, subagents: {}, subagentMessages: {}, notices: [], dialogs: [], statusMarks: {}, widgets: {}, messageBranches: [] });
    if (draft) {
      // Submit only after the runtime has moved to the edited message's parent.
      // Do not use prompt(): ordinary submissions stay locked during this transition.
      set({ busy: true });
      const result = await omp.send<{ agentInvoked?: boolean }>({
        type: "prompt",
        message: draft.text.trim(),
        ...(draft.images.length ? { images: draft.images } : {}),
      });
      if (!current()) return false;
      if (result.data?.agentInvoked === false) set({ busy: false });
    } else if (response.data.editorText !== undefined) {
      // omp rewinds a user-only leaf into a draft rather than selecting it.
      // Preserve that behavior when a branch was aborted before any reply.
      const nodes = [...(state.sessionTree?.tree ?? [])];
      let images: ImageContent[] = [];
      while (nodes.length) {
        const node = nodes.pop()!;
        if (node.entry.id === entryId) {
          images = imageBlocks(node.entry.message?.content);
          break;
        }
        nodes.push(...node.children);
      }
      set((value) => ({ draftText: response.data!.editorText ?? "", draftImages: images, editorToken: value.editorToken + 1 }));
    }
    await get().refreshAll();
    return current();
  } catch (error) {
    if (current()) {
      set({ busy: false });
      if (moved && draft) {
        set((value) => ({ draftText: draft.text, draftImages: draft.images, editorToken: value.editorToken + 1 }));
      }
      pushToast(set, "error", `Conversation branch failed: ${describeError(error)}`);
      if (moved) await get().refreshAll();
    }
    return false;
  } finally {
    if (current()) set({ branching: false });
  }
}

function pushToast(set: SetState, kind: Toast["kind"], message: string, title?: string) {
  const toast: Toast = { id: ++toastSeq, kind, message, title };
  set((state) => ({ notifications: [...state.notifications.slice(-6), toast] }));
  window.setTimeout(() => {
    useAppStore.setState((state) => ({ notifications: state.notifications.filter((entry) => entry.id !== toast.id) }));
  }, kind === "error" ? 12_000 : 6000);
}

function pushNotice(set: SetState, kind: NoticeItem["kind"], message: string) {
  const notice: NoticeItem = { id: ++noticeSeq, kind, message, at: Date.now() };
  set((state) => ({ notices: [...state.notices.slice(-80), notice] }));
}

function appendDiagnostic(set: SetState, line: string) {
  set((state) => ({ diagnostics: [...state.diagnostics.slice(-200), line] }));
}

function upsertToolRun(
  set: SetState,
  frame: RpcFrame,
  status: ToolRun["status"],
) {
  const toolCallId = String(frame.toolCallId ?? "");
  const toolName = String(frame.toolName ?? "");
  if (!toolCallId) return;
  const previous = useAppStore.getState().toolRuns[toolCallId];
  const now = Date.now();
  const result = "result" in frame ? frame.result : "partialResult" in frame ? frame.partialResult : undefined;
  const output = extractToolOutput(result) ?? previous?.output;
  const run: ToolRun = {
    toolCallId,
    toolName,
    args: isRecord(frame.args) ? frame.args : previous?.args,
    status,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    output,
    images: isRecord(result) && Array.isArray(result.content) ? imageBlocks(result.content) : previous?.images,
    details: extractToolDetails(result) ?? previous?.details,
  };
  set((state) => ({ toolRuns: { ...state.toolRuns, [toolCallId]: run } }));
}

function extractToolOutput(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if (!("content" in result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
  return text || undefined;
}

function extractToolDetails(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  return result.details;
}

function handleExtensionRequest(request: ExtensionUIRequest, set: SetState, get: () => AppState) {
  switch (request.method) {
    case "notify": {
      const kind = request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info";
      pushToast(set, kind, request.message);
      return;
    }
    case "setStatus": {
      if (request.statusKey === "ompd:workspace") {
        const cwd = request.statusText;
        if (!cwd || cwd === get().cwd) return;
        runtimeModifiedTimes.set(id, Date.now());
        if (activeRuntime === runtime) localStorage.setItem(LAST_CWD_KEY, cwd);
        set({
          cwd,
          gitStatus: undefined,
          gitStatusError: undefined,
          ...catalogSnapshot(catalogCacheKey(cwd, get().preferences)),
        });
        void get().loadSessions();
        void get().fetchModels();
        void get().refreshGitStatus();
        return;
      }
      set((state) => {
        const statusMarks = { ...state.statusMarks };
        if (request.statusText) statusMarks[request.statusKey] = request.statusText;
        else delete statusMarks[request.statusKey];
        return { statusMarks };
      });
      return;
    }
    case "setWidget": {
      set((state) => {
        const widgets = { ...state.widgets };
        if (request.widgetLines?.length) widgets[request.widgetKey] = request.widgetLines;
        else delete widgets[request.widgetKey];
        return { widgets };
      });
      return;
    }
    case "setTitle":
      setTitle(`${request.title} — omp-d`);
      return;
    case "set_editor_text":
      get().setEditorText(request.text);
      return;
    case "open_url":
      void openUrl(request.url).catch((error) => pushToast(set, "warning", `Could not open link: ${describeError(error)}`));
      return;
    case "cancel":
      set((state) => ({ dialogs: state.dialogs.filter((dialog) => dialog.id !== request.targetId) }));
      return;
    case "select":
    case "confirm":
    case "input":
    case "editor":
    case "ask":
      set((state) => ({ dialogs: [...state.dialogs, request] }));
      return;
    default:
      return;
  }
}

function setTitle(title: string) {
  if (activeRuntime === runtime) document.title = title;
}

omp.on((event) => runtime.getState().handleEvent(event));
return runtime;
}

type RuntimeStore = UseBoundStore<StoreApi<AppState>>;
const runtimes = new Map<number, { store: RuntimeStore; path?: string }>();
let runtimeSequence = 0;
let activeRuntime = createRuntimeStore(++runtimeSequence);
runtimes.set(runtimeSequence, { store: activeRuntime });

// React subscribes to a stable facade. Async actions retain their originating
// store/client, so completion in a hidden session never mutates the selected one.
export const useAppStore = create<AppState>()(() => activeRuntime.getState());

configureSessionNavigation({
  newSession: (cwd) => useAppStore.getState().newSession(cwd),
  switchSession: (path, cwd) => useAppStore.getState().switchSession(path, cwd),
  selectOpenSession: (cwd, path) => {
    const entries = [...runtimes.values()];
    const existing = path
      ? entries.find((entry) => sessionPathKey(entry.store.getState().session?.sessionFile ?? entry.path) === sessionPathKey(path))
      : entries.find((entry) => sessionPathKey(entry.store.getState().cwd) === sessionPathKey(cwd));
    if (!existing) return false;
    selectRuntime(existing.store.getState().activeRuntimeId);
    return true;
  },
});
useSessionNavigation.subscribe(({ repositoryCwd, sessionListing, sessionsLoading }) => {
  if (repositoryCwd) localStorage.setItem(LAST_PROJECT_KEY, repositoryCwd);
  useAppStore.setState({ sessionListing, sessionsLoading });
});

/** A runtime exists as soon as omp starts; conversation is what makes it a session. */
function hasSessionActivity(state: AppState): boolean {
  return Boolean(state.messages.length || state.pending.length || state.busy
    || state.session?.messageCount || state.session?.hasPendingAsyncWork
    || state.session?.queuedMessageCount || state.session?.sessionName
    || state.session?.sessionTitle || state.session?.goal);
}

function publishRuntimes() {
  const openSessions = [...runtimes].filter(([, { store, path }]) =>
    path || hasSessionActivity(store.getState())).map(([id, { store, path }]): OpenSession => {
    const state = store.getState();
    return {
      id,
      path: state.session?.sessionFile ?? path,
      cwd: state.cwd,
      title: sessionTitle(state.session),
      modifiedMs: Math.max(runtimeModifiedTimes.get(id) ?? 0,
        useSessionNavigation.getState().sessionListing?.sessions.find((session) =>
          sessionPathKey(session.path) === sessionPathKey(state.session?.sessionFile ?? path))?.modifiedMs ?? 0),
      busy: state.busy || Boolean(state.session?.hasPendingAsyncWork),
      dialogs: state.dialogs.length,
      status: state.status,
    };
  });
  const navigation = useSessionNavigation.getState();
  useAppStore.setState({ ...activeRuntime.getState(), openSessions,
    sessionListing: navigation.sessionListing, sessionsLoading: navigation.sessionsLoading }, true);
  const active = activeRuntime.getState();
  if (active.cwd) {
    const path = (hasSessionActivity(active) ? active.session?.sessionFile : undefined)
      ?? runtimes.get(active.activeRuntimeId)?.path;
    rememberActiveSession(active.cwd, path);
    localStorage.setItem(LAST_CWD_KEY, active.cwd);
    const project = useSessionNavigation.getState().repositoryCwd;
    if (project) localStorage.setItem(LAST_PROJECT_KEY, project);
    if (path) localStorage.setItem(LAST_SESSION_KEY, path);
    else localStorage.removeItem(LAST_SESSION_KEY);
  }
}

activeRuntime.subscribe(publishRuntimes);

function selectRuntime(id: number) {
  const entry = runtimes.get(id);
  if (!entry) return;
  activeRuntime = entry.store;
  publishRuntimes();
  const state = activeRuntime.getState();
  document.title = `${sessionTitle(state.session)} — omp-d`;
  if (state.cwd) localStorage.setItem(LAST_CWD_KEY, state.cwd);
  void state.loadSessions();
}

async function openRuntime(cwd: string, path?: string) {
  if (!path) {
    // An untouched composer is reused instead of spawning a second untracked runtime.
    const empty = [...runtimes.values()].find((entry) => !entry.path
      && entry.store.getState().status === "ready"
      && sessionPathKey(entry.store.getState().cwd) === sessionPathKey(cwd)
      && !hasSessionActivity(entry.store.getState()));
    if (empty) {
      selectRuntime(empty.store.getState().activeRuntimeId);
      return empty.store;
    }
  }
  if (!path && !activeRuntime.getState().cwd && activeRuntime.getState().status === "idle") {
    const store = activeRuntime;
    await store.getState().connect(cwd);
    return store;
  }
  const id = ++runtimeSequence;
  const store = createRuntimeStore(id, path);
  store.setState({ preferences: activeRuntime.getState().preferences });
  runtimes.set(id, { store, path });
  store.subscribe(publishRuntimes);
  selectRuntime(id);
  await store.getState().connect(cwd);
  return store;
}


/* --------------------------------------------------------------- utilities */

export function sessionTitle(session: RpcSessionState | undefined, fallback = "Untitled session"): string {
  if (!session) return fallback;
  const title = stripPrivateUse(session.sessionName || session.sessionTitle || "");
  if (title) return title;
  return fallback;
}

export function activeTodos(phases: TodoPhase[] | undefined): { total: number; open: number; inProgress: number; completed: number } {
  const tasks = (phases ?? []).flatMap((phase) => phase.tasks ?? []);
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "pending").length,
    inProgress: tasks.filter((task) => task.status === "in_progress").length,
    completed: tasks.filter((task) => task.status === "completed").length,
  };
}
