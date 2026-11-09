export interface NativeSettingValue {
  value?: unknown;
  redacted?: boolean;
}

export interface NativeSetting extends NativeSettingValue {
  type: string;
  description: string;
  group: string;
  choices?: string[];
  stored?: NativeSettingValue;
}

export interface NativeSettingsCatalog {
  entries: Record<string, NativeSetting>;
}

export interface NativeSettingWriteResult {
  overriddenBy?: string;
  fallbackEnv?: string;
}

export interface NativeSettingDraft {
  mode: "inherit" | "value";
  text: string;
}

// The CLI marks configured credentials as redacted, not unset credentials. Keep
// credential-shaped keys masked even before their first value is configured.
export function isSecretSetting(key: string, entry: NativeSetting): boolean {
  return !!(entry.redacted || entry.stored?.redacted || ((entry.type === "string" || entry.type === "record") && /(?:token|password|secret|credentials|apiKey)$/i.test(key)));
}

export function settingText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

export function initialSettingDraft(key: string, entry: NativeSetting): NativeSettingDraft {
  return {
    mode: entry.stored === undefined ? "inherit" : "value",
    text: isSecretSetting(key, entry) ? "" : settingText(entry.stored?.value),
  };
}

export function isSettingDirty(key: string, entry: NativeSetting, draft: NativeSettingDraft): boolean {
  if (draft.mode === "inherit") return entry.stored !== undefined;
  if (isSecretSetting(key, entry)) return draft.text.length > 0;
  return entry.stored === undefined || draft.text !== settingText(entry.stored.value);
}

export function validateSettingDraft(entry: NativeSetting, text: string): string | undefined {
  if (entry.type === "array" || entry.type === "record") {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return "Enter valid JSON.";
    }
    if (entry.type === "array" && !Array.isArray(value)) return "Enter a JSON array.";
    if (entry.type === "record" && (!value || typeof value !== "object" || Array.isArray(value))) return "Enter a JSON object.";
  }
  if (entry.type === "number" && (!text.trim() || !Number.isFinite(Number(text)))) {
    return "Enter a finite number, or Reset to remove the global override.";
  }
  if (entry.type === "boolean" && text !== "true" && text !== "false") return "Choose true or false.";
  if (entry.choices?.length && !entry.choices.includes(text)) return "Choose one of the native values.";
  return undefined;
}

export function effectiveSettingSummary(key: string, entry: NativeSetting): string {
  if (isSecretSetting(key, entry)) return entry.redacted ? "Configured (hidden)" : "Not configured";
  if (entry.value === undefined) return "Not set";
  if (entry.value === "") return '"" (empty string)';
  return settingText(entry.value);
}
