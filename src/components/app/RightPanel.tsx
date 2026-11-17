import { useState } from "react";
import { Check, ChevronRight, Circle, CircleAlert, CircleDot, LoaderCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCost, formatTokens } from "@/lib/omp/format";
import type { ChangedFile, InspectorData, InspectorSelection } from "@/lib/omp/inspector-data";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function InspectorStatus({ status }: { status: string }) {
  if (status === "running" || status === "in_progress") return <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-400 motion-reduce:animate-none" />;
  if (status === "error" || status === "blocked") return <CircleAlert aria-label="Needs attention" className="size-3.5 shrink-0 text-destructive" />;
  if (status === "waiting") return <CircleDot aria-label="Waiting" className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />;
  if (status === "completed" || status === "success") return <Check aria-label="Completed" className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />;
  return <Circle aria-label="Pending" className="size-3.5 shrink-0 text-muted-foreground" />;
}

export function FileChangeRow({ file, onClick }: { file: ChangedFile; onClick: () => void }) {
  return <button type="button" onClick={onClick} title={file.path} className="inspector-row group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
    <span title={file.status} className={cn("w-3 shrink-0 font-mono text-[10px]", file.status === "conflicted" ? "text-destructive" : file.status === "added" || file.status === "untracked" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>{file.status === "untracked" ? "?" : file.status === "conflicted" ? "!" : file.status[0].toUpperCase()}</span>
    <span className="min-w-0 flex-1 truncate">{file.path}</span>
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      {file.additions !== null && <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>}
      {file.deletions !== null && <span className="ml-1.5 text-destructive">−{file.deletions}</span>}
    </span>
  </button>;
}

export function RightPanel({ data, onInspect, onClose }: { data: InspectorData; onInspect: (selection: InspectorSelection) => void; onClose: () => void }) {
  const { session, tasks, activeTask, agents, files, state, activity } = data;
  const [changesExpanded, setChangesExpanded] = useState(false);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const activeAgents = agents.filter((agent) => agent.status !== "success");
  const finishedAgents = agents.length - activeAgents.length;
  const hasExecution = Boolean(session || data.runs.length || data.error);
  const usage = session?.contextUsage;
  const label = state === "error" ? "Needs attention" : state === "waiting" ? "Waiting" : state === "running" ? "Running" : "Completed";
  return (
    <aside aria-label="Inspector" className="inspector flex w-[272px] min-w-0 shrink-0 flex-col border-l bg-sidebar/40 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:w-[min(272px,100vw)] max-lg:bg-sidebar">
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-xs font-medium">Inspector</h2>
        {hasExecution && <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><InspectorStatus status={state} />{label}</span>}
        <button type="button" aria-label="Close Inspector" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"><X className="size-3.5" /></button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3">
        {hasExecution && <section aria-label="Execution" className="border-b py-4">
          <h3 className="mb-2 px-1 text-[11px] font-medium text-muted-foreground">Execution</h3>
          {session?.goal?.goal.objective && <button type="button" onClick={() => onInspect({ kind: "tasks" })} className="mb-2 w-full rounded px-1 text-left text-xs leading-5 hover:text-muted-foreground" title={session.goal.goal.objective}><span className="line-clamp-2">{session.goal.goal.objective}</span></button>}
          {tasks.length > 0 && <button type="button" onClick={() => onInspect({ kind: "tasks" })} className="mb-3 block w-full rounded px-1 py-1 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
            <span className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground"><span>{activeTask?.status === "blocked" ? "Blocked" : activeTask?.status === "pending" ? "Up next" : activeTask ? "In progress" : "Tasks completed"}</span><span className="tabular-nums">{completed}/{tasks.length}</span></span>
            {activeTask && <span className="mb-2 line-clamp-2 text-xs leading-5">{activeTask.content}</span>}
            <span role="progressbar" aria-label="Task progress" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={tasks.length} className="block h-0.5 overflow-hidden rounded-full bg-border"><span className="block h-full bg-foreground/40" style={{ width: `${completed / tasks.length * 100}%` }} /></span>
          </button>}
          <div className={cn("flex flex-col gap-0.5", state === "completed" && "inspector-settled")}>
            {activeAgents.filter((agent) => agent.status === "error" || agent.status === "waiting").map((agent) => <AgentRow key={agent.id} name={agent.name} status={agent.status} snapshot={agent.snapshot} activity={agent.activity} onClick={() => onInspect({ kind: "agent", id: agent.id })} />)}
            <AgentRow name="Main" status={data.mainState} activity={activity} onClick={() => onInspect({ kind: "agent", id: "main" })} />
            {activeAgents.filter((agent) => agent.status !== "error" && agent.status !== "waiting").map((agent) => <AgentRow key={agent.id} name={agent.name} status={agent.status} snapshot={agent.snapshot} activity={agent.activity} onClick={() => onInspect({ kind: "agent", id: agent.id })} />)}
          </div>
          {finishedAgents > 0 && <button type="button" onClick={() => onInspect({ kind: "agent", id: "all" })} className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-sidebar-accent"><Check className="size-3" />{finishedAgents} {finishedAgents === 1 ? "agent" : "agents"} completed<ChevronRight className="ml-auto size-3" /></button>}
        </section>}
        {files && files.length > 0 && <section aria-label="Changes" className="py-4">
          <div className="mb-2 flex items-center justify-between px-1"><h3 className="text-[11px] font-medium text-muted-foreground">Changes</h3><span className="text-[10px] tabular-nums text-muted-foreground">{files.length} files</span></div>
          <div id="inspector-changes" className="inspector-files">{[...files].sort((a, b) => Number(b.status === "conflicted") - Number(a.status === "conflicted") || Number(data.sessionFiles?.includes(b)) - Number(data.sessionFiles?.includes(a))).slice(0, changesExpanded ? undefined : 5).map((file) => <FileChangeRow key={file.path} file={file} onClick={() => onInspect({ kind: "diff", path: file.path })} />)}</div>
          {files.length > 5 && <button type="button" aria-expanded={changesExpanded} aria-controls="inspector-changes" onClick={() => setChangesExpanded((expanded) => !expanded)} className="mt-2 flex w-full items-center justify-between rounded px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{changesExpanded ? "Show fewer changes" : "View all changes"}<ChevronRight className={cn("size-3", changesExpanded && "rotate-90")} /></button>}
        </section>}
        {data.gitError && <button type="button" onClick={() => onInspect({ kind: "changes" })} className="my-3 flex items-center gap-2 px-1 text-left text-[11px] text-destructive"><CircleAlert className="size-3.5" />Cannot read Git changes<ChevronRight className="size-3" /></button>}
      </div>
      {(usage || data.stats) && <Tooltip>
        <TooltipTrigger render={<div tabIndex={0} aria-label="Context resources" />} className="shrink-0 border-t px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">Context</span><span className="tabular-nums">{usage ? `${Math.max(0, 100 - usage.percent).toFixed(0)}% left` : `${formatTokens(data.stats?.tokens.total)} tokens`}</span></span>
          {usage && <span role="progressbar" aria-label="Context used" aria-valuenow={Math.round(usage.percent)} aria-valuemin={0} aria-valuemax={100} className="mt-2 block h-1 overflow-hidden rounded-full bg-border"><span className={cn("block h-full rounded-full", usage.percent >= 90 ? "bg-destructive" : usage.percent >= 75 ? "bg-amber-600 dark:bg-amber-400" : "bg-muted-foreground/50")} style={{ width: `${Math.max(0, Math.min(100, usage.percent))}%` }} /></span>}
        </TooltipTrigger>
        <TooltipContent side="top" align="end" sideOffset={8} className="block w-80 max-w-[calc(100vw-2rem)] px-4 py-3">
          <p className="mb-2 font-medium">Resources</p>
          <dl className="space-y-2">
            {usage && <><Resource label="Context used" value={`${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens (${usage.percent.toFixed(1)}%)`} /><Resource label="Context remaining" value={`${formatTokens(Math.max(0, usage.contextWindow - usage.tokens))} tokens`} /></>}
            {data.stats && <><Resource label="Input tokens" value={formatTokens(data.stats.tokens.input)} /><Resource label="Output tokens" value={formatTokens(data.stats.tokens.output)} /><Resource label="Reasoning tokens" value={formatTokens(data.stats.tokens.reasoning)} /><Resource label="Cache read / write" value={`${formatTokens(data.stats.tokens.cacheRead)} / ${formatTokens(data.stats.tokens.cacheWrite)}`} /><Resource label="Estimated cost" value={formatCost(data.stats.cost)} /></>}
            {session?.autoCompactionEnabled && <Resource label="Auto compaction" value="Enabled" />}
          </dl>
        </TooltipContent>
      </Tooltip>}
    </aside>
  );
}

function Resource({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt className="opacity-70">{label}</dt><dd className="tabular-nums">{value}</dd></div>;
}

function AgentRow({ name, status, activity, snapshot, onClick }: { name: string; status: string; activity?: string; snapshot?: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inspector-agent flex w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
    <span className="mt-0.5"><InspectorStatus status={snapshot ? "snapshot" : status} /></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2 text-xs"><span className="truncate font-medium">{name}</span><span className="text-[10px] font-normal text-muted-foreground">{snapshot ? "Snapshot" : status === "error" ? "Failed" : status === "success" || status === "completed" ? "Completed" : status === "waiting" ? "Waiting" : "Running"}</span></span>{activity && <span className="inspector-activity mt-0.5 block truncate text-[11px] text-muted-foreground" title={activity}>{activity}</span>}</span>
  </button>;
}
