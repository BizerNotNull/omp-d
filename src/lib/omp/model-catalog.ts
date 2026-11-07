import type { Model } from "./types";

interface CatalogPreferences {
  binary: string;
  extraArgs: string;
}

export interface CachedCatalog {
  models?: Model[];
  modelRoles: Record<string, string>;
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
      relevant.push(args[index]);
      if (!args[index].includes("=") && args[index + 1]) relevant.push(args[++index]);
    } else if (flag === "--no-extensions") {
      relevant.push(args[index]);
    }
  }
  return `ompd:catalog:v1:${JSON.stringify([cwd.replace(/\\/g, "/").replace(/\/$/, ""), preferences.binary.trim() || "omp", relevant])}`;
}

export function readCatalog(key: string): CachedCatalog {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!raw || typeof raw !== "object") return { models: undefined, modelRoles: {} };
    const cached = raw as CachedCatalog;
    const models = Array.isArray(cached.models) && cached.models.every(model => model && typeof model.provider === "string" && typeof model.id === "string") ? cached.models : undefined;
    const modelRoles = cached.modelRoles && typeof cached.modelRoles === "object" && !Array.isArray(cached.modelRoles)
      ? Object.fromEntries(Object.entries(cached.modelRoles).filter(([, value]) => typeof value === "string"))
      : {};
    return { models, modelRoles };
  } catch {
    return { models: undefined, modelRoles: {} };
  }
}

export function writeCatalog(key: string, catalog: CachedCatalog): void {
  try {
    localStorage.setItem(key, JSON.stringify(catalog));
  } catch {
    // Storage may be disabled or full; the in-memory catalog remains usable.
  }
}
