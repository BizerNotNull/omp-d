/**
 * Wire types for the omp RPC protocol (`omp --mode rpc-ui`).
 *
 * The protocol is newline-delimited JSON, not JSON-RPC. Commands carry an
 * optional `id` that responses echo; unsolicited events share stdout with
 * responses and are discriminated by `type`.
 */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  narration?: boolean;
  summary?: boolean;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  intent?: string;
}

export type AssistantContent =
  | TextContent
  | ThinkingContent
  | ImageContent
  | ToolCallContent
  | { type: string; [key: string]: unknown };

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: UsageCost;
  premiumRequests?: number;
}

export interface Model {
  provider: string;
  id: string;
  name?: string;
  kind?: string;
  /** Catalog availability; false models are browsable but cannot be selected. */
  available?: boolean;
  selector?: string;
  maxTokens?: number;
  reasoning?: boolean;
  thinking?: string[];
  pricingStatus?: string;
  api?: string;
  contextWindow?: number;
  maxContextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  input?: string[];
}

export interface UserMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  attribution?: string;
  synthetic?: boolean;
  steering?: boolean;
  liveSteered?: boolean;
  timestamp: number;
  [key: string]: unknown;
}

export interface DeveloperMessage {
  role: "developer";
  content: string | Array<TextContent | ImageContent>;
  synthetic?: boolean;
  timestamp: number;
  [key: string]: unknown;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
  duration?: number;
  ttft?: number;
  completedAt?: number;
  retryRecovery?: unknown;
  [key: string]: unknown;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextContent | ImageContent>;
  details?: unknown;
  isError: boolean;
  timestamp: number;
  prunedAt?: number;
  [key: string]: unknown;
}

export interface CustomMessage {
  role: string;
  content?: string | Array<TextContent | ImageContent>;
  customType?: string;
  display?: boolean;
  details?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export type AgentMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage | CustomMessage;

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | string;
  activeForm?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface GoalModeState {
  objective?: string;
  status?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  tokenBudget?: number;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
  liveSteered?: number;
}

export interface RpcSessionState {
  model?: Model;
  thinkingLevel?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  interruptMode: "immediate" | "wait";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  slowModeSupported?: boolean;
  slowModeEnabled?: boolean;
  slowModeScope?: "session" | "global";
  usageLimit?: {
    stage: "wrap_up" | "low_priority";
    resetsAtSec?: number;
    allowanceLeftPercent?: number;
    extraUsage?: boolean;
  };
  tokensPerSecond: number | null;
  messageCount: number;
  queuedMessageCount: number;
  hasPendingAsyncWork: boolean;
  isSettled: boolean;
  queuedMessages: QueuedMessages;
  todoPhases: TodoPhase[];
  contextUsage?: ContextUsage;
  goal: GoalModeState | null;
  systemPrompt?: string[];
  dumpTools?: Array<{ name: string; description: string; parameters: unknown }>;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  premiumRequests: number;
  cost: number;
  routedModels?: Record<string, number>;
  editRejections?: Record<string, number>;
}

export interface AvailableCommand {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string; usage?: string }>;
  source: string;
}

export interface ReadyFrame {
  type: "ready";
  protocolVersion: 1;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

export interface RpcResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface PromptResultFrame {
  type: "prompt_result";
  id?: string;
  agentInvoked: boolean;
  status: "completed" | "aborted" | "error";
  error?: {
    message: string;
    provider?: string;
    model?: string;
    httpStatus?: number;
    retryable: boolean;
    code?: string;
  };
  sessionSettled: boolean;
}

export interface AgentEventFrame {
  type: string;
  [key: string]: unknown;
}

export interface MessageEventFrame {
  type: "message_start" | "message_update" | "message_end";
  messageId: string;
  message: AgentMessage;
  assistantMessageEvent?: AssistantMessageEvent;
}

export interface AssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  partial?: AssistantMessage;
  message?: AssistantMessage;
  toolCall?: ToolCallContent;
  error?: string;
}

export interface ToolExecutionFrame {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface QueueUpdateFrame {
  type: "queue_update";
  steering: string[];
  followUp: string[];
  liveSteered?: number;
}

export interface NoticeFrame {
  type: "notice";
  level: "info" | "warning" | "error";
  message: string;
  source?: string;
}

export interface TodoPhaseFrame {
  type: string;
  todoPhases?: TodoPhase[];
}

export interface AvailableCommandsFrame {
  type: "available_commands_update";
  commands: AvailableCommand[];
}

export interface RpcFrame {
  type: string;
  [key: string]: unknown;
}

/* ---------------------------------------------------------------- dialogs */

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  recommended?: number;
}

export type ExtensionUIRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      optionDetails?: Array<{ description?: string }>;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
      secret?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      promptStyle?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "ask";
      questions: AskQuestion[];
      timeout?: number;
    }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "open_url";
      url: string;
      launchUrl?: string;
      instructions?: string;
    };

export type ExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }
  | {
      type: "extension_ui_response";
      id: string;
      answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
    };

/* ----------------------------------------------------------- commands sent */

export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface StartInfo {
  generation: number;
  pid: number;
  program: string;
  args: string[];
  cwd: string;
}

export interface StartOptions {
  cwd: string;
  model?: string | null;
  binary?: string | null;
  extraArgs?: string[] | null;
}

export interface SessionSummary {
  path: string;
  sessionId: string;
  cwd: string;
  title?: string | null;
  preview?: string | null;
  modifiedMs: number;
  size: number;
}

export interface ProcessEvent {
  kind: "started" | "eof" | "exit" | "error" | "stopped";
  exitCode?: number | null;
  generation?: number;
  pid?: number;
  program?: string;
  args?: string[];
  message?: string;
}

export interface ProtocolEvent {
  kind: "parse_error" | "protocol_error";
  generation: number;
  message: string;
  line?: string;
}
