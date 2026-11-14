import type { ToolRun } from "./store";
import type { AgentMessage, SubagentSnapshot } from "./types";

export interface InspectorAgent {
  id: string;
  name: string;
  status: "running" | "success" | "error" | "waiting";
  activity: string;
  /** True when only task-tool snapshots are available, without live lifecycle state. */
  snapshot: boolean;
  updatedAt: number;
  /** Actual child transcript tool runs when loaded, otherwise associated task invocations. */
  runs: ToolRun[];
  output?: string;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const entry = record(item);
    return entry ? [entry] : [];
  }) : [];
}

/** Merge persisted tool results with newer streaming snapshots by their wire toolCallId. */
function sessionRuns(messages: AgentMessage[], toolRuns: Record<string, ToolRun>): ToolRun[] {
  const calls = new Map<string, { args: RecordValue; timestamp: number }>();
  const runs = new Map<string, ToolRun>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const call = record(block);
        const args = record(call?.arguments);
        if (call?.type === "toolCall" && typeof call.id === "string" && args && typeof message.timestamp === "number") {
          calls.set(call.id, { args, timestamp: message.timestamp });
        }
      }
    }
    if (message.role !== "toolResult") continue;
    const result = record(message);
    if (!result || typeof result.toolCallId !== "string" || typeof result.toolName !== "string"
      || typeof result.timestamp !== "number" || typeof result.isError !== "boolean") continue;
    const call = calls.get(result.toolCallId);
    const timestamp = result.timestamp;
    const output = records(result.content).filter((part) => part.type === "text")
      .map((part) => typeof part.text === "string" ? part.text : "").join("");
    runs.set(result.toolCallId, {
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      args: call?.args,
      status: result.isError === true ? "error" : "success",
      startedAt: call?.timestamp ?? timestamp,
      updatedAt: timestamp,
      details: result.details,
      output: output || undefined,
    });
  }
  for (const run of Object.values(toolRuns)) {
    const persisted = runs.get(run.toolCallId);
    runs.set(run.toolCallId, { ...persisted, ...run, args: run.args ?? persisted?.args });
  }
  return [...runs.values()];
}

function progressStatus(value: unknown): InspectorAgent["status"] | undefined {
  switch (value) {
    case "pending": return "waiting";
    case "running": return "running";
    case "completed": return "success";
    case "failed":
    case "aborted": return "error";
    default: return undefined;
  }
}

/** Projects task snapshots, overridden by subscribed lifecycle/progress when available. */
export function projectInspectorAgents(
  toolRuns: Record<string, ToolRun>,
  messages: AgentMessage[],
  subagents: Record<string, SubagentSnapshot> = {},
  subagentMessages: Record<string, AgentMessage[]> = {},
): InspectorAgent[] {
  const agents = new Map<string, InspectorAgent>();
  const visit = (details: unknown, run: ToolRun) => {
    const snapshot = record(details);
    if (!snapshot) return;
    // Results supersede progress for the same ID in a snapshot.
    for (const [entries, completed] of [[records(snapshot.progress), false], [records(snapshot.results), true]] as const) {
      for (const entry of entries) {
        const id = text(entry.id);
        const status = completed
          ? typeof entry.exitCode === "number"
            ? entry.aborted === true || entry.exitCode !== 0 ? "error" : "success"
            : undefined
          : progressStatus(entry.status);
        if (!id || !status) continue;
        const previous = agents.get(id);
        const retry = record(entry.retryState);
        const tool = text(entry.currentTool);
        const toolArgs = text(entry.currentToolArgs);
        const activity = text(entry.error) ?? text(record(entry.retryFailure)?.errorMessage)
          ?? text(retry?.errorMessage)
          ?? (tool ? [tool, toolArgs].filter(Boolean).join(" ") : undefined)
          ?? text(entry.lastIntent) ?? text(entry.description) ?? text(entry.task) ?? "";
        const recentOutput = Array.isArray(entry.recentOutput)
          ? entry.recentOutput.filter((line): line is string => typeof line === "string").join("\n")
          : undefined;
        const runs = previous?.runs ?? [];
        if (!runs.some((candidate) => candidate.toolCallId === run.toolCallId)) runs.push(run);
        agents.set(id, {
          id,
          name: id,
          status: !completed && status === "running" && retry ? "waiting" : status,
          activity,
          snapshot: true,
          updatedAt: run.updatedAt,
          runs,
          output: text(entry.output) ?? text(recentOutput) ?? previous?.output,
        });
        visit(entry.inflightTaskDetails, run);
        const extracted = record(entry.extractedToolData);
        for (const nested of records(extracted?.task)) visit(nested, run);
      }
    }
  };
  for (const run of sessionRuns(messages, toolRuns)) {
    if (run.toolName === "task") visit(run.details, run);
  }
  for (const live of Object.values(subagents)) {
    const status = progressStatus(live.status);
    if (!status) continue;
    const previous = agents.get(live.id);
    if (previous && (previous.status === "success" || previous.status === "error")
      && previous.updatedAt > live.lastUpdate) continue;
    const progress = live.progress;
    const currentTool = progress?.currentTool;
    const activity = progress?.retryFailure?.errorMessage ?? progress?.retryState?.errorMessage
      ?? (currentTool ? [currentTool, progress?.currentToolArgs].filter(Boolean).join(" ") : undefined)
      ?? progress?.lastIntent ?? live.description ?? live.task ?? previous?.activity ?? "";
    const transcript = subagentMessages[live.id];
    agents.set(live.id, {
      id: live.id,
      name: live.id,
      status: status === "running" && progress?.retryState ? "waiting" : status,
      activity,
      snapshot: false,
      updatedAt: live.lastUpdate,
      runs: transcript ? sessionRuns(transcript, {}) : previous?.runs ?? [],
      output: text(progress?.recentOutput?.join("\n")) ?? previous?.output,
    });
  }
  for (const [id, transcript] of Object.entries(subagentMessages)) {
    const agent = agents.get(id);
    if (agent) {
      agent.runs = sessionRuns(transcript, {});
      const output = transcript.filter((message) => message.role === "assistant")
        .flatMap((message) => records(message.content).filter((part) => part.type === "text"))
        .map((part) => text(part.text)).filter(Boolean).join("\n\n");
      if (output) agent.output = output;
    }
  }
  return [...agents.values()];
}

function addPath(paths: Set<string>, value: unknown): void {
  const path = text(value);
  // Internal URLs identify tools, messages, artifacts, remote files, etc., not Git files.
  if (!path || /^[a-z][a-z\d+.-]*:\/\//i.test(path)) return;
  paths.add(path.replace(/\\/g, "/").replace(/^\.\//, ""));
}

function addEditPaths(paths: Set<string>, details: RecordValue, fallbackPath?: unknown): void {
  if (details.isError === true) return;
  const changed = Boolean(text(details.diff)) || details.op === "create" || details.op === "delete"
    || Boolean(text(details.move)) || Boolean(text(details.sourcePath));
  if (!changed) return;
  addPath(paths, details.path ?? fallbackPath);
  addPath(paths, details.sourcePath);
  addPath(paths, details.move);
}

/** Successfully mutated files evidenced by this session, not every file in its Git diff. */
export function sessionChangedPaths(messages: AgentMessage[], toolRuns: Record<string, ToolRun>): Set<string> {
  const paths = new Set<string>();
  for (const run of sessionRuns(messages, toolRuns)) {
    if (run.status === "running") continue;
    const details = record(run.details);
    if (run.toolName === "edit") {
      // A failed multi-file call can still explicitly report successfully applied entries.
      if (Array.isArray(details?.perFileResults)) {
        for (const entry of records(details.perFileResults)) addEditPaths(paths, entry);
      } else if (run.status === "success" && details) {
        addEditPaths(paths, details, run.args?.path ?? run.args?.file_path);
      }
    } else if (run.toolName === "write" && run.status === "success") {
      // write also dispatches internal tool URLs; do not mistake dispatch args for files.
      if (run.args?.path === undefined || typeof run.args.path === "string" && !/^[a-z][a-z\d+.-]*:\/\//i.test(run.args.path)) {
        addPath(paths, details?.resolvedPath ?? run.args?.path);
      }
    } else if (run.toolName === "ast_edit" && run.status === "success" && details?.applied === true) {
      for (const entry of records(details.fileReplacements)) {
        if (typeof entry.count !== "number" || entry.count <= 0) continue;
        const path = text(entry.path);
        const cwd = text(details.cwd);
        if (path && cwd && !/^(?:[a-z]:[\\/]|[\\/])/i.test(path)) {
          addPath(paths, `${cwd}/${path}`);
        } else addPath(paths, path);
      }
    }
  }
  return paths;
}
