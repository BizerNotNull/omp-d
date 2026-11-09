import { CheckCircle2, Circle, CircleDot, LoaderCircle, ScrollText, Target, XCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAppStore, activeTodos } from "@/lib/omp/store";
import { formatCost, formatRelativeTime, formatTokens } from "@/lib/omp/format";
import type { TodoItem } from "@/lib/omp/types";

function TodoRow({ task }: { task: TodoItem }) {
  const icon =
    task.status === "completed" ? (
      <CheckCircle2 className="size-3.5 text-emerald-500" />
    ) : task.status === "in_progress" ? (
      <CircleDot className="size-3.5 text-amber-500" />
    ) : task.status === "blocked" ? (
      <XCircle className="size-3.5 text-destructive" />
    ) : (
      <Circle className="size-3.5 text-muted-foreground/60" />
    );
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span
        className={cn(
          "text-[11px] leading-snug",
          task.status === "completed" ? "text-muted-foreground line-through" : "text-foreground/80",
        )}
      >
        {task.content}
      </span>
    </div>
  );
}

export function RightPanel() {
  const session = useAppStore((state) => state.session);
  const notices = useAppStore((state) => state.notices);
  const toolRuns = useAppStore((state) => state.toolRuns);
  const widgets = useAppStore((state) => state.widgets);
  const stats = useAppStore((state) => state.stats);
  const statusMarks = useAppStore((state) => state.statusMarks);
  const todos = activeTodos(session?.todoPhases);
  const usage = session?.contextUsage;
  const goal = session?.goal?.goal;
  const running = Object.values(toolRuns).filter((run) => run.status === "running");

  return (
    <aside className="hidden w-[292px] shrink-0 flex-col border-l bg-sidebar/60 xl:flex">
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <ScrollText className="size-4 text-muted-foreground" />
        <span className="text-[12px] font-medium">Activity</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{session?.messageCount ?? 0} entries</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {goal && (
            <section className="rounded-lg border border-border/70 bg-card/60 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Target className="size-3" /> Goal
              </div>
              <p className="text-[11px] leading-relaxed text-foreground/80">{goal.objective}</p>
              <div className="mt-2 space-y-1 text-[10px] text-muted-foreground">
                <p className="capitalize">{goal.status}</p>
                <p>{formatTokens(goal.tokensUsed)}{goal.tokenBudget !== undefined ? ` / ${formatTokens(goal.tokenBudget)}` : ""} tokens · {Math.floor(goal.timeUsedSeconds)}s</p>
              </div>
            </section>
          )}

          <section>
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Todos</span>
              {todos.total > 0 && (
                <span className="text-[10px] text-muted-foreground/70">
                  {todos.completed}/{todos.total}
                </span>
              )}
            </div>
            {(session?.todoPhases ?? []).length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground/70">The agent has not opened a todo list.</p>
            ) : (
              (session?.todoPhases ?? []).map((phase) => (
                <div key={phase.name} className="mb-2">
                  <div className="px-2 pb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/60">
                    {phase.name}
                  </div>
                  {phase.tasks.map((task, index) => (
                    <TodoRow key={`${task.content}-${index}`} task={task} />
                  ))}
                </div>
              ))
            )}
          </section>

          {running.length > 0 && (
            <section>
              <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Running tools
              </div>
              {running.map((run) => (
                <div key={run.toolCallId} className="flex items-center gap-2 px-2 py-1 text-[11px]">
                  <LoaderCircle className="size-3.5 animate-spin text-amber-500" />
                  <span className="font-mono">{run.toolName}</span>
                  <span className="truncate text-muted-foreground">
                    {typeof run.args?.command === "string" ? run.args.command : ""}
                  </span>
                </div>
              ))}
            </section>
          )}

          <section>
            <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Context</div>
            <div className="space-y-1.5 rounded-lg border border-border/70 bg-card/50 p-2.5 text-[11px]">
              {usage ? (
                <>
                  <div className="flex justify-between text-muted-foreground">
                    <span>{formatTokens(usage.tokens)} tokens</span>
                    <span>{usage.percent.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-border/80">
                    <div
                      className="h-full rounded-full bg-emerald-500/70"
                      style={{ width: `${Math.min(100, usage.percent)}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground/60">
                    {formatTokens(usage.contextWindow)} token window
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">Context usage unavailable.</span>
              )}
              {stats && (
                <div className="flex justify-between border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
                  <span>spend</span>
                  <span>{formatCost(stats.cost)}</span>
                </div>
              )}
              {stats && (
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>in / out</span>
                  <span>
                    {formatTokens(stats.tokens.input)} / {formatTokens(stats.tokens.output)}
                  </span>
                </div>
              )}
            </div>
          </section>

          {Object.keys(statusMarks).length > 0 && (
            <section>
              <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Status</div>
              {Object.entries(statusMarks).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between px-2 py-0.5 text-[11px]">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="truncate text-foreground/80">{value}</span>
                </div>
              ))}
            </section>
          )}

          {Object.keys(widgets).length > 0 && (
            <section>
              <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Widgets
              </div>
              {Object.entries(widgets).map(([key, lines]) => (
                <div key={key} className="mb-1.5 rounded-lg border border-border/60 bg-card/40 px-2 py-1.5">
                  <div className="mb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/60">{key}</div>
                  <pre className="font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground/75">
                    {lines.join("\n")}
                  </pre>
                </div>
              ))}
            </section>
          )}

          <section>
            <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Log</div>
            {notices.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground/70">Notices from the agent appear here.</p>
            ) : (
              <div className="space-y-1">
                {notices
                  .filter((notice) => !notice.message.startsWith("xd://: mounted"))
                  .slice(-20)
                  .reverse()
                  .map((notice) => (
                    <div key={notice.id} className="flex gap-2 px-2 text-[10.5px] leading-relaxed">
                      <span
                        className={cn(
                          "mt-1 size-1.5 shrink-0 rounded-full",
                          notice.kind === "error"
                            ? "bg-destructive"
                            : notice.kind === "warning"
                              ? "bg-amber-500"
                              : notice.kind === "progress"
                                ? "bg-sky-500"
                                : "bg-muted-foreground/40",
                        )}
                      />
                      <span className="min-w-0 flex-1 break-words text-muted-foreground">{notice.message}</span>
                      <span className="shrink-0 text-[9px] text-muted-foreground/50">
                        {formatRelativeTime(notice.at)}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      <div className="border-t p-2.5">
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="truncate">{session?.sessionFile ?? "No session file"}</span>
          {session?.autoCompactionEnabled && <span className="ml-2 shrink-0">auto-compact</span>}
        </div>
      </div>
    </aside>
  );
}
