import { useMemo } from "react";
import {
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MessageSquarePlus,
  SquarePen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { formatRelativeTime, stripPrivateUse } from "@/lib/omp/format";

export function Sidebar() {
  const cwd = useAppStore((state) => state.cwd);
  const status = useAppStore((state) => state.status);
  const sessionListing = useAppStore((state) => state.sessionListing);
  const sessionsLoading = useAppStore((state) => state.sessionsLoading);
  const session = useAppStore((state) => state.session);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const newSession = useAppStore((state) => state.newSession);
  const switchSession = useAppStore((state) => state.switchSession);
  const busy = useAppStore((state) => state.busy);
  const openSessions = useAppStore((state) => state.openSessions);
  const activeRuntimeId = useAppStore((state) => state.activeRuntimeId);
  const selectRuntime = useAppStore((state) => state.selectRuntime);

  const projectName = useMemo(() => {
    if (!cwd) return "No project";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }, [cwd]);

  const activePath = session?.sessionFile;
  const sessionCount = sessionListing?.directories.reduce((count, directory) => count + directory.sessions.length, 0) ?? 0;

  return (
    <aside className="flex w-[264px] min-w-0 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-9 shrink-0 items-center px-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Workspace
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
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between px-4 pb-1.5">
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Recent</h2>
        <div className="flex items-center gap-2">
          {sessionsLoading && <LoaderCircle aria-label="Loading sessions" className="size-3.5 animate-spin text-muted-foreground" />}
          <span className="text-[10px] text-muted-foreground/50">{sessionCount}</span>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="min-w-0 px-2 pb-3">
          {openSessions.length > 1 && (
            <section aria-label="Open sessions" className="mb-3">
              <h3 className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground">Open sessions</h3>
              {openSessions.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => selectRuntime(entry.id)}
                  title={entry.cwd}
                  className={cn("flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-left text-[12px]", entry.id === activeRuntimeId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}
                >
                  {(entry.busy || entry.status === "starting") && <LoaderCircle aria-label="Session in progress" className="size-3.5 shrink-0 animate-spin text-emerald-500 motion-reduce:animate-none" />}
                  <span className="min-w-0 flex-1 truncate">{stripPrivateUse(entry.title)}</span>
                  {entry.dialogs > 0 && <span className="shrink-0 text-[10px] text-amber-500">Needs input</span>}
                  {(entry.status === "error" || entry.status === "stopped") && <span className="shrink-0 text-[10px] text-muted-foreground">{entry.status}</span>}
                </button>
              ))}
            </section>
          )}
          {sessionsLoading && !sessionListing && (
            <div role="status" className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              Loading sessions…
            </div>
          )}
          {!sessionListing && !sessionsLoading && (
            <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
              <MessageSquarePlus className="mx-auto mb-2 size-5 opacity-40" />
              {status === "ready" ? "No saved sessions in this folder yet." : "Waiting for the agent…"}
            </div>
          )}
          {sessionListing && (
            <section aria-label={sessionListing.repositoryCwd} className="min-w-0">
              <h3
                title={sessionListing.repositoryCwd}
                className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium"
              >
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{directoryName(sessionListing.repositoryCwd)}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={status !== "ready"}
                  onClick={() => void newSession()}
                  aria-label="New session"
                  title="New session"
                >
                  <SquarePen className="size-3.5" />
                </Button>
              </h3>
              {sessionListing.directories.map((directory) => (
                <section
                  key={directory.cwd}
                  aria-label={directory.cwd}
                  className={cn("ml-3 min-w-0", directory.cwd !== sessionListing.repositoryCwd && "mt-1")}
                >
                  {directory.cwd !== sessionListing.repositoryCwd && (
                    <h4
                      title={directory.cwd}
                      className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium"
                    >
                      {directory.isWorktree
                        ? <GitBranch aria-label="Worktree" className="size-3.5 shrink-0 text-muted-foreground" />
                        : <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 truncate">{directoryName(directory.cwd)}</span>
                    </h4>
                  )}
                  <div className={cn("min-w-0 space-y-0.5", directory.cwd !== sessionListing.repositoryCwd && "ml-3")}>
                    {directory.sessions.length === 0 && (
                      <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
                        No saved sessions in this folder yet.
                      </p>
                    )}
                    {directory.sessions.map((item) => {
                      const cleanTitle = stripPrivateUse(item.title ?? "").trim();
                      const cleanPreview = stripPrivateUse(item.preview ?? "").trim();
                      const title = cleanTitle || cleanPreview || "Untitled session";
                      const subtitle = cleanTitle && cleanPreview && cleanPreview !== cleanTitle ? cleanPreview : "";
                      const current = Boolean(activePath && item.path === activePath);
                      const runtime = openSessions.find((entry) => entry.path === item.path);
                      return (
                        <button
                          key={item.path}
                          type="button"
                          onClick={() => void switchSession(item.path)}
                          className={cn(
                            "group flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                            current ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
                          )}
                        >
                          <div className="flex w-full min-w-0 items-center gap-1.5">
                            {runtime?.busy
                              ? <LoaderCircle aria-label="Session in progress" className="size-3.5 shrink-0 animate-spin text-emerald-500 motion-reduce:animate-none" />
                              : current && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
                            <span className={cn("min-w-0 flex-1 truncate text-[12px]", current ? "font-medium" : "text-sidebar-foreground/85")}>
                              {title}
                            </span>
                            <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/60">
                              {formatRelativeTime(item.modifiedMs)}
                            </span>
                          </div>
                          {subtitle && (
                            <span className="w-full min-w-0 truncate text-[10px] text-muted-foreground/70 group-hover:text-muted-foreground">
                              {subtitle}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </section>
          )}
        </div>
      </ScrollArea>

      <div className="border-t border-sidebar-border px-3 py-2.5">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className={cn("status-dot", statusTone(status))} />
          <span className="truncate">{statusText(status, busy)}</span>
        </div>
      </div>
    </aside>
  );
}

function directoryName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
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
