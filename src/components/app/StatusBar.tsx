import { Activity, CircleAlert, CircleDot, Flame, ListChecks, Terminal, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore, activeTodos } from "@/lib/omp/store";
import { formatCost, formatTokens } from "@/lib/omp/format";

export function StatusBar({ terminalOpen, onToggleTerminal }: { terminalOpen: boolean; onToggleTerminal: () => void }) {
  const status = useAppStore((state) => state.status);
  const busy = useAppStore((state) => state.busy);
  const session = useAppStore((state) => state.session);
  const stats = useAppStore((state) => state.stats);
  const startInfo = useAppStore((state) => state.startInfo);
  const todos = activeTodos(session?.todoPhases);
  const usage = session?.contextUsage;
  const percent = Math.max(0, Math.min(100, usage?.percent ?? 0));
  const limit = session?.usageLimit;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-sidebar px-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "status-dot",
            status === "ready" ? "bg-emerald-500" : status === "starting" ? "animate-pulse bg-amber-500" : status === "error" ? "bg-destructive" : "bg-muted-foreground/50",
          )}
        />
        {status === "ready" ? (busy ? "working" : "ready") : status}
      </span>

      {usage && (
        <span className="flex items-center gap-2" title={`${formatTokens(usage.tokens)} of ${formatTokens(usage.contextWindow)} tokens`}>
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-border/80">
            <span
              className={cn("block h-full rounded-full", percent > 85 ? "bg-destructive" : percent > 60 ? "bg-amber-500" : "bg-emerald-500/80")}
              style={{ width: `${percent}%` }}
            />
          </span>
          <span>
            {formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
          </span>
        </span>
      )}

      {session?.tokensPerSecond ? (
        <span className="flex items-center gap-1">
          <Zap className="size-3" /> {session.tokensPerSecond.toFixed(1)} tok/s
        </span>
      ) : null}

      {stats && (
        <span className="flex items-center gap-1" title="Session spend">
          <Flame className="size-3" /> {formatCost(stats.cost)}
        </span>
      )}

      {stats && (
        <span className="flex items-center gap-1">
          <Activity className="size-3" /> {stats.totalMessages} msgs · {stats.toolCalls} tools
        </span>
      )}

      {todos.total > 0 && (
        <span className="flex items-center gap-1">
          <ListChecks className="size-3" /> {todos.completed}/{todos.total}
        </span>
      )}

      {limit && (
        <span
          className="flex items-center gap-1 text-amber-500"
          title={
            limit.resetsAtSec ? `Resets ${new Date(limit.resetsAtSec * 1000).toLocaleString()}` : "Provider usage limit"
          }
        >
          <CircleAlert className="size-3" />
          {limit.stage === "wrap_up" ? "usage limit" : "low priority"}
          {limit.allowanceLeftPercent !== undefined && ` ${limit.allowanceLeftPercent}%`}
        </span>
      )}

      <span className="ml-auto flex items-center gap-3">
        <button
          type="button"
          className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground", terminalOpen && "bg-accent text-foreground")}
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          title="Toggle terminal (Ctrl+` / Cmd+`)"
        >
          <Terminal className="size-3" /> Terminal
        </button>
        {session?.sessionId && (
          <span className="hidden font-mono text-[9px] text-muted-foreground/60 md:inline">
            {session.sessionId.slice(0, 10)}
          </span>
        )}
        {startInfo && (
          <span className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground/60" title={startInfo.args.join(" ")}>
            <CircleDot className="size-2.5" />
            {startInfo.program} rpc
          </span>
        )}
      </span>
    </footer>
  );
}
