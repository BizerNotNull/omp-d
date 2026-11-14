import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import type { InspectorData, InspectorSelection } from "@/lib/omp/inspector-data";
import { contentText, formatCost, formatTokens, stripAnsi } from "@/lib/omp/format";
import { cn } from "@/lib/utils";
import { FileChangeRow, InspectorStatus } from "./RightPanel";
import { ToolCard } from "./ToolCard";

export function InspectorDetail({ selection, data, onSelect, onClose }: { selection: InspectorSelection; data: InspectorData; onSelect: (value: InspectorSelection) => void; onClose: () => void }) {
  const [scope, setScope] = useState<"session" | "worktree">("worktree");
  const agent = selection.kind === "agent" ? data.agents.find((item) => item.id === selection.id) : undefined;
  const agentId = selection.kind === "agent" && selection.id !== "main" && selection.id !== "all" ? selection.id : undefined;
  const agentStatus = agent?.status;
  const refreshAgent = data.refreshSubagentMessages;
  useEffect(() => {
    if (!agentId) return;
    void refreshAgent(agentId);
    if (agentStatus !== "running" && agentStatus !== "waiting") return;
    const timer = window.setInterval(() => void refreshAgent(agentId), 2000);
    return () => window.clearInterval(timer);
  }, [agentId, agentStatus, refreshAgent]);
  const title = selection.kind === "tasks" ? "Task progress" : selection.kind === "context" ? "Resources" : selection.kind === "diff" ? selection.path : selection.kind === "changes" ? "Changes" : agent?.name ?? (selection.kind === "agent" && selection.id === "main" ? "Main agent" : "Agents");
  const usage = data.session?.contextUsage;
  const files = scope === "session" ? data.sessionFiles : data.files;
  const mainOutput = data.runs.length === 0 ? data.activity : undefined;
  return <section aria-label={title} className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex min-h-11 shrink-0 items-center gap-3 border-b px-4"><button type="button" onClick={onClose} className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="size-3.5" />Back to conversation</button><h2 className="truncate text-xs font-medium" title={title}>{title}</h2></header>
    <div className="scroll-thin min-h-0 flex-1 overflow-auto p-5">
      {selection.kind === "tasks" && <div className="mx-auto max-w-3xl space-y-6">
        {data.session?.goal && <div><p className="mb-1 text-xs text-muted-foreground">Goal · {data.session.goal.goal.status}</p><h3 className="text-base">{data.session.goal.goal.objective}</h3></div>}
        {data.session?.todoPhases.map((phase) => <section key={phase.name}><h3 className="mb-2 text-xs font-medium text-muted-foreground">{phase.name}</h3><ul className="divide-y">{phase.tasks.map((task, index) => <li key={index} className="flex items-start gap-3 py-3 text-sm"><InspectorStatus status={task.status} /><span className={cn("min-w-0 flex-1 break-words", task.status === "completed" && "text-muted-foreground line-through")}>{task.content}</span><span className="text-xs text-muted-foreground">{task.status.replace(/_/g, " ")}</span></li>)}</ul></section>)}
      </div>}
      {selection.kind === "changes" && <div className="mx-auto max-w-3xl">
        <div role="group" aria-label="Change scope" className="mb-3 flex gap-1 border-b pb-3">{(["session", "worktree"] as const).map((value) => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)} className={cn("rounded px-3 py-1.5 text-xs", scope === value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted")}>{value === "session" ? "Current session" : "Working tree"}</button>)}</div>
        {scope === "session" && <p className="mb-3 text-xs text-muted-foreground">Files edited by this session's tools. Diffs include all current working-tree edits to those files.</p>}
        {data.gitError ? <p role="alert" className="text-sm text-destructive">{data.gitError}</p> : files ? files.length ? files.map((file) => <FileChangeRow key={file.path} file={file} onClick={() => onSelect({ kind: "diff", path: file.path })} />) : <p className="text-sm text-muted-foreground">{scope === "session" ? "No modified files from recorded session edits." : "Working tree is clean."}</p> : <p className="text-sm text-muted-foreground">Git changes are unavailable for this workspace.</p>}
      </div>}
      {selection.kind === "diff" && data.cwd && <FileDiff key={`${data.cwd}:${selection.path}`} cwd={data.cwd} path={selection.path} />}
      {selection.kind === "context" && <dl className="mx-auto max-w-xl divide-y text-sm">
        {usage && <><Resource label="Context used" value={`${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens (${usage.percent.toFixed(1)}%)`} /><Resource label="Context remaining" value={`${formatTokens(Math.max(0, usage.contextWindow - usage.tokens))} tokens`} /></>}
        {data.stats && <><Resource label="Input tokens" value={formatTokens(data.stats.tokens.input)} /><Resource label="Output tokens" value={formatTokens(data.stats.tokens.output)} /><Resource label="Reasoning tokens" value={formatTokens(data.stats.tokens.reasoning)} /><Resource label="Cache read / write" value={`${formatTokens(data.stats.tokens.cacheRead)} / ${formatTokens(data.stats.tokens.cacheWrite)}`} /><Resource label="Estimated cost" value={formatCost(data.stats.cost)} /></>}
        {data.session?.autoCompactionEnabled && <Resource label="Auto compaction" value="Enabled" />}
      </dl>}
      {selection.kind === "agent" && <div className="mx-auto max-w-3xl space-y-4">
        {selection.id === "all" ? data.agents.map((item) => <button type="button" key={item.id} onClick={() => onSelect({ kind: "agent", id: item.id })} className="flex w-full items-center gap-3 border-b py-3 text-left text-sm hover:bg-muted"><InspectorStatus status={item.status} /><span>{item.name}</span><span className="min-w-0 truncate text-muted-foreground">{item.activity}</span></button>) : <>
          <p className="flex items-center gap-2 text-sm"><InspectorStatus status={agent?.snapshot ? "snapshot" : agent?.status ?? data.mainState} />{agent?.activity ?? data.activity}</p>
          {agent?.snapshot && <p className="text-xs text-muted-foreground">Last recorded task snapshot. Live status is unavailable for this agent.</p>}
          {mainOutput && <p className="text-sm text-muted-foreground">{mainOutput}</p>}
          {agent?.output && <pre className="scroll-thin overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{stripAnsi(agent.output)}</pre>}
          {(agent ? agent.runs : selection.id === "main" ? data.runs : []).map((run) => <ToolCard key={run.toolCallId} run={run} />)}
          {selection.id === "main" && <>
            {data.messages?.filter((message) => message.role === "assistant" && contentText(message.content)).map((message, index) => <pre key={index} className="whitespace-pre-wrap break-words text-sm leading-6">{contentText(message.content)}</pre>)}
            {Object.entries(data.statusMarks).map(([key, value]) => <p key={key} className="text-xs text-muted-foreground">{key}: {value}</p>)}
            {Object.entries(data.widgets).map(([key, lines]) => <section key={key}><h3 className="text-xs font-medium">{key}</h3><pre className="whitespace-pre-wrap break-words text-xs">{lines.join("\n")}</pre></section>)}
            {data.notices.filter((notice) => !notice.message.startsWith("xd://: mounted")).slice(-20).reverse().map((notice) => <p key={notice.id} className={cn("text-xs", notice.kind === "error" ? "text-destructive" : "text-muted-foreground")}>{notice.message}</p>)}
          </>}
        </>}
      </div>}
    </div>
  </section>;
}

function Resource({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap justify-between gap-3 py-3"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>;
}

function FileDiff({ cwd, path }: { cwd: string; path: string }) {
  const [result, setResult] = useState<{ text?: string; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    void invoke<string>("get_git_diff", { cwd, path }).then((text) => { if (!cancelled) setResult({ text }); }, (error: unknown) => { if (!cancelled) setResult({ error: String(error) }); });
    return () => { cancelled = true; };
  }, [cwd, path]);
  if (!result) return <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />Loading diff…</p>;
  if (result.error) return <p role="alert" className="text-sm text-destructive">{result.error}</p>;
  return <pre aria-label={`Diff for ${path}`} className="font-mono text-xs leading-6">{result.text ? result.text.split("\n").map((line, index) => <div key={index} className={cn("min-w-max px-2", line.startsWith("+") && "bg-emerald-500/5 text-emerald-700 dark:text-emerald-400", line.startsWith("-") && "bg-destructive/5 text-destructive", line.startsWith("@@") && "bg-muted text-muted-foreground")}>{line || " "}</div>) : "No textual diff; file metadata changed."}</pre>;
}
