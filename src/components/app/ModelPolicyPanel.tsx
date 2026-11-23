import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { settingText, type NativeSetting } from "@/lib/omp/native-settings";
import type { Model } from "@/lib/omp/types";

interface ModelPolicyPanelProps {
  entries: Record<string, NativeSetting>;
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => Promise<boolean>;
  currentModel?: Model;
  currentAutoCompaction?: boolean;
}

const PERCENT = "compaction.thresholdPercent";
const TOKENS = "compaction.thresholdTokens";
const MODEL_RULES = "compaction.modelThresholds";
const RULES_ENABLED = "compaction.modelThresholdsEnabled";
const AUTO_COMPACTION = "compaction.enabled";
const CHOICES = {
  thinking: { key: "defaultThinkingLevel", label: "Default thinking level" },
  fallback: { key: "retry.modelFallback", label: "Retry with a fallback model" },
  trigger: { key: "retry.fallbackOn", label: "Fallback trigger" },
  revert: { key: "retry.fallbackRevertPolicy", label: "Return to the primary model" },
  compaction: { key: AUTO_COMPACTION, label: "Auto compaction" },
  modelRules: { key: RULES_ENABLED, label: "Apply model-specific thresholds" },
};
const choiceLabels: Record<string, string> = {
  true: "Enabled", false: "Disabled", any: "Any provider error", "usage-limit": "Usage limits only",
  "except-usage-limit": "Except usage limits", "cooldown-expiry": "After cooldown", never: "Never automatically",
};
const helpClass = "break-words text-[11px] leading-4 text-muted-foreground";
const sectionClass = "min-w-0 space-y-2.5 px-3 py-3";
const sectionTitleClass = "text-xs font-medium";
const inputClass = "text-xs md:text-xs";
const selectClass = "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 sm:max-w-xs";

type ThresholdMode = "inherit" | "default" | "percent" | "fixed" | "partial";
interface ThresholdDraft {
  mode: ThresholdMode;
  percent: string;
  tokens: string;
}
interface RuleDraft {
  id: string;
  selector: string;
  threshold: string;
}
type RuleValue = number | string | null;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function choiceText(value: unknown): string {
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return typeof value === "string" ? (Object.hasOwn(choiceLabels, value) ? choiceLabels[value] : value) : "Not set";
}

function storedChoice(entry?: NativeSetting): string {
  return entry?.stored === undefined ? "inherit" : `value:${settingText(entry.stored.value)}`;
}

function PolicyChoice({ setting, entry, draft, onChange }: {
  setting: { key: string; label: string };
  entry?: NativeSetting;
  draft?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const choices = entry?.type === "boolean" ? ["true", "false"] : (entry?.choices ?? []);
  const stored = storedChoice(entry);
  return <div className="min-w-0 space-y-1">
    <Label htmlFor={id} className="text-xs">{setting.label}</Label>
    <select id={id} className={selectClass} value={draft ?? stored} disabled={!entry} aria-describedby={`${id}-details`}
      onChange={(event) => onChange(event.target.value)}>
      <option value="inherit">Inherit (no global override)</option>
      {stored !== "inherit" && !choices.includes(stored.slice(6)) && <option value={stored}>{choiceText(entry?.stored?.value)} (stored)</option>}
      {choices.map((choice) => <option value={`value:${choice}`} key={choice}>{choiceText(choice)}</option>)}
    </select>
    <div className={helpClass} id={`${id}-details`}>
      {entry ? <>
        <p>Global: {entry.stored ? choiceText(entry.stored.value) : "Inherited"} · Workspace resolved: {choiceText(entry.value)}</p>
        {entry.description && <p>{entry.description}</p>}
        {!choices.length && <p>Native choices are unavailable. You can still remove a stored global override.</p>}
      </> : <p>Not exposed by the configured runtime: <code>{setting.key}</code>.</p>}
    </div>
  </div>;
}

function storedThreshold(percent?: NativeSetting, tokens?: NativeSetting): ThresholdDraft {
  const p = percent?.stored?.value;
  const t = tokens?.stored?.value;
  const hasPercent = typeof p === "number" && p > 0;
  const hasTokens = typeof t === "number" && t > 0;
  return {
    mode: hasTokens ? "fixed" : hasPercent ? "percent" : percent?.stored && tokens?.stored ? "default" : percent?.stored || tokens?.stored ? "partial" : "inherit",
    percent: hasPercent ? String(p) : "",
    tokens: hasTokens ? String(t) : "",
  };
}

function thresholdText(p: unknown, t: unknown): string {
  if (typeof t === "number" && t > 0) {
    const fallback = typeof p === "number" && p > 0 ? `; ${p}% still applies to model token bases` : "";
    return `Fixed at ${t.toLocaleString()} tokens${fallback}`;
  }
  if (typeof p === "number" && p > 0) return `${p}% of the context window`;
  return "Default (context window minus reserve)";
}

function thresholdField(entry: NativeSetting | undefined, global: boolean, unit: string): string {
  if (!entry) return "Unavailable";
  const value = global ? entry.stored?.value : entry.value;
  if (value === undefined) return global ? "Inherited" : "Not set";
  return typeof value === "number" && value > 0 ? `${value.toLocaleString()}${unit}` : "Default";
}

function describeRule(value: unknown): string {
  if (value === null) return "Clears a lower-priority entry for this selector";
  if (typeof value === "number") return `${value.toLocaleString()}-token base`;
  if (typeof value === "string" && /^f\d+$/i.test(value.trim())) return `Fixed at ${Number(value.trim().slice(1)).toLocaleString()} tokens`;
  if (typeof value === "string" && value.trim().endsWith("%")) return `${value.trim()} of the context window`;
  return settingText(value);
}

function matchRule(rules: Record<string, unknown>, selector: string) {
  if (Object.hasOwn(rules, selector) && rules[selector] != null) return selector;
  let match: string | undefined;
  for (const [key, value] of Object.entries(rules)) {
    if (value != null && key.endsWith("*") && selector.startsWith(key.slice(0, -1)) && (!match || key.length > match.length)) match = key;
  }
  return match;
}

function parseRule(value: string): RuleValue | undefined {
  const text = value.trim();
  if (text === "null") return null;
  if (/^f?\d+$/i.test(text)) {
    const fixed = text[0]?.toLowerCase() === "f";
    const tokens = Number(fixed ? text.slice(1) : text);
    if (Number.isSafeInteger(tokens) && tokens > 0) return fixed ? text : tokens;
  }
  if (/^\d+(?:\.\d+)?%$/.test(text)) {
    const percent = Number(text.slice(0, -1));
    if (percent > 0 && percent <= 100) return text;
  }
  return undefined;
}

function validateRules(rows: RuleDraft[]) {
  const counts = new Map<string, number>();
  for (const { selector } of rows) {
    const key = selector.trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const values: [string, RuleValue][] = [];
  const errors = new Map<string, { selector?: string; threshold?: string }>();
  for (const row of rows) {
    const key = row.selector.trim();
    const slash = key.indexOf("/");
    const star = key.indexOf("*");
    const value = parseRule(row.threshold);
    const error: { selector?: string; threshold?: string } = {};
    if (slash <= 0 || slash === key.length - 1 || /\s/.test(key) || (star !== -1 && star !== key.length - 1)) {
      error.selector = "Use provider/model-id or a prefix ending in *, such as provider/family*.";
    } else if ((counts.get(key) ?? 0) > 1) {
      error.selector = "This selector already has a global rule.";
    }
    if (value === undefined) error.threshold = "Use a positive whole token count, f90000, a percentage above 0 and at most 100%, or null.";
    if (error.selector || error.threshold) errors.set(row.id, error);
    if (!error.selector && value !== undefined) values.push([key, value]);
  }
  return { values, errors };
}

export function ModelPolicyPanel({ entries, busy, onSave, currentModel, currentAutoCompaction }: ModelPolicyPanelProps) {
  const id = useId();
  const nextRule = useRef(0);
  const [choiceDrafts, setChoiceDrafts] = useState<Record<string, string>>({});
  const [thresholdDraft, setThresholdDraft] = useState<ThresholdDraft>();
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraft[]>();
  const [saving, setSaving] = useState(false);
  const disabled = busy || saving;

  const percent = entries[PERCENT];
  const tokens = entries[TOKENS];
  const thresholdsAvailable = !!percent && !!tokens;
  const threshold = thresholdDraft ?? storedThreshold(percent, tokens);
  const modelRules = entries[MODEL_RULES];
  const globalRules = asRecord(modelRules?.stored?.value);
  const workspaceRules = asRecord(modelRules?.value);
  const workspaceEntries = Object.entries(workspaceRules);
  const rows = ruleDrafts ?? Object.entries(globalRules).map(([key, value]) => ({ id: `stored:${key}`, selector: key, threshold: settingText(value) }));
  const { values: ruleValues, errors: ruleErrors } = ruleDrafts ? validateRules(rows) : { values: [], errors: new Map<string, { selector?: string; threshold?: string }>() };
  const modelSelector = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
  const globalMatch = modelSelector && matchRule(globalRules, modelSelector);
  const workspaceMatch = modelSelector && matchRule(workspaceRules, modelSelector);

  const changes: Record<string, unknown> = {};
  function stage(key: string, value: unknown) {
    const entry = entries[key];
    if (entry && (value === undefined ? entry.stored !== undefined : !Object.is(entry.stored?.value, value))) changes[key] = value;
  }
  for (const { key } of Object.values(CHOICES)) {
    const entry = entries[key];
    const draft = choiceDrafts[key];
    if (!entry || draft === undefined || draft === storedChoice(entry)) continue;
    const value = draft.slice(6);
    if (draft === "inherit") stage(key, undefined);
    else if (entry.type === "boolean") stage(key, value === "true");
    else if (entry.choices?.includes(value)) stage(key, value);
  }
  let thresholdError: string | undefined;
  if (thresholdDraft && (thresholdsAvailable || threshold.mode === "inherit")) {
    if (threshold.mode === "inherit" || threshold.mode === "default") {
      const value = threshold.mode === "default" ? -1 : undefined;
      stage(TOKENS, value);
      stage(PERCENT, value);
    } else if (threshold.mode === "percent") {
      const value = Number(threshold.percent);
      if (!(value > 0 && value <= 100)) thresholdError = "Enter a percentage above 0 and at most 100.";
      else {
        stage(PERCENT, value);
        stage(TOKENS, -1);
      }
    } else if (threshold.mode === "fixed") {
      const value = Number(threshold.tokens);
      if (!Number.isSafeInteger(value) || value <= 0) thresholdError = "Enter a positive whole number of tokens.";
      else stage(TOKENS, value);
    }
  }
  if (modelRules && ruleDrafts && !ruleErrors.size) {
    if (!ruleValues.length) stage(MODEL_RULES, undefined);
    else if (ruleValues.length !== Object.keys(globalRules).length || ruleValues.some(([key, value]) => !Object.hasOwn(globalRules, key) || !Object.is(globalRules[key], value))) {
      stage(MODEL_RULES, Object.fromEntries(ruleValues));
    }
  }
  const changeCount = Object.keys(changes).length;

  async function save() {
    if (disabled || !changeCount || thresholdError || ruleErrors.size) return;
    setSaving(true);
    try {
      if (await onSave(changes)) {
        setChoiceDrafts({});
        setThresholdDraft(undefined);
        setRuleDrafts(undefined);
      }
    } finally {
      setSaving(false);
    }
  }

  function choice(setting: { key: string; label: string }) {
    return <PolicyChoice setting={setting} entry={entries[setting.key]} draft={choiceDrafts[setting.key]}
      onChange={(value) => setChoiceDrafts((previous) => ({ ...previous, [setting.key]: value }))} />;
  }

  function updateRule(rowId: string, update: Partial<Pick<RuleDraft, "selector" | "threshold">>) {
    setRuleDrafts(rows.map((row) => row.id === rowId ? { ...row, ...update } : row));
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <fieldset disabled={disabled} aria-busy={disabled} className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
      <legend className="sr-only">Model policies</legend>
      <p className={`${helpClass} border-b px-3 py-2`}>Edits apply globally. Project and environment settings can override them. Restart the agent after saving to load the changes.</p>
      <div className="grid divide-y lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)] lg:divide-x lg:divide-y-0">
        <div className="min-w-0 divide-y">
          <section className={sectionClass} aria-labelledby={`${id}-thinking`}>
            <h3 id={`${id}-thinking`} className={sectionTitleClass}>Thinking</h3>
            {choice(CHOICES.thinking)}
          </section>

          <section className={sectionClass} aria-labelledby={`${id}-fallback`}>
            <h3 id={`${id}-fallback`} className={sectionTitleClass}>Retry &amp; fallback</h3>
            {choice(CHOICES.fallback)}
            {choice(CHOICES.trigger)}
            {choice(CHOICES.revert)}
          </section>
        </div>

        <div className="min-w-0 divide-y">
          <section className={sectionClass} aria-labelledby={`${id}-compaction`}>
            <h3 id={`${id}-compaction`} className={sectionTitleClass}>Context compaction</h3>
            {choice(CHOICES.compaction)}
            <p className={helpClass}>
              Running session · Auto compaction: <span className="font-medium text-foreground">{currentAutoCompaction === undefined ? "Not reported" : currentAutoCompaction ? "Enabled" : "Disabled"}</span>
            </p>
            <div className="min-w-0 space-y-1.5 border-t pt-2.5">
              <Label htmlFor={`${id}-mode`} className="text-xs">Global threshold policy</Label>
              <div id={`${id}-threshold-source`} className={helpClass}>
                <p>Global · Fixed tokens: {thresholdField(tokens, true, "")} · Percentage: {thresholdField(percent, true, "%")}</p>
                <p>Workspace resolved · Fixed tokens: {thresholdField(tokens, false, "")} · Percentage: {thresholdField(percent, false, "%")}</p>
                {thresholdsAvailable && <p>Workspace policy before model rules: {thresholdText(percent.value, tokens.value)}.</p>}
              </div>
              {thresholdsAvailable ? <>
                <select id={`${id}-mode`} className={selectClass} value={threshold.mode} aria-describedby={`${id}-threshold-source ${id}-threshold-help`}
                  onChange={(event) => setThresholdDraft({ ...threshold, mode: event.target.value as ThresholdMode })}>
                  <option value="inherit">Inherit (remove both global settings)</option>
                  {threshold.mode === "partial" && <option value="partial" disabled>One setting inherited (see values above)</option>}
                  <option value="default">Default (reserve-based)</option>
                  <option value="percent">Percentage of context window</option>
                  <option value="fixed">Fixed token limit</option>
                </select>
                {(threshold.mode === "percent" || threshold.mode === "fixed") && <div className="space-y-1.5">
                  <Label htmlFor={`${id}-threshold-value`} className="text-xs">{threshold.mode === "percent" ? "Context percentage (%)" : "Token limit"}</Label>
                  <Input id={`${id}-threshold-value`} className={`${inputClass} sm:max-w-44`} type="number" min={threshold.mode === "percent" ? 0 : 1}
                    max={threshold.mode === "percent" ? 100 : undefined} step={threshold.mode === "percent" ? "any" : 1}
                    value={threshold.mode === "percent" ? threshold.percent : threshold.tokens} aria-invalid={!!thresholdError}
                    aria-describedby={`${id}-threshold-help${thresholdError ? ` ${id}-threshold-error` : ""}`}
                    onChange={(event) => setThresholdDraft({ ...threshold, [threshold.mode === "percent" ? "percent" : "tokens"]: event.target.value })} />
                </div>}
                <p id={`${id}-threshold-help`} className={helpClass}>
                  {threshold.mode === "fixed" ? "Fixed tokens take precedence without removing the configured percentage; a model token base can still use that percentage."
                    : threshold.mode === "percent" ? "Percentage mode disables the global fixed limit. The runtime clamps percentages to 1–99%."
                      : threshold.mode === "default" ? "Explicitly disable the global percentage and fixed limit so the reserve policy applies."
                        : threshold.mode === "partial" ? "Only one threshold is stored globally. Choose a mode to set the policy explicitly."
                          : "Remove both global threshold settings and let other layers or runtime defaults decide."}
                </p>
                {thresholdError && <p id={`${id}-threshold-error`} className="text-xs text-destructive">{thresholdError}</p>}
              </> : <>
                <p className={helpClass}>Threshold modes require both native keys; at least one is not exposed by the configured runtime.</p>
                {(percent?.stored || tokens?.stored) && <Button type="button" size="sm" variant="outline" disabled={thresholdDraft?.mode === "inherit"}
                  onClick={() => setThresholdDraft({ ...threshold, mode: "inherit" })}>
                  {thresholdDraft?.mode === "inherit" ? "Reset staged" : "Reset available global thresholds to inherited"}
                </Button>}
              </>}
            </div>
            <p className={helpClass}>These are configured thresholds, not the actual trigger in the running session. The runtime uses the active model’s context window, reserve, and applicable overrides; it may cap a fixed limit.</p>
          </section>

          <section className={sectionClass} aria-labelledby={`${id}-rules`}>
            <h3 id={`${id}-rules`} className={sectionTitleClass}>Model-specific thresholds</h3>
            {choice(CHOICES.modelRules)}
            {modelRules ? <>
              <details className="min-w-0 text-xs">
                <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Rule syntax</summary>
                <p id={`${id}-rule-help`} className={`${helpClass} mt-1`}>An exact <code>provider/model-id</code> wins; otherwise the longest matching <code>*</code> prefix wins. <code>90000</code> is a token base scaled by the percentage or reserve policy, <code>f90000</code> is a fixed limit, and <code>80%</code> replaces the threshold policy with a percentage. <code>null</code> clears a lower-priority entry for that selector.</p>
              </details>
              {modelSelector && <div className="min-w-0 space-y-0.5 border-l pl-2 text-[11px] leading-4 [overflow-wrap:anywhere]">
                <p><span className="font-medium">Current model</span> · {modelSelector}</p>
                <p>Global rule match: {globalMatch ? <><code>{globalMatch}</code> · {describeRule(globalRules[globalMatch])}</> : "None"}</p>
                <p>Workspace-resolved rule match: {workspaceMatch ? <><code>{workspaceMatch}</code> · {describeRule(workspaceRules[workspaceMatch])}</> : "None"}
                  {entries[RULES_ENABLED]?.value === false && " (model rules disabled)"}</p>
              </div>}
              <details className="min-w-0 text-xs">
                <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Workspace-resolved rules ({workspaceEntries.length})</summary>
                {workspaceEntries.length ? <dl className="space-y-1 pb-1 [overflow-wrap:anywhere]">
                  {workspaceEntries.map(([key, value]) => <div className="flex flex-wrap gap-x-2" key={key}>
                    <dt className="min-w-0 font-mono">{key}</dt>
                    <dd className="min-w-0 text-muted-foreground">{describeRule(value)}</dd>
                  </div>)}
                </dl> : <p className={`${helpClass} pb-1`}>No rules resolved for this workspace.</p>}
              </details>
              <div className="min-w-0 space-y-2">
                <p className="text-xs font-medium">Global rules · {modelRules.stored ? `${Object.keys(globalRules).length} stored` : "Inherited"}</p>
                {rows.map((row, index) => {
                  const error = ruleErrors.get(row.id);
                  const rowId = `${id}-rule-${index}`;
                  return <div key={row.id} role="group" aria-label={`Global model rule ${index + 1}`} className="grid min-w-0 items-start gap-2 border-t py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${rowId}-selector`} className="text-xs">Model selector</Label>
                      <Input id={`${rowId}-selector`} className={inputClass} value={row.selector} placeholder="provider/model-id" spellCheck={false}
                        aria-invalid={!!error?.selector} aria-describedby={error?.selector ? `${rowId}-selector-error` : `${id}-rule-help`}
                        onChange={(event) => updateRule(row.id, { selector: event.target.value })} />
                      {error?.selector && <p className="text-xs text-destructive" id={`${rowId}-selector-error`}>{error.selector}</p>}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${rowId}-threshold`} className="text-xs">Threshold</Label>
                      <Input id={`${rowId}-threshold`} className={inputClass} value={row.threshold} placeholder="90000, f90000, 80%" spellCheck={false}
                        aria-invalid={!!error?.threshold} aria-describedby={error?.threshold ? `${rowId}-threshold-error` : `${id}-rule-help`}
                        onChange={(event) => updateRule(row.id, { threshold: event.target.value })} />
                      {error?.threshold && <p className="text-xs text-destructive" id={`${rowId}-threshold-error`}>{error.threshold}</p>}
                    </div>
                    <Button type="button" variant="ghost" size="sm" className="justify-self-start text-xs sm:mt-4" aria-label={`Remove global rule ${row.selector || index + 1}`}
                      onClick={() => setRuleDrafts(rows.filter((item) => item.id !== row.id))}>Remove</Button>
                  </div>;
                })}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="text-xs" onClick={() => {
                    const selector = modelSelector && !rows.some((row) => row.selector.trim() === modelSelector) ? modelSelector : "";
                    setRuleDrafts([...rows, { id: `new:${nextRule.current++}`, selector, threshold: "" }]);
                  }}>Add global rule</Button>
                  <Button type="button" variant="ghost" size="sm" className="text-xs" disabled={!rows.length && (!modelRules.stored || !!ruleDrafts)}
                    onClick={() => setRuleDrafts([])}>Reset global rules to inherited</Button>
                </div>
              </div>
            </> : <p className={helpClass}>The configured runtime does not expose <code>{MODEL_RULES}</code>.</p>}
          </section>
        </div>
      </div>
    </fieldset>

    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t px-3 py-2">
      <p className={helpClass}>Settings save individually. A failed write may leave some changes applied.</p>
      <Button type="button" size="sm" className="ml-auto text-xs" disabled={disabled || !changeCount || !!thresholdError || ruleErrors.size > 0} onClick={() => void save()}>
        {saving ? "Saving…" : "Save global policies"}
      </Button>
    </footer>
  </div>;
}
