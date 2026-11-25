import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, GitBranch, LoaderCircle, Pin } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SearchInput } from "@/components/ui/search-input";
import { Button } from "@/components/ui/button";
import { sessionPathKey, useSessionNavigation } from "@/lib/omp/navigation";
import { useAppStore } from "@/lib/omp/store";
import { cn } from "@/lib/utils";
import { pickerRowClass } from "./picker-styles";

export function worktreeName(cwd: string, branch?: string | null): string {
  return branch || cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || cwd;
}

export function WorktreeSelector({ value, onSelect, allowAll = true, className }: {
  value: string;
  onSelect: (cwd: string) => void;
  allowAll?: boolean;
  className?: string;
}) {
  const listing = useSessionNavigation((state) => state.sessionListing);
  const loading = useSessionNavigation((state) => Boolean(state.switchingProject || state.switchingWorktree || (state.sessionsLoading && !state.sessionListing)));
  const hydrating = useAppStore((state) => state.hydrating);
  const pinned = useSessionNavigation((state) => state.pinnedWorktrees);
  const recent = useSessionNavigation((state) => state.recentWorktrees);
  const togglePin = useSessionNavigation((state) => state.toggleWorktreePin);
  const selectWorktree = useSessionNavigation((state) => state.selectWorktree);
  const openProject = useAppStore((state) => state.openProjectDialog);
  const cwd = useAppStore((state) => state.cwd);
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const directories = useMemo(() => {
    const items = [...(listing?.directories ?? [])];
    if (cwd && !items.some((item) => sessionPathKey(item.cwd) === sessionPathKey(cwd))) items.push({ cwd, isWorktree: false });
    return items;
  }, [listing?.directories, cwd]);
  const options = useMemo(() => {
    const result: { cwd: string; label: string; group: string }[] = [];
    if (allowAll && "all worktrees".includes(query.toLowerCase())) result.push({ cwd: "all", label: "All Worktrees", group: "" });
    const used = new Set<string>();
    const add = (items: typeof directories, group: string) => {
      for (const item of items) {
        const key = sessionPathKey(item.cwd);
        if (used.has(key)) continue;
        used.add(key);
        const label = worktreeName(item.cwd, item.branch);
        if (`${label} ${item.cwd}`.toLowerCase().includes(query.toLowerCase())) result.push({ cwd: item.cwd, label, group });
      }
    };
    add(directories.filter((item) => sessionPathKey(item.cwd) === sessionPathKey(listing?.repositoryCwd)), "Main Worktree");
    add(directories.filter((item) => pinned.some((path) => sessionPathKey(path) === sessionPathKey(item.cwd))), "Pinned");
    add(recent.flatMap((path) => directories.filter((item) => sessionPathKey(path) === sessionPathKey(item.cwd))), "Recent");
    add(directories, "Other Worktrees");
    return result;
  }, [allowAll, directories, listing?.repositoryCwd, pinned, query, recent]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-option-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const selected = directories.find((item) => sessionPathKey(item.cwd) === sessionPathKey(value));
  const disabled = loading || hydrating;
  const choose = (path: string) => { if (!disabled) { setOpen(false); onSelect(path); } };

  return <>
    <Popover open={open && !disabled} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(""); setIndex(0); } }}>
      <PopoverTrigger disabled={disabled} render={<button type="button" className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg border border-sidebar-border px-2.5 py-2 text-left text-[11px] hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60", className)} aria-label={allowAll ? "Filter by Worktree" : "Choose task Worktree"} title={loading ? undefined : value} />}>
        {loading ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <GitBranch aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{loading ? "Loading Worktrees…" : value === "all" ? "All Worktrees" : worktreeName(value, selected?.branch)}</span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 max-w-[calc(100vw-24px)] gap-2">
        <PopoverTitle className="px-1 text-xs">{allowAll ? "Filter Worktrees" : "Task Worktree"}</PopoverTitle>
        <SearchInput autoFocus role="combobox" aria-label="Search Worktrees" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={options[index] ? `${id}-${index}` : undefined} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Worktrees…" onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((current) => Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
          } else if (event.key === "Enter" && options[index]) { event.preventDefault(); choose(options[index].cwd); }
        }} />
        <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Worktrees" className="max-h-64 overflow-y-auto overscroll-contain">
          {options.map((item, optionIndex) => <div key={item.cwd}>
            {item.group && item.group !== options[optionIndex - 1]?.group && <div className="px-2 pt-3 pb-1 text-[10px] text-muted-foreground">{item.group}</div>}
            <button type="button" role="option" id={`${id}-${optionIndex}`} data-option-index={optionIndex} aria-selected={sessionPathKey(value) === sessionPathKey(item.cwd)} title={item.cwd} className={cn(pickerRowClass, "py-2", index === optionIndex && "bg-muted")} onMouseMove={() => setIndex(optionIndex)} onClick={() => choose(item.cwd)}>
              <GitBranch aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{item.label}</span>
              {sessionPathKey(value) === sessionPathKey(item.cwd) && <Check aria-hidden="true" className="size-3 shrink-0" />}
            </button>
          </div>)}
          {options.length === 0 && <p className="p-3 text-xs text-muted-foreground">No matching Worktrees.</p>}
        </div>
        <button type="button" className="border-t px-2 pt-2 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => { setOpen(false); setManage(true); }}>Manage Worktrees…</button>
      </PopoverContent>
    </Popover>
    <Dialog open={manage && !disabled} onOpenChange={setManage}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Manage Worktrees</DialogTitle><DialogDescription>Pin execution environments for quick access, or open a Worktree’s last session.</DialogDescription></DialogHeader>
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {directories.map((item) => {
            const isPinned = pinned.some((path) => sessionPathKey(path) === sessionPathKey(item.cwd));
            return <div key={item.cwd} className="flex min-w-0 items-center gap-2 rounded-md border p-2">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setManage(false); void selectWorktree(item.cwd); }}>
                <span className="block truncate text-xs">{worktreeName(item.cwd, item.branch)}</span><span className="block truncate text-[10px] text-muted-foreground" title={item.cwd}>{item.cwd}</span>
              </button>
              <Button variant="ghost" size="icon-sm" aria-label={`${isPinned ? "Unpin" : "Pin"} Worktree ${worktreeName(item.cwd, item.branch)}`} aria-pressed={isPinned} onClick={() => togglePin(item.cwd)}><Pin className={cn("size-3.5", isPinned && "fill-current")} /></Button>
            </div>;
          })}
        </div>
        <Button variant="outline" onClick={() => { setManage(false); void openProject(); }}><FolderOpen className="size-3.5" />Open another project or Worktree</Button>
      </DialogContent>
    </Dialog>
  </>;
}
