import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@/lib/diagnostics";
import { catalogCacheKey, splitExtraArgs } from "./model-catalog";

interface UsageAccount {
  provider: string;
  email?: string;
  accountId?: string;
  projectId?: string;
  orgName?: string;
  orgId?: string;
}

export interface QuotaLimit {
  id: string;
  label: string;
  scope: { accountId?: string; projectId?: string; tier?: string; sharedGroup?: string };
  window?: { id: string; label: string; resetsAt?: number; resetLabel?: string };
  amount: { used?: number; limit?: number; remaining?: number; usedFraction?: number; remainingFraction?: number; unit: string };
  status?: string;
  notes?: string[];
}

interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: QuotaLimit[];
  notes?: string[];
  metadata?: Omit<UsageAccount, "provider"> & { planType?: string };
}

interface UsageResponse {
  reports: UsageReport[];
  accountsWithoutUsage?: UsageAccount[] | null;
}

export interface UsagePlan {
  provider: string;
  name?: string;
  identity?: string;
  organization?: string;
  updatedAt?: number;
  limits: QuotaLimit[];
  notes?: string[];
}

function projectPlans({ reports, accountsWithoutUsage }: UsageResponse): UsagePlan[] {
  const plans = reports.map((report): UsagePlan => {
    const meta = report.metadata;
    const scope = report.limits.find(({ scope }) => scope.accountId || scope.projectId)?.scope;
    const groups = new Set<string>();
    return {
      provider: report.provider,
      name: meta?.planType,
      identity: meta?.email || meta?.accountId || meta?.projectId || scope?.accountId || scope?.projectId,
      organization: meta?.orgName || meta?.orgId,
      updatedAt: report.fetchedAt,
      notes: report.notes,
      limits: report.limits.filter(({ scope }) => {
        if (!scope.sharedGroup) return true;
        if (groups.has(scope.sharedGroup)) return false;
        groups.add(scope.sharedGroup);
        return true;
      }),
    };
  });
  for (const account of accountsWithoutUsage ?? []) {
    plans.push({
      provider: account.provider,
      identity: account.email || account.accountId || account.projectId,
      organization: account.orgName || account.orgId,
      limits: [],
    });
  }
  return plans;
}

export function remainingPercent({ amount, status }: QuotaLimit): number | undefined {
  if (status === "exhausted") return 0;
  const { remaining, remainingFraction, used, usedFraction, limit, unit } = amount;
  const value = remainingFraction !== undefined ? remainingFraction * 100
    : usedFraction !== undefined ? (1 - usedFraction) * 100
    : limit !== undefined && limit > 0 && remaining !== undefined ? remaining / limit * 100
    : limit !== undefined && limit > 0 && used !== undefined ? (1 - used / limit) * 100
    : unit === "percent" ? remaining ?? (used === undefined ? undefined : 100 - used) : undefined;
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(100, value));
}

interface UsageSnapshot {
  key: string;
  plans?: UsagePlan[];
  error?: string;
  loading: boolean;
  checkedAt?: number;
}

export interface PlanUsageState {
  snapshot: UsageSnapshot | undefined;
  refresh: (force?: boolean) => Promise<void>;
}

const FRESH_MS = 5 * 60 * 1000;

export function usePlanUsage(cwd: string | undefined, binary: string, extraArgs: string, authRevision: number, open: boolean): PlanUsageState {
  const key = cwd ? `${catalogCacheKey(cwd, { binary, extraArgs })}:${authRevision}` : undefined;
  const current = useRef<UsageSnapshot>(undefined);
  const pending = useRef<{ key: string }>(undefined);
  const [snapshot, setSnapshot] = useState<UsageSnapshot>();

  const refresh = useCallback(async (force = false) => {
    if (!key || !cwd || pending.current?.key === key) return;
    const previous = current.current?.key === key ? current.current : undefined;
    if (!force && previous?.checkedAt && Date.now() - previous.checkedAt < FRESH_MS) return;
    const request = { key };
    pending.current = request;
    const publish = (next: UsageSnapshot) => {
      current.current = next;
      setSnapshot(next);
    };
    publish({ ...previous, key, loading: true });
    try {
      const result = await invoke<UsageResponse>("plan_usage", {
        options: { cwd, binary: binary.trim() || "omp", extraArgs: splitExtraArgs(extraArgs) },
      });
      if (pending.current === request) {
        publish({ key, plans: projectPlans(result), loading: false, checkedAt: Date.now() });
      }
    } catch (cause) {
      if (pending.current === request) {
        publish({ ...previous, key, error: String(cause), loading: false, checkedAt: Date.now() });
      }
    } finally {
      if (pending.current === request) pending.current = undefined;
    }
  }, [key, cwd, binary, extraArgs]);

  useLayoutEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  return { snapshot: snapshot?.key === key ? snapshot : undefined, refresh };
}
