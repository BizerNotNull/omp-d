import { invoke } from "@/lib/diagnostics";
import type { Model } from "./types";

interface CatalogPreferences {
  binary: string;
  extraArgs: string;
}

interface CachedCatalog {
  models?: Model[];
  modelRoles: Record<string, string>;
  modelsUpdatedAt: number;
  rolesUpdatedAt: number;
}

export interface CatalogSnapshot extends CachedCatalog {
  modelsLoading: boolean;
  rolesLoading: boolean;
  modelsError?: string;
  rolesError?: string;
}

interface CatalogOptions {
  cwd: string;
  binary: string;
  extraArgs: string[];
}

interface CatalogEntry {
  snapshot: CatalogSnapshot;
  listeners: Set<(snapshot: CatalogSnapshot) => void>;
  revision: number;
  options?: CatalogOptions;
  modelsRequest?: { revision: number; promise: Promise<void> };
  rolesRequest?: { revision: number; promise: Promise<void> };
}

const FRESH_MS = 5 * 60 * 1000;
const entries = new Map<string, CatalogEntry>();

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

// Preserve quoted paths and Windows backslashes in the preferences argument field.
export function splitExtraArgs(input: string): string[] {
  const args: string[] = [];
  let value = "";
  let quote = "";
  for (const char of input) {
    if (char === quote) {
      quote = "";
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && /\s/.test(char)) {
      if (value) args.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  if (value) args.push(value);
  return args;
}

export function catalogCacheKey(cwd: string, preferences: CatalogPreferences): string {
  const relevant: string[] = [];
  const args = splitExtraArgs(preferences.extraArgs);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index].split("=", 1)[0];
    if (["--profile", "--config", "--extension", "-e", "--hook"].includes(flag)) {
      relevant.push(flag === "-e" || flag === "--hook" ? "--extension" : flag);
      if (args[index].includes("=")) relevant.push(args[index].slice(args[index].indexOf("=") + 1));
      else if (args[index + 1]) relevant.push(args[++index]);
    } else if (flag === "--no-extensions") {
      relevant.push(args[index]);
    }
  }
  return `ompd:catalog:v2:${JSON.stringify([normalizePath(cwd), normalizePath(preferences.binary.trim() || "omp"), relevant])}`;
}

function readCatalog(key: string): CachedCatalog {
  const empty = { models: undefined, modelRoles: {}, modelsUpdatedAt: 0, rolesUpdatedAt: 0 };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!raw || typeof raw !== "object") return empty;
    const cached = raw as CachedCatalog;
    const models = Array.isArray(cached.models) && cached.models.every(model => model && typeof model.provider === "string" && typeof model.id === "string") ? cached.models : undefined;
    const modelRoles = cached.modelRoles && typeof cached.modelRoles === "object" && !Array.isArray(cached.modelRoles)
      ? Object.fromEntries(Object.entries(cached.modelRoles).filter(([, value]) => typeof value === "string"))
      : {};
    const timestamp = (value: number) => Number.isFinite(value) && value > 0 && value <= Date.now() ? value : 0;
    return { models, modelRoles, modelsUpdatedAt: models ? timestamp(cached.modelsUpdatedAt) : 0, rolesUpdatedAt: timestamp(cached.rolesUpdatedAt) };
  } catch {
    return empty;
  }
}

function writeCatalog(key: string, catalog: CachedCatalog): void {
  try {
    localStorage.setItem(key, JSON.stringify(catalog));
  } catch {
    // Storage may be disabled or full; the in-memory catalog remains usable.
  }
}

function entryFor(key: string): CatalogEntry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: { ...readCatalog(key), modelsLoading: false, rolesLoading: false }, revision: 0, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

export function catalogSnapshot(key: string): CatalogSnapshot {
  return entryFor(key).snapshot;
}

export function subscribeCatalog(key: string, listener: (snapshot: CatalogSnapshot) => void): () => void {
  const entry = entryFor(key);
  entry.listeners.add(listener);
  listener(entry.snapshot);
  return () => { entry.listeners.delete(listener); };
}

// Global settings writes invalidate every context; provider login targets one.
export function invalidateCatalog(key?: string): void {
  for (const [entryKey, entry] of entries) {
    if (key !== undefined && key !== entryKey) continue;
    ++entry.revision;
    entry.snapshot = { ...entry.snapshot, modelsUpdatedAt: 0, rolesUpdatedAt: 0 };
    const { models, modelRoles, modelsUpdatedAt, rolesUpdatedAt } = entry.snapshot;
    writeCatalog(entryKey, { models, modelRoles, modelsUpdatedAt, rolesUpdatedAt });
    for (const listener of entry.listeners) listener(entry.snapshot);
    if (entry.options && entry.listeners.size) void fetchCatalog(entryKey, entry.options);
  }
  // Unopened contexts may still have a persistent snapshot from an earlier run.
  if (key === undefined) {
    try {
      for (let index = localStorage.length - 1; index >= 0; --index) {
        const storedKey = localStorage.key(index);
        if (storedKey?.startsWith("ompd:catalog:v2:") && !entries.has(storedKey)) localStorage.removeItem(storedKey);
      }
    } catch {
      // In-memory invalidation still works without storage access.
    }
  }
}

export async function fetchCatalog(key: string, options: CatalogOptions, force = false): Promise<void> {
  const entry = entryFor(key);
  entry.options = options;
  const publish = (patch: Partial<CatalogSnapshot>) => {
    entry.snapshot = { ...entry.snapshot, ...patch };
    for (const listener of entry.listeners) listener(entry.snapshot);
  };
  const persist = () => {
    const { models, modelRoles, modelsUpdatedAt, rolesUpdatedAt } = entry.snapshot;
    writeCatalog(key, { models, modelRoles, modelsUpdatedAt, rolesUpdatedAt });
  };
  const query = (kind: "models" | "roles"): Promise<void> => {
    const requestKey = kind === "models" ? "modelsRequest" : "rolesRequest";
    const pending = entry[requestKey];
    if (pending) return pending.revision === entry.revision ? pending.promise : pending.promise.then(() => query(kind));
    const updatedAt = kind === "models" ? entry.snapshot.modelsUpdatedAt : entry.snapshot.rolesUpdatedAt;
    if (!force && updatedAt > 0 && Date.now() - updatedAt < FRESH_MS) return Promise.resolve();
    const revision = entry.revision;
    // Defer invocation so reentrant subscribers also see the shared request.
    const request = Promise.resolve().then(async () => {
      try {
        if (kind === "models") {
          const models = await invoke<Model[]>("model_catalog", { options });
          if (revision !== entry.revision) return;
          publish({ models, modelsUpdatedAt: Date.now() });
        } else {
          const modelRoles = await invoke<Record<string, string>>("model_roles", { options });
          if (revision !== entry.revision) return;
          const overlay = options.extraArgs.some(arg => arg === "--config" || arg.startsWith("--config="));
          publish({ modelRoles, rolesUpdatedAt: Date.now(), rolesError: overlay ? "Model roles reflect project/profile settings only; the CLI does not support config overlays for role queries." : undefined });
        }
        persist();
      } catch (error) {
        if (revision !== entry.revision) return;
        const message = error instanceof Error ? error.message : String(error);
        publish(kind === "models" ? { modelsError: message } : { rolesError: message });
      } finally {
        entry[requestKey] = undefined;
        if (revision === entry.revision) publish(kind === "models" ? { modelsLoading: false } : { rolesLoading: false });
      }
    });
    entry[requestKey] = { revision, promise: request };
    publish(kind === "models" ? { modelsLoading: true, modelsError: undefined } : { rolesLoading: true, rolesError: undefined });
    return request;
  };
  await Promise.all([query("models"), query("roles")]);
}
