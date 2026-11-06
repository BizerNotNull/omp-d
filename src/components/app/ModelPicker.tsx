import { useEffect, useMemo, useState } from "react";
import { Check, LoaderCircle, RefreshCw, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import { formatTokens } from "@/lib/omp/format";

export function ModelPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const models = useAppStore((state) => state.models);
  const loading = useAppStore((state) => state.modelsLoading);
  const error = useAppStore((state) => state.modelsError);
  const fetchModels = useAppStore((state) => state.fetchModels);
  const setModel = useAppStore((state) => state.setModel);
  const current = useAppStore((state) => state.session?.model);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open && models === undefined && !loading) void fetchModels();
  }, [open, models, loading, fetchModels]);

  const grouped = useMemo(() => {
    const filtered = (models ?? []).filter((model) => {
      if (!query.trim()) return true;
      const haystack = `${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    });
    const groups = new Map<string, typeof filtered>();
    for (const model of filtered) {
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Model</DialogTitle>
          <DialogDescription>
            Model changes apply to this live session. Discovery can take a moment on a cold start.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by provider or model…"
              className="h-8 pl-8 text-[12px]"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => void fetchModels()} disabled={loading} className="gap-1.5">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </Button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            {error}
          </div>
        )}

        <ScrollArea className="h-[52vh] rounded-lg border">
          <div className="p-1.5">
            {loading && (models?.length ?? 0) === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> Loading the model catalog…
              </div>
            )}
            {!loading && grouped.length === 0 && (
              <div className="py-10 text-center text-[11px] text-muted-foreground">No models match that filter.</div>
            )}
            {grouped.map(([provider, providerModels]) => (
              <div key={provider} className="mb-2">
                <div className="px-2 py-1 text-[9.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {provider}
                </div>
                {providerModels.map((model) => {
                  const active = current?.provider === model.provider && current.id === model.id;
                  return (
                    <button
                      key={`${model.provider}/${model.id}`}
                      type="button"
                      onClick={() => {
                        void setModel(model.provider, model.id);
                        onOpenChange(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        active ? "bg-muted" : "hover:bg-muted/50",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="truncate text-[12px]">{model.name?.trim() || model.id}</span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground">{model.id}</span>
                        </div>
                        <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground/70">
                          {model.contextWindow && <span>{formatTokens(model.contextWindow)} ctx</span>}
                          {model.cost && (
                            <span>
                              ${model.cost.input}/M in · ${model.cost.output}/M out
                            </span>
                          )}
                          {model.input?.includes("image") && <span>vision</span>}
                        </div>
                      </div>
                      {active && <Check className="size-3.5 text-emerald-500" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </ScrollArea>

        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {models?.length ?? 0} available models
            {query && ` · ${grouped.reduce((total, [, list]) => total + list.length, 0)} match`}
          </span>
          <span className="font-mono">{current ? `${current.provider}/${current.id}` : "no model"}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
