import { useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/diagnostics";
import { LoaderCircle, RotateCcw, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAppStore } from "@/lib/omp/store";
import { invalidateCatalog, splitExtraArgs } from "@/lib/omp/model-catalog";
import type { StartOptions } from "@/lib/omp/types";
import {
  effectiveSettingSummary,
  initialSettingDraft,
  isSecretSetting,
  isSettingDirty,
  validateSettingDraft,
  type NativeSetting,
  type NativeSettingDraft,
  type NativeSettingsCatalog,
  type NativeSettingWriteResult,
} from "@/lib/omp/native-settings";
import { cn } from "@/lib/utils";
import { pickerSearchClass, pickerSearchIconClass } from "./picker-styles";

interface RowFeedback {
  error?: string;
  success?: string;
}

interface CatalogState {
  scope: string;
  entries: Record<string, NativeSetting>;
  drafts: Record<string, NativeSettingDraft>;
  feedback: Record<string, RowFeedback>;
}

const booleanChoices = ["true", "false"];
const textareaClass = "scroll-thin w-full min-w-0 resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50";

export function NativeSettings({ active }: { active: boolean }) {
  const cwd = useAppStore((state) => state.cwd);
  const binary = useAppStore((state) => state.preferences.binary);
  const extraArgs = useAppStore((state) => state.preferences.extraArgs);
  const id = useId();
  const options = useMemo<StartOptions | undefined>(() => cwd ? {
    cwd,
    binary: binary.trim() || "omp",
    extraArgs: splitExtraArgs(extraArgs),
  } : undefined, [cwd, binary, extraArgs]);
  const [reload, setReload] = useState(0);
  const scope = JSON.stringify([active, options, reload]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const request = useRef(0);
  const writeLock = useRef(false);
  const [catalog, setCatalog] = useState<CatalogState>();
  const [loadError, setLoadError] = useState<{ scope: string; message: string }>();
  const [writing, setWriting] = useState<string>();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string>();
  const [effectiveStale, setEffectiveStale] = useState(false);

  useEffect(() => {
    const ticket = ++request.current;
    setCatalog(undefined);
    setLoadError(undefined);
    setEffectiveStale(false);
    setWriting(undefined);
    writeLock.current = false;
    if (!active || !options) return;
    const isCurrent = () => currentScope.current === scope && request.current === ticket;
    void invoke<NativeSettingsCatalog>("native_settings", { options }).then((result) => {
      if (!isCurrent()) return;
      setCatalog({
        scope,
        entries: result.entries,
        drafts: Object.fromEntries(Object.entries(result.entries).map(([key, entry]) => [key, initialSettingDraft(key, entry)])),
        feedback: {},
      });
    }).catch((error: unknown) => {
      if (isCurrent()) setLoadError({ scope, message: error instanceof Error ? error.message : String(error) });
    });
    return () => { ++request.current; };
  }, [active, options, scope]);

  const visibleCatalog = catalog?.scope === scope ? catalog : undefined;
  const loadFailed = loadError?.scope === scope;
  const loading = Boolean(options && !visibleCatalog && !loadFailed);
  const entries = visibleCatalog?.entries;
  const query = search.trim().toLowerCase();
  const matching = Object.entries(entries ?? {}).filter(([key, entry]) =>
    !query || `${key} ${entry.description}`.toLowerCase().includes(query));
  const groups = Array.from(new Set(Object.values(entries ?? {}).map((entry) => entry.group))).sort((a, b) => {
    if (a === "config") return -1;
    if (b === "config") return 1;
    return a.localeCompare(b);
  });
  const selectedGroup = group && groups.includes(group) ? group : undefined;
  const shown = matching.filter(([, entry]) => !selectedGroup || entry.group === selectedGroup);
  const busy = loading || writing !== undefined;
  const hasOverlay = options?.extraArgs?.some((arg) => arg === "--config" || arg.startsWith("--config="));

  function updateDraft(key: string, draft: NativeSettingDraft) {
    if (busy || !visibleCatalog) return;
    setCatalog((previous) => previous?.scope === scope ? {
      ...previous,
      drafts: { ...previous.drafts, [key]: draft },
      feedback: { ...previous.feedback, [key]: {} },
    } : previous);
  }

  async function writeSetting(key: string, reset: boolean) {
    if (!options || !visibleCatalog || busy || writeLock.current) return;
    const entry = visibleCatalog.entries[key];
    const draft = visibleCatalog.drafts[key];
    const secret = isSecretSetting(key, entry);
    if (!reset && !isSettingDirty(key, entry, draft)) return;
    const removing = reset || draft.mode === "inherit";
    if (!removing) {
      const error = validateSettingDraft(entry, draft.text);
      if (error) {
        setCatalog((previous) => previous?.scope === scope ? {
          ...previous, feedback: { ...previous.feedback, [key]: { error } },
        } : previous);
        return;
      }
    }
    writeLock.current = true;
    setWriting(key);
    const ticket = request.current;
    const isCurrent = () => currentScope.current === scope && request.current === ticket;
    try {
      const result = await invoke<NativeSettingWriteResult>("native_setting_write", {
        options, key,
        value: removing ? null : entry.type === "string" || entry.type === "enum" ? JSON.stringify(draft.text) : draft.text,
        reset: removing,
      });
      invalidateCatalog();
      if (!isCurrent()) return;
      let success = removing
        ? "Global override removed. Defaults, project settings, or environment now apply. Restart the agent to apply."
        : "Saved globally. Restart the agent to apply.";
      if (result.overriddenBy) success += ` Effective value is still overridden by ${result.overriddenBy}.`;
      if (result.fallbackEnv) success += ` Environment fallback: ${result.fallbackEnv}.`;
      // Commit the successful write before refreshing. A failed refresh must not
      // present a persisted write as failed or encourage resubmitting a secret.
      setCatalog((previous) => {
        if (previous?.scope !== scope) return previous;
        const stored = removing ? undefined : secret
          ? { redacted: true }
          : { value: entry.type === "array" || entry.type === "record" ? JSON.parse(draft.text) as unknown
            : entry.type === "number" ? Number(draft.text)
            : entry.type === "boolean" ? draft.text === "true" : draft.text };
        const updated = { ...entry, stored };
        return {
          ...previous,
          entries: { ...previous.entries, [key]: updated },
          drafts: { ...previous.drafts, [key]: initialSettingDraft(key, updated) },
          feedback: { ...previous.feedback, [key]: { success } },
        };
      });
      setEffectiveStale(true);
      try {
        const refreshed = await invoke<NativeSettingsCatalog>("native_settings", { options });
        if (!isCurrent()) return;
        setCatalog((previous) => {
          if (previous?.scope !== scope) return previous;
          return {
            ...previous,
            entries: refreshed.entries,
            drafts: Object.fromEntries(Object.entries(refreshed.entries).map(([name, item]) => [
              name, name === key ? initialSettingDraft(name, item) : previous.drafts[name] ?? initialSettingDraft(name, item),
            ])),
          };
        });
        setEffectiveStale(false);
      } catch {
        if (isCurrent()) setCatalog((previous) => previous?.scope === scope ? {
          ...previous,
          feedback: { ...previous.feedback, [key]: { success: `${success} Effective values could not be refreshed; use Reload.` } },
        } : previous);
      }
    } catch (error: unknown) {
      if (isCurrent()) setCatalog((previous) => previous?.scope === scope ? {
        ...previous,
        feedback: { ...previous.feedback, [key]: {
          error: secret ? "Could not save this credential. Check the native configuration and retry; your draft is preserved." : error instanceof Error ? error.message : String(error),
        } },
      } : previous);
    } finally {
      if (isCurrent()) {
        writeLock.current = false;
        setWriting(undefined);
      }
    }
  }

  if (!active) return null;

  return (
    <section className="min-w-0 space-y-3" aria-label="Native Oh My Pi settings" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1 text-[11px] text-muted-foreground">
          <p>Native Oh My Pi configuration. Each Save writes one global override; Reset removes it. Opening this section writes nothing.</p>
          <p>Effective values include project settings and environment. Drafts use only stored global values. Changes require an agent restart; nothing restarts automatically.</p>
          <p>Terminal-only options configure native omp, not the desktop renderer.</p>
          <p className="break-all">Saved launch scope: {options?.binary ?? "omp"} · {cwd ?? "No project selected"}</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy || !cwd} title="Reload native settings and discard unsaved drafts" onClick={() => setReload((value) => value + 1)}>
          <RotateCcw className="mr-1.5 size-3.5" /> Reload
        </Button>
      </div>
      {hasOverlay && <p role="note" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">Config overlays (--config) are not supported by native configuration queries or writes. This editor shows project/profile settings and writes the global layer, not the overlay.</p>}
      {!cwd ? <p className="text-xs text-muted-foreground">Select a project before loading native settings.</p> : loading ? (
        <p role="status" className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Loading native settings…</p>
      ) : loadFailed ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3">
          <p className="break-words text-xs text-destructive">{loadError.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>Retry</Button>
        </div>
      ) : visibleCatalog && <>
        <div className="relative">
          <Search aria-hidden="true" className={pickerSearchIconClass} />
          <Input aria-label="Search native setting keys and descriptions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search keys and descriptions…" className={pickerSearchClass} />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Native setting categories">
          {[undefined, ...groups].map((name) => <button key={name ?? "all"} type="button" aria-pressed={selectedGroup === name} onClick={() => setGroup(name)} className={cn("rounded-md border px-2 py-1 text-[11px] transition-colors", selectedGroup === name ? "border-primary/30 bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground")}>
            {name ?? "All"} ({name ? matching.filter(([, entry]) => entry.group === name).length : matching.length})
          </button>)}
        </div>
        {effectiveStale && <p role="status" className="text-xs text-muted-foreground">Effective summaries have not been refreshed since the last write.</p>}
        <p className="text-[10.5px] text-muted-foreground">{shown.length} of {Object.keys(visibleCatalog.entries).length} settings · Reload discards unsaved drafts.</p>
        <div className="@container divide-y border-y">
          {shown.length === 0 && <p role="status" className="py-6 text-center text-xs text-muted-foreground">No native settings match this search and category.</p>}
          {shown.map(([key, entry]) => {
            const draft = visibleCatalog.drafts[key];
            const secret = isSecretSetting(key, entry);
            const dirty = isSettingDirty(key, entry, draft);
            const feedback = visibleCatalog.feedback[key];
            const controlId = `${id}-${key}`;
            const descriptionId = `${controlId}-description`;
            const feedbackId = `${controlId}-feedback`;
            const choiceValues = entry.type === "boolean" ? booleanChoices : entry.choices;
            const selected = draft.mode === "inherit" ? "inherit" : `value:${draft.text}`;
            const choiceLabel = draft.mode === "inherit" ? "Inherit" : draft.text || '"" (empty string)';
            const structured = entry.type === "array" || entry.type === "record";
            const stored = entry.stored !== undefined;
            const describedBy = `${descriptionId} ${feedbackId}`;
            const effective = effectiveSettingSummary(key, entry);
            return (
              <article key={key} className="grid min-w-0 gap-2 px-1 py-3 @min-[48rem]:grid-cols-2 @min-[48rem]:gap-6">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Label htmlFor={controlId} className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs">{key}</Label>
                    <span className="text-[10px] text-muted-foreground">{entry.group} · {entry.type}{secret && " · credential"}</span>
                  </div>
                  <p id={descriptionId} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{entry.description || "Native configuration option."}</p>
                </div>

                <div className="min-w-0 space-y-1.5">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 text-xs">
                    <span className="text-muted-foreground">Effective{effectiveStale && !writing ? " (last loaded)" : ""}</span>
                    {effectiveStale && writing ? (
                      <p role="status" className="flex items-center gap-1.5">
                        <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> Refreshing…
                      </p>
                    ) : <pre className="scroll-thin max-h-24 overflow-auto font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{effective}</pre>}
                  </div>

                  <p className="text-[11px] text-muted-foreground">
                    Global override: {stored ? secret ? "configured (hidden)" : "stored" : "inherited"}.
                    {secret && " Enter a replacement to save; leaving it blank keeps the current value."}
                  </p>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    {!!choiceValues?.length && !secret ? (
                      <Select value={selected} disabled={busy} onValueChange={(value) => {
                        if (value !== null) updateDraft(key, value === "inherit" ? { mode: "inherit", text: "" } : { mode: "value", text: value.slice(6) });
                      }}>
                        <SelectTrigger size="sm" id={controlId} aria-describedby={describedBy}
                          className="w-40 max-w-full min-w-0 gap-2 bg-background text-xs data-popup-open:bg-muted [&>svg]:size-3.5 [&>svg]:shrink-0">
                          <SelectValue className="min-w-0"><span className="min-w-0 truncate">{choiceLabel}</span></SelectValue>
                        </SelectTrigger>
                        <SelectContent align="start" alignItemWithTrigger={false} className="scroll-thin p-1 motion-reduce:animate-none">
                          <SelectItem value="inherit" className="min-h-7 px-2 pr-7 text-xs">Inherit</SelectItem>
                          {draft.mode === "value" && !choiceValues.includes(draft.text) && (
                            <SelectItem value={selected} className="min-h-7 px-2 pr-7 text-xs">
                              <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{choiceLabel} (stored)</span>
                            </SelectItem>
                          )}
                          {choiceValues.map((choice) => (
                            <SelectItem key={choice} value={`value:${choice}`} className="min-h-7 px-2 pr-7 text-xs">
                              <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{choice || '"" (empty string)'}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : structured && !secret ? (
                      <textarea id={controlId} rows={4} className={textareaClass} disabled={busy} value={draft.text}
                        placeholder={`Enter a JSON ${entry.type === "array" ? "array" : "object"}`} aria-describedby={describedBy} spellCheck={false}
                        onChange={(event) => updateDraft(key, { mode: "value", text: event.target.value })} />
                    ) : (
                      <Input id={controlId} type={secret ? "password" : entry.type === "number" ? "number" : "text"}
                        step={entry.type === "number" ? "any" : undefined} disabled={busy} value={draft.text}
                        placeholder={secret ? (structured ? "Enter replacement JSON" : "Enter replacement") : draft.mode === "inherit" ? `Inherited: ${effective}` : "Global value"}
                        className="h-7 min-w-0 max-w-sm flex-1 basis-44 font-mono text-xs" autoComplete="off" spellCheck={false}
                        aria-describedby={describedBy} onChange={(event) => updateDraft(key, { mode: "value", text: event.target.value })} />
                    )}

                    <Button type="button" size="sm" variant={dirty ? "secondary" : "ghost"} className="text-xs"
                      disabled={busy || !dirty} aria-label={`Save ${key}`} onClick={() => void writeSetting(key, false)}>
                      {writing === key ? <LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden="true" className="size-3" />} Save
                    </Button>
                    {stored && (
                      <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground"
                        disabled={busy} title="Remove the global override" aria-label={`Reset global override for ${key}`} onClick={() => void writeSetting(key, true)}>
                        <RotateCcw aria-hidden="true" className="size-3" /> Reset
                      </Button>
                    )}
                    {entry.type === "string" && !secret && !entry.choices?.length && draft.text === "" && !stored && (
                      <Button type="button" variant="ghost" size="sm" className="text-xs" disabled={busy || draft.mode === "value"}
                        onClick={() => updateDraft(key, { mode: "value", text: "" })}>Use empty string</Button>
                    )}
                  </div>

                  {dirty && <p className="text-[11px] text-muted-foreground">{draft.mode === "inherit" ? "Saving removes the global override." : draft.text === "" ? "Saving sets an explicit empty string." : "Unsaved override"}</p>}
                  <div id={feedbackId} aria-live="polite" className="text-xs [overflow-wrap:anywhere]">
                    {feedback?.error && <p role="alert" className="text-destructive">{feedback.error}</p>}
                    {feedback?.success && <p role="status" className="text-muted-foreground">{feedback.success}</p>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </>}
    </section>
  );
}
