import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, Layers3, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { formatTokens, modelLabel } from "@/lib/omp/format";
import type { Model } from "@/lib/omp/types";
import { splitExtraArgs } from "@/lib/omp/model-catalog";
import { ModelRolesPanel } from "./ModelRolesPanel";
import { ModelPolicyPanel } from "./ModelPolicyPanel";
import { useModelSettings } from "./useModelSettings";
import { pickerDetailClass, pickerRowClass } from "./picker-styles";

const ROW_HEIGHT = 48;
const OVERSCAN = 5;
const modelKey = (model: Model) => `${model.provider}/${model.id}`;
const fieldClass = "h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";
const catalogSelectClass = cn(fieldClass, "h-8 w-full px-2 text-xs");
const views = [["models", "Catalog"], ["roles", "Roles & fallbacks"], ["policy", "Runtime policy"]] as const;
type ModelView = (typeof views)[number][0];

export function ModelPicker({ onClose, onLoginRequest, active = true }: { onClose: () => void; onLoginRequest: (provider: string) => void; active?: boolean }) {
  const models = useAppStore((state) => state.models);
  const roles = useAppStore((state) => state.modelRoles);
  const modelsLoading = useAppStore((state) => state.modelsLoading);
  const modelsError = useAppStore((state) => state.modelsError);
  const rolesLoading = useAppStore((state) => state.rolesLoading);
  const rolesError = useAppStore((state) => state.rolesError);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const setModel = useAppStore((state) => state.setModel);
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel);
  const levels = useAppStore((state) => state.thinkingLevels);
  const session = useAppStore((state) => state.session);
  const status = useAppStore((state) => state.status);
  const cwd = useAppStore((state) => state.cwd);
  const binary = useAppStore((state) => state.preferences.binary);
  const extraArgs = useAppStore((state) => state.preferences.extraArgs);
  const current = session?.model;
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [view, setView] = useState<ModelView>("models");
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [kind, setKind] = useState("");
  const [highlighted, setHighlighted] = useState<string>();
  const [changing, setChanging] = useState<"model" | "thinking">();
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const changePending = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const options = useMemo(() => settingsOpened && cwd ? { cwd, binary: binary.trim() || "omp", extraArgs: splitExtraArgs(extraArgs) } : undefined, [settingsOpened, cwd, binary, extraArgs]);
  const settings = useModelSettings(options);
  const hasLaunchOverlay = options?.extraArgs.some((arg) => arg === "--config" || arg.startsWith("--config="));
  const switchingDisabled = status !== "ready" || Boolean(changing);
  const thinking = session?.thinkingLevel ?? "";

  useEffect(() => {
    if (active && view === "models") searchRef.current?.focus();
  }, [active, view]);

  useLayoutEffect(() => {
    if (active && status === "ready") void fetchModels();
  }, [active, fetchModels, status]);

  const catalog = useMemo(() => {
    const loaded = models ?? [];
    const currentKey = current && modelKey(current);
    const entries = current && !loaded.some((model) => modelKey(model) === currentKey) ? [current, ...loaded] : loaded;
    const counts = new Map<string, number>();
    let available = 0;
    for (const model of entries) {
      const usable = Number(model.available !== false);
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + usable);
      available += usable;
    }
    const providers = [...counts].sort(([a], [b]) => a.localeCompare(b));
    return {
      entries, available,
      readyProviders: providers.filter(([, count]) => count > 0),
      setupProviders: providers.filter(([, count]) => count === 0),
    };
  }, [models, current]);
  const needsSetup = catalog.setupProviders.some(([id]) => id === provider);
  const scope = useMemo(() => catalog.entries.filter((model) =>
    provider ? model.provider === provider : model.available !== false), [catalog.entries, provider]);
  const kinds = useMemo(() => {
    const values = new Set<string>();
    for (const model of scope) if (model.kind) values.add(model.kind);
    return [...values].sort();
  }, [scope]);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!kind && !search) return scope;
    return scope.filter((model) =>
      (!kind || model.kind === kind) &&
      (!search || `${modelKey(model)} ${model.name ?? ""}`.toLowerCase().includes(search)));
  }, [scope, query, kind]);
  const highlightedIndex = highlighted === undefined ? -1 : filtered.findIndex((model) => modelKey(model) === highlighted);
  const start = Math.min(Math.max(0, filtered.length - 1), Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const end = Math.min(filtered.length, Math.max(start + 1, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN));
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(list);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => {
    setHighlighted(undefined);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, provider, kind, view]);

  async function choose(model: Model) {
    const state = useAppStore.getState();
    if (changePending.current || state.status !== "ready" || model.available === false) return;
    changePending.current = true;
    setChanging("model");
    try {
      if (await setModel(model.provider, model.id)) onClose();
    } finally {
      changePending.current = false;
      setChanging(undefined);
    }
  }

  async function changeThinking(level: string) {
    if (changePending.current || useAppStore.getState().status !== "ready") return;
    changePending.current = true;
    setChanging("thinking");
    try {
      await setThinkingLevel(level);
    } finally {
      changePending.current = false;
      setChanging(undefined);
    }
  }

  function navigate(delta: number) {
    const count = filtered.length;
    if (!count) return;
    let next = highlightedIndex === -1 ? (delta > 0 ? 0 : count - 1) : (highlightedIndex + delta + count) % count;
    for (let visited = 0; visited < count && filtered[next].available === false; visited++) {
      next = (next + delta + count) % count;
    }
    if (filtered[next].available === false) return;
    setHighlighted(modelKey(filtered[next]));
    const list = listRef.current;
    if (!list) return;
    const top = next * ROW_HEIGHT;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
  }

  function selectProvider(value: string) {
    setProvider(value);
    setKind("");
  }

  function clearFilters() {
    setQuery("");
    selectProvider("");
    searchRef.current?.focus();
  }

  function providerButton(id: string, label: string, count?: number) {
    return <button key={id} type="button" aria-pressed={provider === id} onClick={() => selectProvider(id)}
      className={cn(pickerRowClass, "min-h-7",
        provider === id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      {count !== undefined && <span className="text-[11px] tabular-nums">{count}</span>}
    </button>;
  }

  const refresh = <Button variant="outline" size="icon" onClick={() => void fetchModels(true)} disabled={modelsLoading || rolesLoading || switchingDisabled} aria-label="Refresh model catalog" title="Refresh model catalog">
    <RefreshCw aria-hidden="true" className={cn("size-3.5", modelsLoading && "animate-spin motion-reduce:animate-none")} />
  </Button>;
  const canClear = Boolean(query || provider || kind);
  const resultStatus = changing === "model" ? "Switching model…" : changing === "thinking" ? "Updating thinking level…" : modelsLoading ? "Refreshing catalog…" : `${filtered.length} ${filtered.length === 1 ? "model" : "models"}`;

  return (
    <section aria-labelledby="model-page-title" className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && event.currentTarget.contains(event.target as Node) && !changing && !settings.busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
      <header className="shrink-0 border-b bg-card">
        <div className="mx-auto grid w-full max-w-screen-2xl grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 px-3 pt-2 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-x-5 md:px-5 md:pt-0">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" aria-label="Back to chat" title="Back to chat" onClick={onClose} disabled={Boolean(changing) || settings.busy}>
              <ArrowLeft aria-hidden="true" className="size-4" />
            </Button>
            <h1 id="model-page-title" className="text-sm font-medium">Models</h1>
          </div>
          <nav aria-label="Model workspace" className="col-span-full row-start-2 flex min-w-0 gap-2 overflow-x-auto md:col-span-1 md:col-start-2 md:row-start-1">
            {views.map(([value, label]) => <button key={value} type="button" aria-current={view === value ? "page" : undefined}
              disabled={settings.busy || Boolean(changing)} onClick={() => { setView(value); if (value !== "models") setSettingsOpened(true); }}
              className={cn("shrink-0 border-b-2 px-1.5 py-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:py-3.5",
                value === view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</button>)}
          </nav>
          {view === "models" && <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 md:col-start-3 md:max-w-xs">
            <div className="min-w-0 text-right">
              <p className="text-xs text-muted-foreground">Current model</p>
              <p className="truncate text-xs font-medium" title={current && modelKey(current)}>{modelLabel(current)}</p>
            </div>
            <label className="flex shrink-0 flex-col gap-0.5 text-xs text-muted-foreground md:flex-row md:items-center md:gap-2">
              Thinking
              <select aria-label="Current session thinking level" className={cn(fieldClass, "h-7 max-w-28 px-1.5 text-xs capitalize text-foreground sm:h-8 sm:text-sm")} disabled={switchingDisabled || !levels.length} value={thinking} onChange={(event) => void changeThinking(event.target.value)}>
                {!levels.includes(thinking) && <option value={thinking} disabled>{thinking || "Unavailable"}</option>}
                {levels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          </div>}
        </div>
      </header>

      {view === "models" && <div className="mx-auto flex min-h-0 w-full max-w-screen-2xl flex-1">
        <aside aria-label="Filter models by provider" className="hidden min-h-0 w-40 shrink-0 flex-col border-r border-sidebar-border bg-sidebar/40 md:flex lg:w-44">
          <h2 className="px-3 pt-3 pb-1.5 text-[11px] font-medium text-muted-foreground">Providers</h2>
          <div className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2 pb-2">
            {providerButton("", "All available", catalog.available)}
            {!!catalog.readyProviders.length && <div className="my-1 border-t" />}
            {catalog.readyProviders.map(([id, count]) => providerButton(id, id, count))}
            {!!catalog.setupProviders.length && <>
              <p className="mt-2 px-2 py-1 text-[11px] font-medium text-muted-foreground">Setup required</p>
              {catalog.setupProviders.map(([id]) => providerButton(id, id))}
            </>}
          </div>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5 px-3 pt-2 md:grid-cols-[minmax(0,24rem)_7rem_auto] md:justify-start">
            <SearchInput className="col-span-full md:col-span-1" ref={searchRef} aria-label="Search models" aria-controls={listId} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || switchingDisabled) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                navigate(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const model = highlightedIndex >= 0 ? filtered[highlightedIndex] : filtered.find((item) => item.available !== false);
                if (model) void choose(model);
              }
            }} placeholder="Search name, ID, or provider…" clear={query ? { label: "Clear model search", onClick: () => { setQuery(""); searchRef.current?.focus(); } } : undefined} />
            <select aria-label="Filter by provider" className={cn(catalogSelectClass, "md:hidden")} value={provider} onChange={(event) => selectProvider(event.target.value)}>
              <option value="">All available</option>
              {!!catalog.readyProviders.length && <optgroup label="Available providers">
                {catalog.readyProviders.map(([id, count]) => <option key={id} value={id}>{id} ({count})</option>)}
              </optgroup>}
              {!!catalog.setupProviders.length && <optgroup label="Setup required">
                {catalog.setupProviders.map(([id]) => <option key={id} value={id}>{id}</option>)}
              </optgroup>}
            </select>
            <select aria-label="Filter by model type" className={cn(catalogSelectClass, "capitalize")} value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">All types</option>
              {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            {refresh}
          </div>
          {modelsError && <p role="alert" className="mx-3 mt-2 break-words text-xs text-destructive">{modelsError}{models && " Showing the last loaded catalog."}</p>}
          {status !== "ready" && <p role="status" className="mx-3 mt-2 text-xs text-muted-foreground">Connect to the agent to change models.</p>}
          {needsSetup && <div className="mx-3 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs">
            <p className="min-w-0 break-words text-muted-foreground"><strong className="font-medium text-foreground">{provider}</strong> requires sign-in or configuration.</p>
            <Button variant="outline" size="sm" onClick={() => onLoginRequest(provider)}>Provider sign-in <ArrowUpRight aria-hidden="true" className="size-3.5" /></Button>
          </div>}
          <div className="mt-1 flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-7 shrink-0 items-center justify-between gap-2 border-b px-3">
              <span role="status" className="text-[11px] font-medium text-muted-foreground">{resultStatus}</span>
              <span role="status" className="sr-only">{highlightedIndex >= 0 ? modelKey(filtered[highlightedIndex]) : ""}</span>
              {canClear && <Button variant="ghost" size="xs" className="-mr-1.5" onClick={clearFilters}>Clear filters</Button>}
            </div>
            <div id={listId} ref={listRef} aria-label="Model results" className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-2" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
              {!filtered.length ? <div className="grid min-h-full place-items-center p-4 text-center">
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  {modelsLoading ? <LoaderCircle aria-hidden="true" className="mx-auto mb-3 size-5 animate-spin motion-reduce:animate-none" /> : <Layers3 aria-hidden="true" className="mx-auto mb-3 size-5" />}
                  <p className="font-medium text-foreground">{modelsLoading ? "Loading models…" : modelsError ? "Catalog unavailable" : canClear ? "No matching models" : "No available models"}</p>
                  {!modelsLoading && <p>{modelsError ? "Refresh the catalog to retry." : canClear ? "Try a different search or clear the filters." : "Check provider setup, then refresh the catalog."}</p>}
                </div>
              </div> : <div style={{ height: filtered.length * ROW_HEIGHT }} className="relative">
                {filtered.slice(start, end).map((model, offset) => {
                  const index = start + offset;
                  const selector = modelKey(model);
                  const isCurrent = current !== undefined && current.provider === model.provider && current.id === model.id;
                  const imageInput = model.input?.includes("image");
                  return <button key={selector} type="button" aria-current={isCurrent || undefined} disabled={switchingDisabled || model.available === false} onFocus={() => setHighlighted(selector)}
                    onClick={() => void choose(model)} style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT - 2 }}
                    className={cn(pickerRowClass, "absolute inset-x-0",
                      highlightedIndex === index ? "bg-muted" : isCurrent ? "bg-sidebar-accent" : "enabled:hover:bg-muted/60")}>
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate", isCurrent && "font-medium")} title={modelLabel(model)}>{modelLabel(model)}</span>
                      <span className="flex min-w-0 flex-col md:flex-row md:items-center md:gap-2">
                        <span className={cn(pickerDetailClass, "font-mono md:max-w-[65%]")} title={selector}>{selector}</span>
                        {Boolean(model.contextWindow || imageInput || model.cost) && <span className={cn(pickerDetailClass, "flex min-w-0 items-center gap-2 md:border-l md:pl-2")}>
                          {!!model.contextWindow && <span className="shrink-0">{formatTokens(model.contextWindow)} context</span>}
                          {imageInput && <span className="shrink-0">Image input</span>}
                          {model.cost && <span className="min-w-0 truncate">${model.cost.input} in · ${model.cost.output} out / 1M</span>}
                        </span>}
                      </span>
                    </span>
                    {isCurrent ? <span className={cn(pickerDetailClass, "flex shrink-0 items-center gap-1")}><Check aria-hidden="true" className="size-3.5" /> Current</span>
                      : model.available === false && <span className={cn(pickerDetailClass, "shrink-0")}>Unavailable</span>}
                  </button>;
                })}
              </div>}
            </div>
          </div>
          <p className="hidden shrink-0 border-t px-3 py-1.5 text-[10px] text-muted-foreground sm:block">↑ ↓ Browse · Enter switch · Esc back</p>
        </div>
      </div>}
      {settingsOpened && <div className={cn("min-h-0 flex-1 flex-col overflow-hidden", view === "models" ? "hidden" : "flex")}>
        <div className="mx-auto flex min-h-0 w-full max-w-screen-2xl flex-1 flex-col">
          {(view === "policy" || !settings.entries) && <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
            <h2 className="text-xs font-medium">{view === "roles" ? "Roles & fallbacks" : "Runtime policy"}</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Reload settings" title="Reload settings" onClick={settings.reload} disabled={settings.busy}><RefreshCw aria-hidden="true" className="size-3.5" /></Button>
          </div>}
          {hasLaunchOverlay && <p className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">The agent uses a launch configuration overlay. Values resolved here exclude that overlay.</p>}
          {!settings.entries && !settings.error && <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> Loading native settings…</p>}
          {settings.entries && <>
            <div className={view === "roles" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              {rolesError && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1"><p role="alert" className="text-xs text-destructive">{rolesError}</p>{refresh}</div>}
              <ModelRolesPanel entries={settings.entries} busy={settings.busy} stale={settings.stale} onReload={settings.reload} onSave={settings.save} models={catalog.entries} roles={roles} />
            </div>
            <div className={view === "policy" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
              <ModelPolicyPanel entries={settings.entries} busy={settings.busy || Boolean(settings.stale)} onSave={settings.save} currentModel={current} currentAutoCompaction={session?.autoCompactionEnabled} />
            </div>
          </>}
        </div>
      </div>}
      {view !== "models" && (settings.error || settings.notice || settings.busy) && <div className="shrink-0 border-t bg-card">
        <div className="mx-auto w-full max-w-screen-2xl space-y-1 px-3 py-2 text-sm md:px-5">
          {settings.error && <p role="alert" className="text-destructive">{settings.error}</p>}
          {(settings.notice || settings.busy) && <p role="status" className="text-muted-foreground">{settings.busy ? "Saving global settings…" : settings.notice}</p>}
        </div>
      </div>}
    </section>
  );
}
