import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FolderOpen, FolderPlus, LoaderCircle, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/lib/omp/store";
import { sessionPathKey, useSessionNavigation } from "@/lib/omp/navigation";
import { cn } from "@/lib/utils";
import { worktreeName } from "./WorktreeSelector";

export function ProjectSelector() {
  const cwd = useAppStore((state) => state.cwd);
  const openProject = useAppStore((state) => state.openProjectDialog);
  const repositoryCwd = useSessionNavigation((state) => state.repositoryCwd);
  const recent = useSessionNavigation((state) => state.recentProjects);
  const switching = useSessionNavigation((state) => state.switchingProject);
  const selectProject = useSessionNavigation((state) => state.selectProject);
  const current = repositoryCwd ?? cwd ?? "";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const projects = useMemo(() => {
    const seen = new Set<string>();
    return [current, ...recent].filter((path) => {
      const key = sessionPathKey(path);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return path.toLowerCase().includes(query.trim().toLowerCase());
    });
  }, [current, recent, query]);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-project-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const choose = (path: string) => {
    setOpen(false);
    if (sessionPathKey(path) !== sessionPathKey(current)) void selectProject(path);
  };

  return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(""); setIndex(0); } }}>
    <PopoverTrigger disabled={Boolean(switching)} render={<button type="button" aria-label="Switch project" title={current || "Choose a project"} className="group flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-2.5 text-left hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60" />}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border bg-sidebar">{switching ? <LoaderCircle aria-label="Switching project" className="size-4 animate-spin motion-reduce:animate-none" /> : <FolderOpen aria-hidden="true" className="size-4 text-muted-foreground" />}</span>
      <span className="min-w-0 flex-1"><span className="block text-[10px] text-muted-foreground">Project</span><span className="block truncate text-[13px] font-medium">{current ? worktreeName(current) : "Choose a project"}</span></span>
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-[calc(100vw-24px)] gap-2">
      <PopoverTitle className="px-1 text-xs">Switch project</PopoverTitle>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2 size-3.5 text-muted-foreground" />
        <Input autoFocus role="combobox" aria-label="Search projects" aria-expanded="true" aria-controls={`${id}-projects`} aria-autocomplete="list" aria-activedescendant={projects[index] ? `${id}-${index}` : undefined} placeholder="Find a project by name or path…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-8 pl-7 text-xs" onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((value) => Math.max(0, Math.min(projects.length - 1, value + (event.key === "ArrowDown" ? 1 : -1))));
          } else if (event.key === "Enter" && projects[index]) { event.preventDefault(); choose(projects[index]); }
        }} />
      </div>
      <div className="px-1 pt-1 text-[10px] text-muted-foreground">Recent projects</div>
      <div ref={listRef} id={`${id}-projects`} role="listbox" aria-label="Projects" className="max-h-72 overflow-y-auto overscroll-contain">
        {projects.map((path, optionIndex) => <button type="button" role="option" key={sessionPathKey(path)} id={`${id}-${optionIndex}`} data-project-index={optionIndex} aria-selected={sessionPathKey(path) === sessionPathKey(current)} title={path} onMouseMove={() => setIndex(optionIndex)} onClick={() => choose(path)} className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", index === optionIndex && "bg-muted")}>
          <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{worktreeName(path)}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{path}</span></span>
          {sessionPathKey(path) === sessionPathKey(current) && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
        </button>)}
        {!projects.length && <p className="px-2 py-5 text-center text-xs text-muted-foreground">No matching projects.</p>}
      </div>
      <button type="button" className="flex items-center gap-2 border-t border-border px-2 pt-3 pb-1 text-left text-xs hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setOpen(false); void openProject(); }}><FolderPlus aria-hidden="true" className="size-4" />Open project folder…</button>
      <p className="px-2 pb-1 text-[10px] text-muted-foreground">Switching projects keeps other sessions running.</p>
    </PopoverContent>
  </Popover>;
}
