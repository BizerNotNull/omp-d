import { useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, RotateCcw, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/lib/omp/store";
import { splitExtraArgs } from "@/lib/omp/model-catalog";
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

const fieldClass = "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

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
  const scope = JSON.stringify([active, options]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const request = useRef(0);
  const writeLock = useRef(false);
  const [catalog, setCatalog] = useState<CatalogState>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ scope: string; message: string }>();
  const [writing, setWriting] = useState<string>();
  const [reload, setReload] = useState(0);
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
    if (!active || !options) {
      setLoading(false);
      return;
    }
    setLoading(true);
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
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    return () => { ++request.current; };
  }, [active, options, scope, reload]);

  const visibleCatalog = catalog?.scope === scope ? catalog : undefined;
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
          <p>Native Oh My Pi configuration. Each Save writes one global override; Reset removes it. Opening this tab writes nothing.</p>
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
      ) : loadError?.scope === scope ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3">
          <p className="break-words text-xs text-destructive">{loadError.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>Retry</Button>
        </div>
      ) : visibleCatalog && <>
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-3.5 text-muted-foreground" />
          <Input aria-label="Search native setting keys and descriptions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search keys and descriptions…" className="pl-9 text-xs" />
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Native setting categories">
          {[undefined, ...groups].map((name) => <button key={name ?? "all"} type="button" aria-pressed={selectedGroup === name} onClick={() => setGroup(name)} className={cn("rounded-md border px-2 py-1 text-[11px] transition-colors", selectedGroup === name ? "border-primary/30 bg-muted text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground")}>
            {name ?? "All"} ({name ? matching.filter(([, entry]) => entry.group === name).length : matching.length})
          </button>)}
        </div>
        {effectiveStale && <p role="status" className="text-xs text-muted-foreground">Effective summaries have not been refreshed since the last write.</p>}
        <p className="text-[10.5px] text-muted-foreground">{shown.length} of {Object.keys(visibleCatalog.entries).length} settings · Reload discards unsaved drafts.</p>
        <div className="space-y-3">
          {shown.length === 0 && <p role="status" className="py-6 text-center text-xs text-muted-foreground">No native settings match this search and category.</p>}
          {shown.map(([key, entry]) => {
            const draft = visibleCatalog.drafts[key];
            const secret = isSecretSetting(key, entry);
            const dirty = isSettingDirty(key, entry, draft);
            const feedback = visibleCatalog.feedback[key];
            const controlId = `${id}-${key}`;
            const descriptionId = `${controlId}-description`;
            const feedbackId = `${controlId}-feedback`;
            const choiceValues = entry.type === "boolean" ? ["true", "false"] : entry.choices;
            const selected = draft.mode === "inherit" ? "inherit" : `value:${draft.text}`;
            const structured = entry.type === "array" || entry.type === "record";
            const effective = effectiveSettingSummary(key, entry);
            return <article key={key} className="min-w-0 space-y-2 rounded-lg border bg-muted/10 p-3">
              <div className="flex flex-wrap items-start justify-between gap-1.5">
                <Label htmlFor={controlId} className="min-w-0 break-all font-mono text-xs">{key}</Label>
                <span className="text-[10px] text-muted-foreground">{entry.group} · {entry.type}{secret ? " · credential" : ""}{dirty ? " · unsaved" : ""}</span>
              </div>
              <p id={descriptionId} className="break-words text-[11px] text-muted-foreground">{entry.description || "Native configuration option."}</p>
              <div className="min-w-0 rounded-md bg-muted/40 p-2 text-[10.5px]">
                <div className="text-muted-foreground">Effective now{effectiveStale ? " (last loaded)" : ""}</div>
                <pre className="scroll-thin max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono">{effective}</pre>
              </div>
              <div className="text-[10.5px] text-muted-foreground">Global override: {entry.stored === undefined ? "not set (inherited)" : secret ? "configured (hidden)" : "stored"}. {secret ? "Leave blank to keep it unchanged; enter a replacement to Save." : "Only this global layer is edited below."}</div>
              {!!choiceValues?.length && !secret ? <select id={controlId} className={fieldClass} disabled={busy} value={selected} aria-describedby={`${descriptionId} ${feedbackId}`} onChange={(event) => updateDraft(key, event.target.value === "inherit" ? { mode: "inherit", text: "" } : { mode: "value", text: event.target.value.slice(6) })}>
                <option value="inherit">Inherit (no global override)</option>
                {draft.mode === "value" && !choiceValues.includes(draft.text) && <option value={`value:${draft.text}`}>{draft.text} (stored)</option>}
                {choiceValues.map((choice) => <option key={choice} value={`value:${choice}`}>{choice}</option>)}
              </select> : structured && !secret ? <textarea id={controlId} rows={4} className={cn(fieldClass, "scroll-thin resize-y font-mono")} disabled={busy} value={draft.text} placeholder={`Inherited; enter a JSON ${entry.type === "array" ? "array" : "object"} to override`} aria-describedby={`${descriptionId} ${feedbackId}`} spellCheck={false} onChange={(event) => updateDraft(key, { mode: "value", text: event.target.value })} /> : <Input id={controlId} type={secret ? "password" : entry.type === "number" ? "number" : "text"} step={entry.type === "number" ? "any" : undefined} disabled={busy} value={draft.text} placeholder={secret ? (structured ? "Enter replacement JSON (hidden)" : "Enter replacement (hidden)") : draft.mode === "inherit" ? `Inherited: ${effective}` : "Global value"} className="font-mono text-xs" autoComplete="off" spellCheck={false} aria-describedby={`${descriptionId} ${feedbackId}`} onChange={(event) => updateDraft(key, { mode: "value", text: event.target.value })} />}
              {structured && <p className="text-[10.5px] text-muted-foreground">Enter JSON {entry.type === "array" ? "array, e.g. []" : "object, e.g. {}"}. Native validation also runs when saving.</p>}
              {entry.type === "string" && !secret && !entry.choices?.length && draft.text === "" && entry.stored === undefined && <Button type="button" variant="ghost" size="sm" disabled={busy || draft.mode === "value"} onClick={() => updateDraft(key, { mode: "value", text: "" })}>Use empty string (not inherited)</Button>}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy || !dirty} aria-label={`Save ${key}`} onClick={() => void writeSetting(key, false)}>
                  {writing === key ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />} Save
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy || entry.stored === undefined} title="Remove only the global override; defaults, project settings, or environment will apply" aria-label={`Reset global override for ${key}`} onClick={() => void writeSetting(key, true)}><RotateCcw className="mr-1.5 size-3.5" /> Reset</Button>
                {dirty && <span className="text-[10.5px] text-muted-foreground">{draft.mode === "inherit" ? "Save removes the global override." : draft.text === "" ? "Save writes an explicit empty string." : "Unsaved global draft"}</span>}
              </div>
              <div id={feedbackId} aria-live="polite" className="break-words text-[11px]">
                {feedback?.error && <p role="alert" className="text-destructive">{feedback.error}</p>}
                {feedback?.success && <p role="status" className="text-muted-foreground">{feedback.success}</p>}
              </div>
            </article>;
          })}
        </div>
      </>}
    </section>
  );
}
