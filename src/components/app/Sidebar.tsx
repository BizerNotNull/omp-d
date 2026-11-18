import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LoaderCircle, MessageSquarePlus, Pin, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { sessionPathKey, useSessionNavigation } from "@/lib/omp/navigation";
import { formatRelativeTime, stripPrivateUse } from "@/lib/omp/format";
import { WorktreeSelector, worktreeName } from "./WorktreeSelector";
import { ProjectSelector } from "./ProjectSelector";

const ROW_HEIGHT = 72;

export function Sidebar() {
  const cwd = useAppStore((state) => state.cwd);
  const status = useAppStore((state) => state.status);
  const hydrating = useAppStore((state) => state.hydrating);
  const branching = useAppStore((state) => state.branching);
  const session = useAppStore((state) => state.session);
  const activeRuntimeId = useAppStore((state) => state.activeRuntimeId);
  const newSession = useAppStore((state) => state.newSession);
  const switchSession = useAppStore((state) => state.switchSession);
  const selectRuntime = useAppStore((state) => state.selectRuntime);
  const openSessions = useAppStore((state) => state.openSessions);
  const view = useSessionNavigation((state) => state.view);
  const scope = useSessionNavigation((state) => state.worktreeScope);
  const query = useSessionNavigation((state) => state.query);
  const listing = useSessionNavigation((state) => state.sessionListing);
  const loading = useSessionNavigation((state) => state.sessionsLoading);
  const loadingMore = useSessionNavigation((state) => state.loadingMore);
  const error = useSessionNavigation((state) => state.error);
  const pins = useSessionNavigation((state) => state.pinnedSessions);
  const setView = useSessionNavigation((state) => state.setView);
  const setQuery = useSessionNavigation((state) => state.setQuery);
  const selectWorktree = useSessionNavigation((state) => state.selectWorktree);
  const togglePin = useSessionNavigation((state) => state.toggleSessionPin);
  const loadMore = useSessionNavigation((state) => state.loadMore);
  const refresh = useSessionNavigation((state) => state.refresh);
  const rememberScroll = useSessionNavigation((state) => state.rememberScroll);
  const repositoryCwd = useSessionNavigation((state) => state.repositoryCwd);
  const switchingProject = useSessionNavigation((state) => state.switchingProject);
  const switchingWorktree = useSessionNavigation((state) => state.switchingWorktree);
  const switchingWorkspace = Boolean(switchingProject || switchingWorktree);
  const replacing = switchingWorkspace || (loading && !loadingMore);
  const conversationPending = switchingWorkspace || hydrating || branching;
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoration = useRef({ key: "", top: 0, pending: true });
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const project = repositoryCwd ?? cwd ?? "";
  const scrollKey = JSON.stringify([sessionPathKey(project), view, scope, query]);
  const pinnedKeys = useMemo(() => new Set(pins.map(sessionPathKey)), [pins]);
  const rows = useMemo(() => {
    if (replacing) return [];
    const directories = listing?.directories ?? [];
    const directoryKeys = new Set(directories.map((item) => sessionPathKey(item.cwd)));
    const saved = new Map((listing?.sessions ?? []).map((item) => [sessionPathKey(item.path), item]));
    const result = [...saved.values()].map((item) => ({
      key: sessionPathKey(item.path), path: item.path, cwd: item.cwd,
      title: stripPrivateUse(item.title || item.preview || "Untitled session"),
      modifiedMs: item.modifiedMs,
      runtime: openSessions.find((entry) => sessionPathKey(entry.path) === sessionPathKey(item.path)),
    }));
    for (const runtime of openSessions) {
      if (!runtime.cwd || (!directoryKeys.has(sessionPathKey(runtime.cwd)) && sessionPathKey(runtime.cwd) !== sessionPathKey(cwd))) continue;
      const existing = result.find((item) => item.runtime?.id === runtime.id);
      if (existing) {
        existing.title = runtime.title === "Untitled session" ? existing.title : runtime.title;
        existing.modifiedMs = Math.max(existing.modifiedMs, runtime.modifiedMs);
      } else {
        result.push({ key: runtime.path ? sessionPathKey(runtime.path) : `runtime:${runtime.id}`, path: runtime.path ?? "", cwd: runtime.cwd, title: runtime.title, modifiedMs: runtime.modifiedMs, runtime });
      }
    }
    return result.filter((item) => {
      if (!query && scope !== "all" && sessionPathKey(item.cwd) !== sessionPathKey(scope)) return false;
      if (view === "running" && !item.runtime?.busy) return false;
      if (view === "pinned" && !pinnedKeys.has(sessionPathKey(item.path))) return false;
      if (query && !saved.has(sessionPathKey(item.path))) {
        const directory = directories.find((entry) => sessionPathKey(entry.cwd) === sessionPathKey(item.cwd));
        if (!`${item.title} ${item.cwd} ${directory?.branch ?? ""}`.toLowerCase().includes(query.toLowerCase())) return false;
      }
      return true;
    }).sort((a, b) => b.modifiedMs - a.modifiedMs || a.key.localeCompare(b.key));
  }, [replacing, listing, openSessions, cwd, scope, view, query, pinnedKeys]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (restoration.current.key !== scrollKey || replacing) {
      restoration.current = { key: scrollKey, top: useSessionNavigation.getState().scrollPositionByScope[scrollKey] ?? 0, pending: true };
    }
    if (replacing) return;
    const restore = restoration.current;
    if (!restore.pending) return;
    element.scrollTop = restore.top;
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    const reached = restore.top <= element.scrollHeight - element.clientHeight;
    if (listing && !loading && (reached || !listing.nextCursor)) restore.pending = false;
  }, [scrollKey, rows.length, loading, replacing, listing?.nextCursor]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!replacing && !loading && !error && listing?.nextCursor && viewport.top + viewport.height >= rows.length * ROW_HEIGHT - ROW_HEIGHT * 5) void loadMore();
  }, [replacing, loading, error, listing?.nextCursor, viewport, rows.length, loadMore]);

  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 4);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 4);
  const heading = query ? "Search results" : `${view[0].toUpperCase()}${view.slice(1)} sessions`;

  return (
    <aside aria-label="Project and session navigation" className="flex w-[280px] min-w-0 max-w-[70vw] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 space-y-3 border-b border-sidebar-border px-3 pt-4 pb-3">
        <ProjectSelector />
        <p className="truncate px-1 text-[10px] text-muted-foreground" title={switchingProject ?? project}>{switchingProject ?? (project || "Open a folder to get started")}</p>
        <div className="space-y-1.5">
          <h2 className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Worktrees</h2>
          <WorktreeSelector value={scope} onSelect={(value) => void selectWorktree(value)} />
          {query && scope !== "all" && <p className="px-1 text-[10px] text-muted-foreground">Searching all project Worktrees</p>}
        </div>
      </div>
      <div className="shrink-0 space-y-3 px-3 pt-3 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Sessions</h2>
          <Button variant="ghost" className="h-7 gap-1.5 px-2 text-[11px]" disabled={!cwd || conversationPending} onClick={() => void newSession()}><MessageSquarePlus aria-hidden="true" className="size-3.5" />New Session</Button>
        </div>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2 size-3.5 text-muted-foreground" />
          <Input aria-label="Search project sessions" placeholder="Search project sessions…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 pr-7 pl-7 text-[11px]" />
          {query && <button type="button" aria-label="Clear session search" className="absolute top-2 right-2 text-muted-foreground" onClick={() => setQuery("")}><X className="size-4" /></button>}
        </div>
        <div>
          <div aria-label="Session views" className="flex rounded-lg border border-sidebar-border p-0.5">
            {(["recent", "running", "pinned"] as const).map((candidate) => <button type="button" key={candidate} aria-pressed={candidate === view} onClick={() => setView(candidate)} className={cn("min-w-0 flex-1 rounded-md px-1 py-1.5 text-[11px] capitalize focus-visible:ring-2 focus-visible:ring-ring", candidate === view ? "bg-sidebar-accent font-medium" : "text-muted-foreground hover:text-foreground")}>{candidate}</button>)}
          </div>
        </div>
        <h2 className="pt-1 text-[10px] text-muted-foreground">{heading}</h2>
      </div>
      <div ref={scrollRef} aria-label={heading} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 [overflow-anchor:none]" onScroll={(event) => {
        const element = event.currentTarget;
        setViewport({ top: element.scrollTop, height: element.clientHeight });
        if (!replacing && !restoration.current.pending) rememberScroll(scrollKey, element.scrollTop);
      }} onWheel={() => { if (!replacing) restoration.current.pending = false; }}>
        <div role="list" aria-label="Sessions" style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {rows.slice(start, end).map((item, offset) => {
            const current = item.runtime ? item.runtime.id === activeRuntimeId : sessionPathKey(item.path) === sessionPathKey(session?.sessionFile);
            const directory = listing?.directories.find((entry) => sessionPathKey(entry.cwd) === sessionPathKey(item.cwd));
            const pinned = pinnedKeys.has(sessionPathKey(item.path));
            return <div role="listitem" key={item.key} style={{ position: "absolute", top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }} className="pb-1">
              <div className={cn("group flex h-full min-w-0 items-center rounded-lg", current ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}>
                <button type="button" disabled={conversationPending} aria-current={current ? "page" : undefined} className="flex h-full min-w-0 flex-1 flex-col justify-center gap-1 rounded-lg px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={`${item.title}\n${item.cwd}`} onClick={(event) => {
                  // A refresh can move a different row under the pointer between clicks.
                  if (event.detail > 1 || current) return;
                  if (item.runtime) selectRuntime(item.runtime.id);
                  else void switchSession(item.path, item.cwd);
                }}>
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    {item.runtime?.busy ? <LoaderCircle aria-label="Agent running" className="size-3 shrink-0 animate-spin text-emerald-500 motion-reduce:animate-none" /> : <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", current ? "bg-emerald-500" : "bg-muted-foreground/40")} />}
                    <span className={cn("min-w-0 truncate text-[12px]", current && "font-medium")}>{item.title}</span>
                  </span>
                  <span className="flex w-full min-w-0 items-center gap-1 text-[10px] text-muted-foreground"><GitBranch aria-hidden="true" className="size-3 shrink-0" /><span className="min-w-0 truncate">{worktreeName(item.cwd, directory?.branch)}</span><span className="shrink-0">· {formatRelativeTime(item.modifiedMs)}</span></span>
                  {Boolean(item.runtime?.dialogs) && <span className="text-[10px] text-amber-500">Needs input</span>}
                </button>
                {item.path && <button type="button" aria-label={`${pinned ? "Unpin" : "Pin"} session ${item.title}`} aria-pressed={pinned} onClick={() => togglePin(item.path)} className={cn("mr-1.5 shrink-0 rounded p-1.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", !pinned && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}><Pin aria-hidden="true" className={cn("size-3", pinned && "fill-current")} /></button>}
              </div>
            </div>;
          })}
        </div>
        {!rows.length && !replacing && !loading && !error && <p className="px-2 py-8 text-center text-[11px] text-muted-foreground">{query ? "No matching sessions." : view === "running" ? "No Agent tasks running." : view === "pinned" ? "Pin a session to save it here." : "No sessions in this view."}</p>}
        {!replacing && error && <div role="alert" className="p-2 text-[11px] text-destructive">{error}<button type="button" className="mt-2 block underline" onClick={() => void refresh()}>Retry loading sessions</button></div>}
        {(replacing || loadingMore) && <p role="status" className="flex items-center justify-center gap-2 p-3 text-[11px] text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />{replacing ? "Loading sessions…" : "Loading older sessions…"}</p>}
        {!replacing && !loading && !error && listing?.nextCursor && <button type="button" onClick={() => void loadMore()} className="w-full p-3 text-[10px] text-muted-foreground hover:text-foreground">Load older sessions</button>}
      </div>
      <div className="shrink-0 border-t border-sidebar-border px-3 py-2.5 text-[10px] text-muted-foreground"><span className={cn("mr-2 inline-block size-1.5 rounded-full", status === "ready" ? "bg-emerald-500" : status === "error" ? "bg-destructive" : "bg-muted-foreground")} />{status === "ready" ? "connected" : status === "starting" ? "starting omp" : status === "error" ? "connection error" : "disconnected"}</div>
    </aside>
  );
}
