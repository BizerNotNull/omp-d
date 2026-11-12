import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { omp, RpcFailure, type OmpClientEvent } from "./client";
import { catalogCacheKey, readCatalog, splitExtraArgs, writeCatalog } from "./model-catalog";
import { projectMessageBranches, sessionTreeFromEntries, type MessageBranch } from "./branches";
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
  TodoPhase,
} from "./types";
import { firstLine, imageBlocks, modelLabel, stripPrivateUse } from "./format";

const LAST_CWD_KEY = "ompd:lastCwd";
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

interface AppState {
  initialized: boolean;
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

  sessionListing?: SessionListing;
  sessionsLoading: boolean;

  dialogs: DialogRequest[];
  notifications: Toast[];
  notices: NoticeItem[];
  statusMarks: Record<string, string>;
  widgets: Record<string, string[]>;
  diagnostics: string[];
  editorText?: string;
  editorToken: number;
  editorImages?: ImageContent[];

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

  newSession: () => Promise<void>;
  switchSession: (path: string) => Promise<void>;
  renameSession: (name: string) => Promise<void>;

  fetchModels: () => Promise<void>;
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
let connectTicket = 0;
let catalogRequest = 0;
let sessionsRequest = 0;
let refreshing: Promise<void> | undefined;
let refreshAgain = false;
let gitRefreshKey: string | undefined;
let conversationRevision = 0;
let treeRequest = 0;
let treeWarningGeneration: number | undefined;
let workspaceQuerySeq = 0;

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

export const useAppStore = create<AppState>()((set, get) => ({
  initialized: false,
  status: "idle",
  preferences: loadPreferences(),

  messages: [],
  messageKeys: new Set<string>(),
  pending: [],
  toolRuns: {},
  queue: { steering: [], followUp: [] },
  busy: false,
  messageBranches: [],
  treeLoading: false,
  branching: false,

  commands: [],
  thinkingLevels: [],
  modelsLoading: false,
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
    initialized = true;
    set({ initialized: true });
    omp.on((event) => useAppStore.getState().handleEvent(event));
    const cwd = localStorage.getItem(LAST_CWD_KEY);
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
    ++sessionsRequest;
    const preferences = { ...get().preferences, ...prefs };
    const cachedCatalog = readCatalog(catalogCacheKey(cwd, preferences));
    set({
      status: "starting",
      error: undefined,
      cwd,
      preferences,
      ...cachedCatalog,
      modelsLoading: false,
      modelsError: undefined,
      sessionListing: undefined,
      sessionsLoading: true,
      messages: withMessageKeys([]).messages,
      messageKeys: new Set<string>(),
      pending: [],
      toolRuns: {},
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
      localStorage.setItem(LAST_CWD_KEY, cwd);
      set({ status: "ready", startInfo: info, cwd: info.cwd });
      void get().fetchModels();
      await omp.send({ type: "set_ask_dialog", enabled: true }).catch(() => {});
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
    const previousSession = get().session?.sessionFile;
    if (!cwd) return;
    await get().connect(cwd);
    if (previousSession) {
      try {
        await omp.send({ type: "switch_session", sessionPath: previousSession });
        await get().refreshAll();
        await get().loadSessions();
      } catch (error) {
        pushToast(set, "warning", `Could not reopen the previous session: ${describeError(error)}`);
      }
    }
  },

  disconnect: async () => {
    ++connectTicket;
    await omp.stop();
    set({ status: "stopped", busy: false, branching: false, treeLoading: false, queue: { steering: [], followUp: [] }, modelsLoading: false, sessionsLoading: false });
  },

  updatePreferences: (partial) => {
    const previous = get().preferences;
    const preferences = { ...get().preferences, ...partial };
    savePreferences(preferences);
    set({ preferences });
    const cwd = get().cwd;
    if (cwd && catalogCacheKey(cwd, previous) !== catalogCacheKey(cwd, preferences)) {
      ++catalogRequest;
      set({ ...readCatalog(catalogCacheKey(cwd, preferences)), modelsLoading: false, modelsError: undefined });
      void get().fetchModels();
    }
  },

  openProjectDialog: async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open a project folder" });
    if (typeof selected === "string" && selected) {
      await get().connect(selected);
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
      if (session?.sessionName) document.title = `${session.sessionName} — omp-d`;
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
      document.title = session.sessionName ? `${stripPrivateUse(session.sessionName)} — omp-d` : "omp-d — Oh My Pi";
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
    const cwd = get().cwd;
    if (!cwd) return;
    const request = ++sessionsRequest;
    set({ sessionsLoading: true });
    try {
      const sessionListing = await invoke<SessionListing>("list_sessions", { cwd, limit: 40 });
      if (request !== sessionsRequest) return;
      set({ sessionListing, sessionsLoading: false });
    } catch (error) {
      if (request !== sessionsRequest) return;
      set({ sessionsLoading: false });
      pushToast(set, "warning", `Session list failed: ${describeError(error)}`);
    }
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

  newSession: async () => {
    if (get().branching) return;
    try {
      const res = await omp.send<{ cancelled: boolean }>({ type: "new_session" });
      if (res.data?.cancelled) {
        pushToast(set, "warning", "Session change was cancelled by an extension.");
        return;
      }
      ++conversationRevision;
      set({
        messages: [],
        messageKeys: new Set<string>(),
        sessionTree: undefined,
        messageBranches: [],
        pending: [],
        toolRuns: {},
        notices: [],
        stats: undefined,
        dialogs: [],
        statusMarks: {},
        widgets: {},
      });
      await get().refreshAll();
      await get().loadSessions();
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
  },

  switchSession: async (path) => {
    if (get().branching) return;
    try {
      const directory = get().sessionListing?.directories.find((entry) => entry.sessions.some((session) => session.path === path));
      if (directory && directory.cwd !== get().cwd) {
        await get().connect(directory.cwd);
        if (get().status !== "ready" || get().cwd !== directory.cwd) return;
      }
      const res = await omp.send<{ cancelled: boolean }>({ type: "switch_session", sessionPath: path });
      if (res.data?.cancelled) {
        pushToast(set, "warning", "Session switch was cancelled.");
        return;
      }
      ++conversationRevision;
      set({
        messages: [],
        messageKeys: new Set<string>(),
        sessionTree: undefined,
        messageBranches: [],
        pending: [],
        toolRuns: {},
        notices: [],
        stats: undefined,
        dialogs: [],
        statusMarks: {},
        widgets: {},
      });
      await get().refreshAll();
      await get().loadSessions();
    } catch (error) {
      pushToast(set, "error", describeError(error));
    }
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

  fetchModels: async () => {
    const { cwd, preferences, status, modelsLoading } = get();
    if (!cwd || modelsLoading || (status !== "ready" && status !== "starting")) return;
    const ticket = connectTicket;
    const key = catalogCacheKey(cwd, preferences);
    const options = { cwd, binary: preferences.binary.trim() || "omp", extraArgs: splitExtraArgs(preferences.extraArgs) };
    const request = ++catalogRequest;
    const current = () => ticket === connectTicket && request === catalogRequest && (get().status === "starting" || get().status === "ready");
    const persist = () => {
      const { models, modelRoles } = get();
      writeCatalog(key, { models, modelRoles });
    };
    set({ modelsLoading: true, modelsError: undefined });
    const results = await Promise.allSettled([
      invoke<Model[]>("model_catalog", { options }).then((models) => {
        if (!current()) return;
        set({ models });
        persist();
      }),
      invoke<Record<string, string>>("model_roles", { options }).then((modelRoles) => {
        if (!current()) return;
        set({ modelRoles });
        persist();
      }),
    ]);
    if (!current()) return;
    const errors = results.flatMap((result) => result.status === "rejected" ? [describeError(result.reason)] : []);
    if (options.extraArgs.some(arg => arg === "--config" || arg.startsWith("--config="))) {
      errors.push("Model roles reflect project/profile settings only; the CLI does not support config overlays for role queries.");
    }
    set({ modelsLoading: false, modelsError: errors.length ? errors.join("; ") : undefined });
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

  setEditorText: (text) => set((state) => ({ editorText: text, editorImages: undefined, editorToken: state.editorToken + 1 })),

  applyFrame: (frame) => {
    switch (frame.type) {
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
        set({ status: "ready" });
        return;
      case "disconnected":
        ++catalogRequest;
        set({ status: "stopped", busy: false, branching: false, treeLoading: false, error: event.reason, modelsLoading: false });
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
          ++catalogRequest;
          set({ status: "error", error: event.event.message, busy: false, branching: false, treeLoading: false, modelsLoading: false });
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
    set({ pending: [], toolRuns: {}, notices: [], dialogs: [], statusMarks: {}, widgets: {}, messageBranches: [] });
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
      set((value) => ({ editorText: response.data!.editorText, editorImages: images, editorToken: value.editorToken + 1 }));
    }
    await get().refreshAll();
    return current();
  } catch (error) {
    if (current()) {
      set({ busy: false });
      if (moved && draft) {
        set((value) => ({ editorText: draft.text, editorImages: draft.images, editorToken: value.editorToken + 1 }));
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
        ++sessionsRequest;
        ++catalogRequest;
        localStorage.setItem(LAST_CWD_KEY, cwd);
        set({
          cwd,
          sessionListing: undefined,
          sessionsLoading: false,
          gitStatus: undefined,
          gitStatusError: undefined,
          ...readCatalog(catalogCacheKey(cwd, get().preferences)),
          modelsLoading: false,
          modelsError: undefined,
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
      document.title = `${request.title} — omp-d`;
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

/* --------------------------------------------------------------- utilities */

export function sessionTitle(session: RpcSessionState | undefined, fallback = "Untitled session"): string {
  if (!session) return fallback;
  const title = stripPrivateUse(session.sessionName ?? "");
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
