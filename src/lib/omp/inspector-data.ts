import { useEffect, useMemo, useState } from "react";
import { invoke } from "@/lib/diagnostics";
import { useAppStore, type ToolRun } from "./store";
import { projectInspectorAgents, sessionChangedPaths } from "./inspector";
import { toolArgSummary } from "./format";

export interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}
export type InspectorSelection = { kind: "tasks" | "changes" } | { kind: "agent"; id: string } | { kind: "diff"; path: string };

export function useInspectorData() {
  const session = useAppStore((state) => state.session);
  const stats = useAppStore((state) => state.stats);
  const cwd = useAppStore((state) => state.cwd);
  const busy = useAppStore((state) => state.busy);
  const status = useAppStore((state) => state.status);
  const error = useAppStore((state) => state.error);
  const dialogs = useAppStore((state) => state.dialogs);
  const toolRuns = useAppStore((state) => state.toolRuns);
  const messages = useAppStore((state) => state.messages);
  const subagents = useAppStore((state) => state.subagents);
  const subagentMessages = useAppStore((state) => state.subagentMessages);
  const refreshSubagentMessages = useAppStore((state) => state.refreshSubagentMessages);
  const notices = useAppStore((state) => state.notices);
  const widgets = useAppStore((state) => state.widgets);
  const statusMarks = useAppStore((state) => state.statusMarks);
  const [git, setGit] = useState<{ cwd: string; busy: boolean; root?: string; files?: ChangedFile[]; error?: string }>();
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    let querying = false;
    async function refresh() {
      if (querying) return;
      querying = true;
      try {
        const result = await invoke<{ root: string; files: ChangedFile[] } | null>("get_git_changes", { cwd });
        if (!cancelled) setGit({ cwd: cwd!, busy, root: result?.root, files: result?.files });
      } catch (cause) {
        if (!cancelled) setGit({ cwd: cwd!, busy, error: String(cause) });
      } finally { querying = false; }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener("focus", refresh); };
  }, [cwd, busy]);
  const runs = useMemo(() => Object.values(toolRuns).sort((a, b) => b.startedAt - a.startedAt), [toolRuns]);
  const agents = useMemo(() => projectInspectorAgents(toolRuns, messages, subagents, subagentMessages), [toolRuns, messages, subagents, subagentMessages]);
  const touched = useMemo(() => sessionChangedPaths(messages, toolRuns), [messages, toolRuns]);
  const currentGit = git?.cwd === cwd && git?.busy === busy ? git : undefined;
  const files = currentGit?.files;
  const sessionFiles = useMemo(() => {
    const normalize = (path: string) => {
      const value = path.replace(/\\/g, "/").replace(/^\.\/|\/*$/g, "");
      return /^[a-z]:\//i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
    };
    const root = normalize(currentGit?.root ?? cwd ?? "");
    const workspace = normalize(cwd ?? "");
    const absolutePaths = new Set([...touched].map((path) => {
      const value = normalize(path);
      return /^(?:[a-z]:\/|\/)/i.test(value) ? value : `${workspace}/${value}`;
    }));
    return files?.filter((file) => absolutePaths.has(normalize(`${root}/${file.path}`)));
  }, [files, touched, currentGit?.root, cwd]);
  const tasks = session?.todoPhases.flatMap((phase) => phase.tasks) ?? [];
  const activeTask = tasks.find((task) => task.status === "blocked") ?? tasks.find((task) => task.status === "in_progress") ?? tasks.find((task) => task.status === "pending");
  const latestRun = runs[0];
  const running = runs.filter((run) => run.status === "running");
  const failed = latestRun?.status === "error" ? latestRun : undefined;
  const waiting = dialogs.length > 0 || (!busy && session?.hasPendingAsyncWork);
  const mainState = error || status === "error" || failed ? "error" : waiting ? "waiting" : busy || running.length > 0 || session?.isStreaming || session?.isCompacting ? "running" : "completed";
  const liveAgents = agents.filter((agent) => !agent.snapshot);
  const state = mainState === "error" || liveAgents.some((agent) => agent.status === "error") ? "error"
    : mainState === "waiting" || activeTask?.status === "blocked" || liveAgents.some((agent) => agent.status === "waiting") ? "waiting"
    : mainState === "running" || liveAgents.some((agent) => agent.status === "running") ? "running" : "completed";
  const activity = error ?? (dialogs.length ? "Your response is required" : failed ? `${failed.toolName} failed` : running[0] ? describeRun(running[0]) : session?.isCompacting ? "Compacting context" : busy ? "Generating response" : session?.hasPendingAsyncWork ? "Waiting for background work" : "Turn completed");
  return { session, stats, cwd, runs, messages, agents, tasks, activeTask, files, sessionFiles, gitLoading: Boolean(cwd && !currentGit), gitError: currentGit?.error, state, mainState, activity, error, notices, widgets, statusMarks, refreshSubagentMessages };
}
export type InspectorData = ReturnType<typeof useInspectorData>;
export function describeRun(run: ToolRun) {
  return String(run.args?.i ?? run.args?.intent ?? toolArgSummary(run.toolName, run.args) ?? run.toolName) || run.toolName;
}
