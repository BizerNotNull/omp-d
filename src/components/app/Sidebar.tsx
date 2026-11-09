import { useMemo } from "react";
import {
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  Plus,
  Settings2,
  SquarePen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { formatRelativeTime, stripPrivateUse } from "@/lib/omp/format";

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const cwd = useAppStore((state) => state.cwd);
  const status = useAppStore((state) => state.status);
  const sessions = useAppStore((state) => state.sessions);
  const sessionsLoading = useAppStore((state) => state.sessionsLoading);
  const session = useAppStore((state) => state.session);
  const startInfo = useAppStore((state) => state.startInfo);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const newSession = useAppStore((state) => state.newSession);
  const switchSession = useAppStore((state) => state.switchSession);
  const busy = useAppStore((state) => state.busy);

  const projectName = useMemo(() => {
    if (!cwd) return "No project";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }, [cwd]);

  const activePath = session?.sessionFile;

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        <div className="relative flex size-8 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent text-[15px] font-semibold">
          π
          <span className={cn("status-dot absolute -right-0.5 -bottom-0.5", statusTone(status))} />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-semibold tracking-tight">omp-d</span>
            <span className="rounded border border-sidebar-border px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
              rpc
            </span>
          </div>
          <div className="truncate text-[10.5px] text-muted-foreground">Oh My Pi desktop</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings2 className="size-4" />
        </Button>
      </div>

      <div className="px-3">
        <button
          type="button"
          onClick={() => void openProjectDialog()}
          className="group flex w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent"
        >
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">{projectName}</div>
            <div className="truncate text-[10px] text-muted-foreground">{cwd ?? "Choose a folder"}</div>
          </div>
          <SquarePen className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 px-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-1 justify-start gap-1.5 border-sidebar-border bg-transparent text-[11px] hover:bg-sidebar-accent"
          disabled={status !== "ready"}
          onClick={() => void newSession()}
        >
          <Plus className="size-3.5" />
          New session
        </Button>
        {sessionsLoading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      <div className="mt-4 flex items-center justify-between px-4 pb-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Recent</span>
        <span className="text-[10px] text-muted-foreground/50">{sessions.length}</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-2 pb-3">
          {sessionsLoading && sessions.length === 0 && (
            <div role="status" className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              Loading sessions…
            </div>
          )}
          {sessions.length === 0 && !sessionsLoading && (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              <MessageSquarePlus className="mx-auto mb-2 size-5 opacity-40" />
              {status === "ready" ? "No saved sessions in this folder yet." : "Waiting for the agent…"}
            </div>
          )}
          {sessions.map((item) => {
            const cleanTitle = stripPrivateUse(item.title ?? "").trim();
            const cleanPreview = stripPrivateUse(item.preview ?? "").trim();
            const title = cleanTitle || cleanPreview || "Untitled session";
            const subtitle = cleanTitle && cleanPreview && cleanPreview !== cleanTitle ? cleanPreview : "";
            const current = Boolean(activePath && item.path === activePath);
            return (
              <button
                key={item.path}
                type="button"
                onClick={() => void switchSession(item.path)}
                className={cn(
                  "group flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  current ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
                )}
              >
                <div className="flex items-center gap-1.5">
                  {current && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
                  <span className={cn("truncate text-[12px]", current ? "font-medium" : "text-sidebar-foreground/85")}>
                    {title}
                  </span>
                  <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/60">
                    {formatRelativeTime(item.modifiedMs)}
                  </span>
                </div>
                {subtitle && (
                  <span className="truncate text-[10px] text-muted-foreground/70 group-hover:text-muted-foreground">
                    {subtitle}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border px-3 py-2.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className={cn("status-dot", statusTone(status))} />
          <span className="truncate">{statusText(status, busy)}</span>
          {startInfo && <span className="ml-auto font-mono text-[9px] text-muted-foreground/50">pid {startInfo.pid}</span>}
        </div>
      </div>
    </aside>
  );
}

function statusTone(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "starting":
      return "bg-amber-500 animate-pulse";
    case "error":
      return "bg-destructive";
    case "stopped":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground/40";
  }
}

function statusText(status: string, busy: boolean): string {
  if (status === "ready") return busy ? "working" : "connected";
  if (status === "starting") return "starting omp";
  if (status === "error") return "connection error";
  if (status === "stopped") return "disconnected";
  return "idle";
}
