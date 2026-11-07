import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { formatTokens } from "@/lib/omp/format";
import type { Model } from "@/lib/omp/types";

export function ModelPicker({ onClose }: { onClose: () => void }) {
  const models = useAppStore((state) => state.models);
  const loading = useAppStore((state) => state.modelsLoading);
  const error = useAppStore((state) => state.modelsError);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const setModel = useAppStore((state) => state.setModel);
  const current = useAppStore((state) => state.session?.model);
  const status = useAppStore((state) => state.status);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const selectionPending = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (useAppStore.getState().models === undefined) void fetchModels();
  }, [fetchModels]);

  const grouped = useMemo(() => {
    const search = query.trim().toLowerCase();
    const groups = new Map<string, Model[]>();
    for (const model of models ?? []) {
      if (search && !`${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase().includes(search)) continue;
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, query]);
  const filtered = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);
  const selectedIndex = Math.min(highlighted, Math.max(0, filtered.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, filtered]);

  async function choose(model: Model) {
    if (selectionPending.current || status !== "ready") return;
    selectionPending.current = true;
    setSelecting(true);
    try {
      if (await setModel(model.provider, model.id)) onClose();
    } finally {
      selectionPending.current = false;
      setSelecting(false);
    }
  }

  let optionIndex = 0;
  return (
    <section
      aria-labelledby="model-page-title"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !selecting) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 font-mono text-xs text-muted-foreground">/model</div>
            <h1 id="model-page-title" className="text-xl font-semibold">Choose a model</h1>
            <p className="mt-1 text-xs text-muted-foreground">Changes apply to this live session.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={selecting}>
            <ArrowLeft className="size-3.5" /> Back to chat
          </Button>
        </div>

        <div className="rounded-lg border bg-card px-3 py-2 text-xs">
          <span className="text-muted-foreground">Current model </span>
          <span className="break-all font-mono">{current ? `${current.provider}/${current.id}` : "None selected"}</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              aria-label="Filter models"
              aria-controls="model-options"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (filtered.length) setHighlighted((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const model = filtered[selectedIndex];
                  if (model) void choose(model);
                }
              }}
              placeholder="Filter by provider or model…"
              className="pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchModels()} disabled={loading || selecting || status !== "ready"}>
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </Button>
        </div>

        {error && <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
        {status !== "ready" && <p role="status" className="text-xs text-muted-foreground">Connect to the agent to change models.</p>}

        <div id="model-options" ref={listRef} aria-label="Available models" className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-1.5">
          {loading && !models?.length && <div role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading the model catalog…</div>}
          {!loading && filtered.length === 0 && <p className="py-10 text-center text-xs text-muted-foreground">{query.trim() ? "No models match that filter." : error ? "Model discovery failed. Use Refresh to try again." : "No models available. Check your provider configuration, then refresh."}</p>}
          {grouped.map(([provider, providerModels]) => (
            <div key={provider} className="mb-3">
              <h2 className="sticky top-0 bg-background px-2 py-2 text-xs font-medium text-muted-foreground">{provider}</h2>
              {providerModels.map((model) => {
                const index = optionIndex++;
                const active = current?.provider === model.provider && current.id === model.id;
                return (
                  <button
                    key={`${model.provider}/${model.id}`}
                    type="button"
                    data-index={index}
                    aria-pressed={active}
                    disabled={selecting || status !== "ready"}
                    onFocus={() => setHighlighted(index)}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => void choose(model)}
                    className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", index === selectedIndex ? "bg-muted" : "hover:bg-muted/50")}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-sm">{model.name?.trim() || model.id}</div>
                      <div className="break-all font-mono text-xs text-muted-foreground">{model.id}</div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {!!model.contextWindow && <span>{formatTokens(model.contextWindow)} context</span>}
                        {model.cost && <span>${model.cost.input}/M in · ${model.cost.output}/M out</span>}
                        {model.input?.includes("image") && <span>vision</span>}
                      </div>
                    </div>
                    {active && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" /> Current</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div role="status" className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{selecting ? "Switching model…" : `${filtered.length} of ${models?.length ?? 0} models`}</span>
          <span>↑ ↓ navigate · Enter select · Esc back</span>
        </div>
      </div>
    </section>
  );
}
