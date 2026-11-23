import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NativeSetting } from "@/lib/omp/native-settings";
import type { Model } from "@/lib/omp/types";
import { cn } from "@/lib/utils";

const PRIMARY = "modelRoles";
const FALLBACKS = "retry.fallbackChains";
const chatRoles = ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor", "widget"];
const kindRoles = ["image", "web", "speech", "dictation", "judge"];
const fallbackEfforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
const effortSuffix = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;
const selectClass = "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";
const editorInputClass = "h-8 min-w-0 font-mono text-xs md:text-xs";

type NativeRecord = Record<string, unknown>;
type EditorTarget = { kind: "role" | "rule"; key?: string };
type Choice = { id: number; value: string };

function readRecord(value: unknown): NativeRecord | undefined {
  if (value === undefined) return {};
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as NativeRecord) : undefined;
}

function storedRecord(entry: NativeSetting | undefined) {
  return entry?.type === "record" && !entry.stored?.redacted ? readRecord(entry.stored?.value) : undefined;
}

function item(record: NativeRecord | undefined, key: string) {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isChain(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sameChain(a: unknown, b: unknown) {
  return a === b || (isChain(a) && isChain(b) && a.length === b.length && a.every((value, index) => value === b[index]));
}

function changeItem(record: NativeRecord, key: string, value: string | string[] | undefined) {
  if (value !== undefined) return { ...record, [key]: value };
  const rest = { ...record };
  delete rest[key];
  return Object.keys(rest).length ? rest : undefined;
}

function matchingModelRule(primary: unknown, rules: readonly string[]) {
  if (typeof primary !== "string") return undefined;
  const selector = primary.trim().replace(effortSuffix, "");
  // A list, pattern, or alias needs runtime resolution before a rule can be matched.
  if (!/^[^@/,\s*?]+\/[^,\s*?]+$/.test(selector)) return undefined;
  if (rules.includes(selector)) return selector;
  let match: string | undefined;
  for (const rule of rules) {
    if (rule.endsWith("/*") && selector.startsWith(rule.slice(0, -1)) && (!match || rule.length > match.length)) match = rule;
  }
  return match;
}

function acceptsRole(role: string | undefined, model: Model) {
  const kind = model.kind ?? "chat";
  switch (role) {
    case undefined: return true;
    case "image": return kind === "image";
    case "web": return kind === "search" || kind === "chat";
    case "speech": return kind === "tts";
    case "dictation": return kind === "stt";
    case "judge": return kind === "judge" || kind === "tiny" || kind === "chat";
    case "tiny": case "memory": return kind === "tiny" || kind === "chat";
    default: return kind === "chat";
  }
}

function ChainSummary({ value, absent }: { value: unknown; absent: string }) {
  if (value === undefined) return <p>{absent}</p>;
  if (!isChain(value)) return <p>Unsupported chain value</p>;
  if (!value.length) return <p>Disabled <code>([])</code></p>;
  return <ol className="list-decimal space-y-0.5 pl-5 font-mono text-foreground">{value.map((selector, index) => <li key={index} className="break-all">{selector || '(empty selector)'}</li>)}</ol>;
}

function PrimarySummary({ value, absent }: { value: unknown; absent: string }) {
  if (value === undefined) return <p>{absent}</p>;
  if (typeof value !== "string") return <p>Unsupported primary selector value</p>;
  return <p className="break-all font-mono text-foreground">{value || '(empty selector)'}</p>;
}

interface RoleEditorProps {
  target: EditorTarget;
  models: readonly Model[];
  roleNames: readonly string[];
  ruleNames: readonly string[];
  primary: NativeRecord | undefined;
  chains: NativeRecord | undefined;
  busy: boolean;
  stale?: boolean;
  onSave: (changes: Record<string, unknown>) => Promise<boolean>;
  onClose: (savedKey?: string) => void;
}

function RoleEditor({ target, models, roleNames, ruleNames, primary, chains, busy, stale, onSave, onClose }: RoleEditorProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    formRef.current?.querySelector<HTMLElement>("fieldset input, fieldset select")?.focus();
  }, []);
  const isRole = target.kind === "role";
  const [name, setName] = useState(target.key ?? "");
  const key = target.key ?? name.trim();
  const oldPrimary = isRole ? item(primary, key) : undefined;
  const oldChain = item(chains, key);
  const canEditPrimary = isRole && primary !== undefined && (oldPrimary === undefined || typeof oldPrimary === "string");
  const canEditChain = chains !== undefined && (oldChain === undefined || isChain(oldChain));
  const [selector, setSelector] = useState<string | undefined>(() => typeof oldPrimary === "string" ? oldPrimary : undefined);
  const [choices, setChoices] = useState<Choice[] | undefined>(() => isChain(oldChain) ? oldChain.map((value, index) => ({ id: index, value })) : undefined);
  const nextChoice = useRef(choices?.length ?? 0);
  const modelOptions = useMemo(() => {
    const options = new Map<string, Model>();
    for (const model of models) {
      if (acceptsRole(isRole ? target.key ?? "default" : undefined, model)) options.set(model.selector ?? `${model.provider}/${model.id}`, model);
    }
    return [...options].sort(([a, first], [b, second]) => Number(first.available === false) - Number(second.available === false) || a.localeCompare(b));
  }, [models, isRole, target.key]);
  const wildcards = useMemo(() => [...new Set(models.map((model) => `${model.provider}/*`))].sort(), [models]);
  const existing = isRole ? roleNames : ruleNames;
  const nameIssue = target.key !== undefined || !key ? undefined : existing.includes(key)
    ? "This name already exists. Edit its existing entry."
    : isRole
      ? /[\s/,]|^[@*]/.test(key) ? "Enter a role name without spaces, slashes, commas, or a leading @ or *." : undefined
      : !/^[^/\s]+\/.+$/.test(key) ? "Enter a model or wildcard rule, such as provider/model, provider/*, or provider/prefix/*." : undefined;
  const chainValue = choices?.map(({ value }) => value);
  const primaryChanged = canEditPrimary && selector !== oldPrimary;
  const chainChanged = canEditChain && !sameChain(oldChain, chainValue);
  const invalidPrimary = primaryChanged && selector !== undefined && !selector.trim();
  const invalidChain = chainChanged && choices?.some(({ id: choiceId, value }) =>
    !value.trim() && (!isChain(oldChain) || oldChain[choiceId] !== value));
  const dirty = primaryChanged || chainChanged;
  const chainMode = choices === undefined ? "inherit" : choices.length ? "ordered" : "disabled";
  const canSave = !busy && !stale && !nameIssue && !!key && dirty && !invalidPrimary && !invalidChain;
  const editorTitle = target.key !== undefined ? `Edit ${target.key}` : isRole ? "Add role" : "Add model or provider rule";

  function appendChoice() {
    const choice = { id: nextChoice.current++, value: "" };
    setChoices((previous) => [...previous ?? [], choice]);
  }

  function moveChoice(index: number, offset: number) {
    if (!choices) return;
    const updated = choices.slice();
    [updated[index], updated[index + offset]] = [updated[index + offset], updated[index]];
    setChoices(updated);
  }

  async function save() {
    if (!canSave) return;
    const changes: Record<string, unknown> = {};
    if (primaryChanged && primary) changes[PRIMARY] = changeItem(primary, key, selector);
    if (chainChanged && chains) changes[FALLBACKS] = changeItem(chains, key, chainValue);
    if (await onSave(changes)) onClose(key);
  }

  return <form ref={formRef} aria-labelledby={`${id}-title`} className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
  }}>
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3">
        <h2 id={`${id}-title`} className="min-w-0 truncate text-sm font-medium" title={editorTitle}>{editorTitle}</h2>
        <span className="shrink-0 text-xs text-muted-foreground">Global</span>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Role editor fields">
        <div className="p-3">
          <fieldset disabled={busy || stale} className="min-w-0 space-y-3 text-xs">
            {target.key === undefined && <div className="space-y-1">
              <label htmlFor={`${id}-key`} className="font-medium">{isRole ? "Role name" : "Model or provider rule"}</label>
              <Input id={`${id}-key`} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={!!nameIssue} aria-describedby={nameIssue ? `${id}-name-issue` : undefined} list={!isRole ? `${id}-rule-options` : undefined} placeholder={isRole ? "e.g. review" : "e.g. provider/model or provider/*"} className={editorInputClass} />
              {nameIssue && <p id={`${id}-name-issue`} className="text-xs text-destructive">{nameIssue}</p>}
            </div>}
            {isRole && (canEditPrimary ? <div className="space-y-1.5">
              <label htmlFor={`${id}-primary-mode`} className="block font-medium">Primary model</label>
              <div className="flex flex-wrap items-center gap-2">
                <select id={`${id}-primary-mode`} className={selectClass} value={selector === undefined ? "inherit" : "set"} onChange={(event) => setSelector(event.target.value === "inherit" ? undefined : typeof oldPrimary === "string" ? oldPrimary : "")}>
                  <option value="inherit">Inherit (no global entry)</option>
                  <option value="set">Set selector</option>
                </select>
                {selector !== undefined && <Input aria-label="Primary model selector" aria-describedby={`${id}-selector-help`} aria-invalid={invalidPrimary} list={`${id}-models`} value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="provider/model or @role" className={cn(editorInputClass, "flex-1 basis-52")} />}
              </div>
            </div> : <p className="text-xs text-muted-foreground">This native global primary value is unavailable or is not a selector string.</p>)}
            {canEditChain ? <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <label htmlFor={`${id}-chain-mode`} className="font-medium">Fallback chain</label>
                <select id={`${id}-chain-mode`} className={selectClass} value={chainMode} onChange={(event) => {
                  if (event.target.value === "inherit") setChoices(undefined);
                  else if (event.target.value === "disabled") setChoices([]);
                  else appendChoice();
                }}>
                  <option value="inherit">Inherit (no global entry)</option>
                  <option value="disabled">Disable this chain ([])</option>
                  <option value="ordered">Use an ordered list</option>
                </select>
              </div>
              {!!choices?.length && <ol className="divide-y rounded-md border">{choices.map((choice, index) => {
                const effort = choice.value.match(effortSuffix)?.[1];
                const showEffort = !isRole || !kindRoles.includes(key);
                const base = showEffort ? choice.value.replace(effortSuffix, "") : choice.value;
                const update = (value: string) => setChoices(choices.map((entry) => entry.id === choice.id ? { ...entry, value } : entry));
                return <li key={choice.id} className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
                  <Input aria-label={`Fallback ${index + 1} selector`} aria-describedby={`${id}-selector-help`} aria-invalid={invalidChain && !base.trim()} list={`${id}-fallback-options`} value={base}
                    onChange={(event) => {
                      const value = event.target.value;
                      update(showEffort && effort && value.trim() && !effortSuffix.test(value) ? `${value}:${effort}` : value);
                    }} placeholder={`${index + 1}. provider/model`} className={cn(editorInputClass, "flex-1 basis-40")} />
                  {showEffort && <select aria-label={`Fallback ${index + 1} thinking level`} className={selectClass} disabled={!base.trim()} value={effort ?? ""}
                    onChange={(event) => update(event.target.value ? `${base}:${event.target.value}` : base)}>
                    <option value="">Inherit thinking</option>
                    {fallbackEfforts.map((level) => <option key={level} value={level}>{level}</option>)}
                  </select>}
                  <div className="ml-auto flex shrink-0 gap-0.5">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move fallback ${index + 1} up`} disabled={index === 0} onClick={() => moveChoice(index, -1)}><ArrowUp aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move fallback ${index + 1} down`} disabled={index === choices.length - 1} onClick={() => moveChoice(index, 1)}><ArrowDown aria-hidden="true" /></Button>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove fallback ${index + 1}`} onClick={() => setChoices(choices.filter((entry) => entry.id !== choice.id))}><X aria-hidden="true" /></Button>
                  </div>
                </li>;
              })}</ol>}
              {chainMode === "ordered" && <Button type="button" size="sm" variant="outline" onClick={appendChoice}><Plus aria-hidden="true" /> Add fallback</Button>}
            </div> : <p className="text-xs text-muted-foreground">This native global fallback value is unavailable or is not a list of selector strings.</p>}
            {invalidPrimary && <p className="text-xs text-destructive">Enter a primary selector or choose Inherit.</p>}
            {invalidChain && <p className="text-xs text-destructive">Enter a selector for each fallback or remove the empty row.</p>}
            <details id={`${id}-selector-help`} className="text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer font-medium">Selector syntax</summary>
              <p className="mt-1">Use a catalog suggestion, <code>provider/model</code>, or <code>@role</code>. {isRole && "Primary models can be a comma-separated list. "}Chat selectors accept thinking suffixes like <code>:high</code>. A fallback of <code>provider/*</code> keeps the model ID and changes providers.</p>
            </details>
          </fieldset>
        </div>
      </div>
        {canEditPrimary && selector !== undefined && <datalist id={`${id}-models`}>{modelOptions.map(([value, model]) => <option key={value} value={value} label={model.available === false ? `${model.name ?? value} (not available here)` : model.name} />)}</datalist>}
        {!!choices?.length && <datalist id={`${id}-fallback-options`}>{modelOptions.map(([value, model]) => <option key={value} value={value} label={model.available === false ? `${model.name ?? value} (not available here)` : model.name} />)}{wildcards.map((value) => <option key={value} value={value} label="Same model ID on this provider" />)}</datalist>}
        {target.key === undefined && !isRole && <datalist id={`${id}-rule-options`}>{modelOptions.map(([value]) => <option key={value} value={value} />)}{wildcards.map((value) => <option key={value} value={value} />)}</datalist>}
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t px-3 py-2">
        <Button type="button" variant="ghost" size="sm" className="text-xs" onClick={() => onClose()} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" className="text-xs" disabled={!canSave}>Save globally</Button>
      </footer>
    </form>;
}

export function ModelRolesPanel({ entries, models, roles, busy, stale, onReload, onSave }: {
  entries: Record<string, NativeSetting>;
  models: readonly Model[];
  roles: Record<string, string>;
  busy: boolean;
  stale?: boolean;
  onReload: () => void;
  onSave: (changes: Record<string, unknown>) => Promise<boolean>;
}) {
  const title = useId();
  const [selection, setSelection] = useState<Required<EditorTarget>>({ kind: "role", key: "default" });
  const [showDetail, setShowDetail] = useState(false);
  const [editing, setEditing] = useState<EditorTarget>();
  const listHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const nextFocus = useRef<"list" | "detail" | undefined>(undefined);
  useLayoutEffect(() => {
    if (!nextFocus.current) return;
    (nextFocus.current === "list" ? listHeading : detailHeading).current?.focus();
    nextFocus.current = undefined;
  }, [selection, showDetail, editing]);
  const globalPrimary = storedRecord(entries[PRIMARY]);
  const globalChains = storedRecord(entries[FALLBACKS]);
  // Prefer the fresh native settings reply over the catalog's independently cached roles.
  const workspacePrimary = entries[PRIMARY] && !entries[PRIMARY].redacted ? readRecord(entries[PRIMARY].value) : roles;
  const workspaceChains = entries[FALLBACKS] && !entries[FALLBACKS].redacted ? readRecord(entries[FALLBACKS].value) : undefined;
  const chainKeys = new Set([...Object.keys(workspaceChains ?? {}), ...Object.keys(globalChains ?? {})]);
  const ruleNames = [...chainKeys].filter((key) => key.includes("/"));
  const workspaceRuleNames = ruleNames.filter((key) => isChain(item(workspaceChains, key)));
  const customRoles = [...new Set([
    ...Object.keys(workspacePrimary ?? {}), ...Object.keys(globalPrimary ?? {}), ...[...chainKeys].filter((key) => !key.includes("/")),
  ])].filter((key) => !chatRoles.includes(key) && !kindRoles.includes(key)).sort();
  const roleNames = [...chatRoles, ...kindRoles, ...customRoles];
  const selected = (selection.kind === "role" ? roleNames : ruleNames).includes(selection.key)
    ? selection : { kind: "role", key: "default" };
  const { key } = selected;
  const roleSelected = selected.kind === "role";
  const primary = item(workspacePrimary, key);
  const chain = item(workspaceChains, key);
  const storedPrimary = item(globalPrimary, key);
  const storedChain = item(globalChains, key);
  const override = roleSelected && !kindRoles.includes(key) ? matchingModelRule(primary, workspaceRuleNames) : undefined;
  const primaryAbsent = workspacePrimary ? "No configured primary" : "Workspace setting unavailable";
  const chainAbsent = !workspaceChains ? "Workspace setting unavailable" :
    roleSelected && key !== "default" && !kindRoles.includes(key) && isChain(item(workspaceChains, "default"))
      ? "No role entry; may use the default chain" : "Inherit (no configured entry)";
  const canEdit = !busy && !stale && !editing;

  function openEditor(target: EditorTarget) {
    setEditing(target);
    setShowDetail(true);
  }

  function closeEditor(savedKey?: string) {
    if (savedKey !== undefined && editing) setSelection({ kind: editing.kind, key: savedKey });
    if (savedKey === undefined && editing?.key === undefined) {
      setShowDetail(false);
      nextFocus.current = "list";
    } else {
      nextFocus.current = "detail";
    }
    setEditing(undefined);
  }

  function entryButton(kind: "role" | "rule", name: string) {
    const current = selected.kind === kind && key === name;
    return <button key={name} type="button" aria-current={current || undefined} title={name} disabled={Boolean(editing)}
      className={cn("block min-h-8 w-full truncate rounded-md px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        current ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground enabled:hover:bg-sidebar-accent/70 enabled:hover:text-foreground",
        kind === "rule" && "font-mono")}
      onClick={() => {
        setSelection({ kind, key: name });
        nextFocus.current = "detail";
        setShowDetail(true);
      }}>{name}</button>;
  }

  return <section aria-labelledby={title} className="flex min-h-0 min-w-0 flex-1 overflow-hidden md:grid md:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]">
    <aside aria-label="Roles and fallback rules" className={cn("min-h-0 min-w-0 w-full flex-col bg-sidebar/40 md:flex md:border-r", showDetail ? "hidden" : "flex")}>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2 id={title} ref={listHeading} tabIndex={-1} className="text-xs font-medium">Roles & fallbacks</h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Reload settings" title="Reload settings" disabled={busy || Boolean(editing)} onClick={onReload}><RefreshCw aria-hidden="true" className="size-3.5" /></Button>
      </header>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-2 py-2">
        <section aria-label="Model roles">
          <div className="flex items-center justify-between gap-2 px-2">
            <h3 className="text-[11px] font-medium text-muted-foreground">Roles</h3>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Add role" title="Add role" disabled={!canEdit || (!globalPrimary && !globalChains)} onClick={() => openEditor({ kind: "role" })}><Plus aria-hidden="true" /></Button>
          </div>
          {roleNames.map((name) => entryButton("role", name))}
        </section>
        <section aria-label="Model and provider rules" className="border-t pt-2">
          <div className="flex items-center justify-between gap-2 px-2">
            <h3 className="text-[11px] font-medium text-muted-foreground">Model / provider rules</h3>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Add rule" title="Add rule" disabled={!canEdit || !globalChains} onClick={() => openEditor({ kind: "rule" })}><Plus aria-hidden="true" /></Button>
          </div>
          {ruleNames.length ? ruleNames.map((name) => entryButton("rule", name)) : <p className="px-2 text-xs text-muted-foreground">{workspaceChains ? "No rules configured" : "Workspace rules unavailable"}</p>}
        </section>
      </div>
    </aside>
    <div className={cn("min-h-0 min-w-0 w-full flex-col md:flex", showDetail ? "flex" : "hidden")}>
      {editing ? <RoleEditor target={editing} models={models} roleNames={roleNames} ruleNames={ruleNames} primary={globalPrimary} chains={globalChains} busy={busy} stale={stale} onSave={onSave} onClose={closeEditor} /> : <>
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3">
          <Button type="button" variant="ghost" size="icon-sm" className="md:hidden" aria-label="Back to role list" onClick={() => { nextFocus.current = "list"; setShowDetail(false); }}><ArrowLeft aria-hidden="true" /></Button>
          <h2 ref={detailHeading} tabIndex={-1} className="min-w-0 flex-1 truncate text-sm font-medium" title={key}>{key}</h2>
          <Button type="button" variant="outline" size="sm" className="shrink-0 text-xs" disabled={!canEdit || (roleSelected ? !globalPrimary && !globalChains : !globalChains)} onClick={() => openEditor({ kind: roleSelected ? "role" : "rule", key })}><Pencil aria-hidden="true" /> Edit globally</Button>
        </header>
        <div key={`${selected.kind}:${key}`} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Role details">
          <div className="max-w-4xl space-y-3 p-3 text-xs">
            <p className="text-muted-foreground">Values resolved for this workspace. Project and environment settings can override global edits.</p>
            <dl className="grid gap-3 rounded-md border bg-card px-3 py-2.5 sm:grid-cols-2">
              {roleSelected && <div className="min-w-0 text-muted-foreground">
                <dt className="mb-0.5 font-medium">Primary model</dt><dd><PrimarySummary value={primary} absent={primaryAbsent} /></dd>
                {globalPrimary && primary !== storedPrimary && <><dt className="mt-2 font-medium">Global primary</dt><dd><PrimarySummary value={storedPrimary} absent="Inherit (no global entry)" /></dd></>}
              </div>}
              <div className="min-w-0 text-muted-foreground">
                <dt className="mb-0.5 font-medium">{roleSelected ? "Role fallback chain" : "Workspace fallback chain"}</dt><dd><ChainSummary value={chain} absent={chainAbsent} /></dd>
                {globalChains && !sameChain(storedChain, chain) && <><dt className="mt-2 font-medium">Global fallback chain</dt><dd><ChainSummary value={storedChain} absent="Inherit (no global entry)" /></dd></>}
              </div>
            </dl>
            {override && <div className="rounded-md border bg-muted/40 px-3 py-2">
              <p className="mb-1 font-medium">Fallback override: <code className="break-all">{override}</code></p>
              <ChainSummary value={item(workspaceChains, override)} absent="No configured entry" />
            </div>}
            <details className="text-muted-foreground">
              <summary className="w-fit cursor-pointer font-medium">Fallback precedence</summary>
              <p className="mt-1">An exact model rule wins, then the most specific provider wildcard, then the role or default chain. Aliases and patterns can resolve differently at runtime. An empty rule disables its chain.</p>
            </details>
          </div>
        </div>
      </>}
    </div>
  </section>;
}
