import { useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@/lib/diagnostics";
import { invalidateCatalog } from "@/lib/omp/model-catalog";
import { settingText, validateSettingDraft, type NativeSettingsCatalog, type NativeSettingWriteResult } from "@/lib/omp/native-settings";
import type { StartOptions } from "@/lib/omp/types";

interface SettingsState {
  entries?: NativeSettingsCatalog["entries"];
  error?: string;
  notice?: string;
  stale?: boolean;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useModelSettings(options: StartOptions | undefined) {
  const [state, setState] = useState<SettingsState>({});
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const scope = useRef(0);
  const saving = useRef(false);
  useLayoutEffect(() => {
    const ticket = ++scope.current;
    setState({});
    setBusy(false);
    saving.current = false;
    if (!options) return;
    void invoke<NativeSettingsCatalog>("native_settings", { options }).then(({ entries }) => {
      if (ticket === scope.current) setState({ entries });
    }, (error: unknown) => {
      if (ticket === scope.current) setState({ error: errorText(error) });
    });
    return () => { ++scope.current; };
  }, [options, revision]);

  async function save(changes: Record<string, unknown>): Promise<boolean> {
    if (!options || !state.entries || state.stale || saving.current) return false;
    const entries = state.entries;
    const writes: { key: string; value: string | null; reset: boolean }[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const entry = Object.hasOwn(entries, key) ? entries[key] : undefined;
      if (!entry) {
        setState((previous) => ({ ...previous, error: `${key} is unavailable in this omp version.` }));
        return false;
      }
      const reset = value === undefined;
      const text = settingText(value);
      if ((reset && !entry.stored) || (!reset && entry.stored && text === settingText(entry.stored.value))) continue;
      const error = reset ? undefined : validateSettingDraft(entry, text);
      if (error) {
        setState((previous) => ({ ...previous, error: `${key}: ${error}` }));
        return false;
      }
      writes.push({ key, value: reset ? null : JSON.stringify(value), reset });
    }
    if (!writes.length) return true;
    saving.current = true;
    setBusy(true);
    setState({ entries });
    const ticket = scope.current;
    let saved = 0;
    let failure: string | undefined;
    let refreshed: NativeSettingsCatalog | undefined;
    const overrides = new Set<string>();
    try {
      for (const change of writes) {
        if (ticket !== scope.current) return false;
        try {
          const result = await invoke<NativeSettingWriteResult>("native_setting_write", { options, ...change });
          if (result.overriddenBy) overrides.add(result.overriddenBy);
          if (result.fallbackEnv) overrides.add(result.fallbackEnv);
          saved++;
        } catch (error) {
          failure = `${change.key}: ${errorText(error)}`;
          break;
        }
      }
      if (ticket !== scope.current) return false;
      try {
        refreshed = await invoke<NativeSettingsCatalog>("native_settings", { options });
      } catch (error) {
        failure = [failure, `Could not reload settings: ${errorText(error)}`].filter(Boolean).join(" ");
      }
      if (ticket !== scope.current) return false;
      const notice = saved === 0 ? undefined : [
        saved === writes.length ? "Saved globally. Restart the agent to ensure changes are applied." : `Saved ${saved} of ${writes.length} changes. Restart the agent to ensure saved changes are applied.`,
        overrides.size ? `Higher priority configuration: ${[...overrides].join(", ")}.` : "",
      ].filter(Boolean).join(" ");
      setState({ entries: refreshed?.entries ?? entries, error: failure, notice, stale: !refreshed });
      return saved === writes.length && Boolean(refreshed);
    } finally {
      if (saved) invalidateCatalog();
      if (ticket === scope.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }

  return { ...state, busy, save, reload: () => setRevision((value) => value + 1) };
}
