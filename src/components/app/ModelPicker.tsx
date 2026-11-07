import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { formatTokens } from "@/lib/omp/format";
import type { Model } from "@/lib/omp/types";

const ROW_HEIGHT = 64;
const OVERSCAN = 5;
const modelKey = (model: Model) => `${model.provider}/${model.id}`;

export function ModelPicker({ onClose }: { onClose: () => void }) {
  const models = useAppStore((state) => state.models);
  const roles = useAppStore((state) => state.modelRoles);
  const loading = useAppStore((state) => state.modelsLoading);
  const error = useAppStore((state) => state.modelsError);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const setModel = useAppStore((state) => state.setModel);
  const current = useAppStore((state) => state.session?.model);
  const status = useAppStore((state) => state.status);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>();
  const [view, setView] = useState<"models" | "roles">("models");
  const [kind, setKind] = useState("all");
  const [highlighted, setHighlighted] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const selectionPending = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (useAppStore.getState().models === undefined && status === "ready") void fetchModels();
  }, [fetchModels, status]);

  const catalog = useMemo(() => {
    const entries = [...(models ?? [])];
    if (current && !entries.some((model) => modelKey(model) === modelKey(current))) entries.unshift(current);
    const providers = new Map<string, { available: number; total: number }>();
    const kinds = new Set<string>();
    let availableCount = 0;
    for (const model of entries) {
      const counts = providers.get(model.provider) ?? { available: 0, total: 0 };
      counts.total++;
      if (model.available !== false) { counts.available++; availableCount++; }
      providers.set(model.provider, counts);
      if (model.kind) kinds.add(model.kind);
    }
    const providerEntries = [...providers].sort(([a, left], [b, right]) =>
      Number(right.available > 0) - Number(left.available > 0) || a.localeCompare(b));
    return { entries, providers: providerEntries, availableCount, kinds: [...kinds].sort() };
  }, [models, current]);
  const selectedProvider = catalog.providers.find(([id]) => id === provider)?.[1];
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    const includeUnavailable = provider !== undefined && selectedProvider?.available === 0;
    return catalog.entries.filter((model) =>
      (!provider || model.provider === provider) && (kind === "all" || model.kind === kind) &&
      (model.available !== false || includeUnavailable) &&
      (!search || `${modelKey(model)} ${model.name ?? ""}`.toLowerCase().includes(search)));
  }, [catalog, query, provider, kind, selectedProvider]);
  const roleEntries = useMemo(() => Object.entries(roles).filter(([role, selector]) => {
    const search = query.trim().toLowerCase();
    return (!provider || selector.startsWith(`${provider}/`)) && (!search || `${role} ${selector}`.toLowerCase().includes(search));
  }), [roles, provider, query]);
  const selectedIndex = Math.min(highlighted, Math.max(0, filtered.length - 1));
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(filtered.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(list);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => {
    setHighlighted(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, provider, kind, view]);

  async function choose(model: Model) {
    if (selectionPending.current || status !== "ready" || model.available === false) return;
    selectionPending.current = true;
    setSelecting(true);
    try {
      if (await setModel(model.provider, model.id)) onClose();
    } finally {
      selectionPending.current = false;
      setSelecting(false);
    }
  }

  function navigate(delta: number) {
    if (!filtered.length) return;
    const next = (selectedIndex + delta + filtered.length) % filtered.length;
    setHighlighted(next);
    const list = listRef.current;
    if (!list) return;
    const top = next * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  }

  const navClass = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <section aria-labelledby="model-page-title" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.key === "Escape" && !selecting) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <header className="flex items-center justify-between gap-2 border-b px-3 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-muted-foreground">/model · /models</div>
          <h1 id="model-page-title" className="text-base font-semibold">Models</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={selecting}><ArrowLeft className="size-3.5" /> Back to chat</Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Model providers" className="w-28 shrink-0 overflow-y-auto border-r bg-card/40 p-1.5 sm:w-52 sm:p-3">
          <button type="button" aria-pressed={view === "roles"} className={cn(navClass, view === "roles" && "bg-muted text-foreground")} onClick={() => { setView("roles"); setProvider(undefined); }}>
            <span className="flex-1">Roles</span><span className="text-muted-foreground">{Object.keys(roles).length}</span>
          </button>
          <button type="button" aria-pressed={view === "models" && !provider} className={cn(navClass, view === "models" && !provider && "bg-primary/10 text-primary")} onClick={() => { setView("models"); setProvider(undefined); }}>
            <span className="flex-1">All models</span><span className="text-muted-foreground">{catalog.availableCount}</span>
          </button>
          <div className="my-2 border-t" />
          <div className="px-2 pb-1 text-[10px] text-muted-foreground">Providers</div>
          {catalog.providers.map(([id, counts], index) => {
            const unavailable = counts.available === 0;
            const firstUnavailable = unavailable && (index === 0 || catalog.providers[index - 1][1].available > 0);
            return <div key={id}>
              {firstUnavailable && <div className="my-2 border-t px-2 pt-2 text-[10px] text-muted-foreground">Unavailable</div>}
              <button type="button" title={`${id} · ${unavailable ? "Authentication or configuration required" : "Available"}`} aria-pressed={provider === id} className={cn(navClass, provider === id ? "bg-primary/10 text-primary" : "hover:bg-muted/60")} onClick={() => { setProvider(id); setView("models"); }}>
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", unavailable ? "border border-muted-foreground" : "bg-success")} />
                <span className="min-w-0 flex-1 truncate font-mono">{id}</span><span className="text-muted-foreground">{unavailable ? counts.total : counts.available}</span>
              </button>
            </div>;
          })}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="min-w-0 break-all text-sm font-medium">{view === "roles" ? "Model roles" : provider ?? "All available models"}</h2>
            <Button variant="ghost" size="sm" aria-label="Refresh model catalog" onClick={() => void fetchModels()} disabled={loading || selecting || status !== "ready"}>
              {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}<span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
          {view === "models" && catalog.kinds.length > 0 && <div aria-label="Model kinds" className="flex shrink-0 gap-1 overflow-x-auto pb-1">
            {["all", ...catalog.kinds].map((value) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} className={cn("rounded px-2 py-1 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring", kind === value ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted")}>{value}</button>)}
          </div>}
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus aria-label={view === "roles" ? "Filter roles" : "Filter models"} aria-controls="model-options" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (view !== "models") return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); navigate(event.key === "ArrowDown" ? 1 : -1); }
              else if (event.key === "Enter") { event.preventDefault(); const model = filtered[selectedIndex]; if (model) void choose(model); }
            }} placeholder={view === "roles" ? "Search roles…" : "Search models…"} className="pl-8" />
          </div>
          {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
          {status !== "ready" && <p role="status" className="text-xs text-muted-foreground">Connect to the agent to change models.</p>}
          {view === "models" && provider && selectedProvider?.available === 0 && <p role="status" className="text-xs text-muted-foreground">This provider is unavailable. Authenticate with <code>omp login</code> or configure its credentials, then refresh. Catalog models below cannot be selected yet.</p>}
          <div id="model-options" ref={listRef} aria-label={view === "roles" ? "Configured roles" : "Available models"} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
            {view === "roles" ? <div className="divide-y">{roleEntries.map(([role, selector]) => {
              const modelSelector = selector.replace(/:(off|minimal|low|medium|high|xhigh|max|auto)$/, "");
              const assigned = catalog.entries.find((model) => modelKey(model) === modelSelector);
              return <div key={role} className="flex flex-wrap items-center gap-2 px-3 py-3">
                <div className="min-w-0 flex-1 basis-full sm:basis-0"><h3 className="text-sm font-medium">{role}</h3><p className="break-all font-mono text-xs text-muted-foreground">{selector}</p></div>
                {assigned && <Button variant="ghost" size="sm" disabled={selecting || status !== "ready" || assigned.available === false} onClick={() => void choose(assigned)}>Use model</Button>}
              </div>;
            })}{roleEntries.length === 0 && <p className="p-4 text-xs text-muted-foreground">{loading ? "Loading role assignments…" : query ? "No roles match that filter." : "No model roles configured."}</p>}</div> : <>
              {loading && catalog.entries.length === 0 && <p role="status" className="p-4 text-xs text-muted-foreground">Loading the model catalog…</p>}
              {!loading && filtered.length === 0 && <p className="p-4 text-xs text-muted-foreground">{query || provider || kind !== "all" ? "No models match these filters." : "No models available. Refresh after checking provider configuration."}</p>}
              <div style={{ height: filtered.length * ROW_HEIGHT, position: "relative" }}>
                {filtered.slice(start, end).map((model, offset) => {
                  const index = start + offset;
                  const active = current && modelKey(current) === modelKey(model);
                  return <button key={modelKey(model)} type="button" data-index={index} aria-pressed={Boolean(active)} aria-label={modelKey(model)} disabled={selecting || status !== "ready" || model.available === false} onFocus={() => setHighlighted(index)} onClick={() => void choose(model)} style={{ position: "absolute", top: index * ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 0 }} className={cn("flex w-full items-center gap-2 border-b px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default", index === selectedIndex ? "bg-muted" : "enabled:hover:bg-muted/50")}>
                    <div className="min-w-0 flex-1"><div className="truncate font-mono text-xs" title={modelKey(model)}><span className="text-muted-foreground">{model.provider}/</span>{model.id}</div>
                      <div className="mt-1 flex gap-3 overflow-hidden whitespace-nowrap text-[10px] text-muted-foreground">
                        {!!model.contextWindow && <span>{formatTokens(model.contextWindow)} ctx</span>}
                        {model.cost && <span>${model.cost.input}/{model.cost.output} per M</span>}
                        {model.input?.includes("image") && <span>vision</span>}
                      </div>
                    </div>
                    {active && <Check aria-label="Current model" className="size-3.5 shrink-0 text-primary" />}
                  </button>;
                })}
              </div>
            </>}
          </div>
          <footer className="space-y-1 text-[10px] text-muted-foreground">
            <p className="truncate" title={current && modelKey(current)}>Current: <span className="font-mono text-foreground">{current ? modelKey(current) : "None selected"}</span></p>
            <div role="status" className="flex flex-wrap justify-between gap-1"><span>{selecting ? "Switching model…" : `${view === "roles" ? roleEntries.length + " roles" : filtered.length + " models"}${loading ? " · Refreshing in background…" : ""}`}</span><span>{view === "models" ? "↑ ↓ · Enter select · Esc back" : "Esc back"}</span></div>
          </footer>
        </div>
      </div>
    </section>
  );
}
