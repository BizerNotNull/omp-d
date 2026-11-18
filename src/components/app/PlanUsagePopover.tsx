import { ChevronUp, LoaderCircle, RefreshCw } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { remainingPercent, type PlanUsageState, type QuotaLimit, type UsagePlan } from "@/lib/omp/plan-usage";
import { cn } from "@/lib/utils";

const triggerId = "inspector-plan-usage";
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function percentLabel(percent: number) {
  return percent > 0 && percent < 1 ? "<1% left" : `${Math.round(percent)}% left`;
}

function quotaTone(percent: number | undefined) {
  return percent === 0 ? "text-destructive" : percent !== undefined && percent <= 20 ? "text-amber-700 dark:text-amber-400" : undefined;
}

function quotaLabel(quota: QuotaLimit, percent: number | undefined) {
  if (quota.status === "exhausted" || percent === 0) return "Limit reached";
  const { unit, remaining, limit, used } = quota.amount;
  const amount = remaining ?? (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
  if (amount !== undefined && unit !== "percent" && unit !== "unknown") {
    return `${number.format(amount)} ${unit === "usd" ? "USD" : unit} left`;
  }
  return percent === undefined ? "Remaining unknown" : percentLabel(percent);
}

function planSummary(plan: UsagePlan) {
  let tightest: { quota: QuotaLimit; percent: number } | undefined;
  for (const quota of plan.limits) {
    const percent = remainingPercent(quota);
    if (percent !== undefined && (!tightest || percent < tightest.percent)) tightest = { quota, percent };
  }
  if (tightest) {
    const { quota, percent } = tightest;
    return { text: `${quota.window?.label ?? quota.label} · ${percent === 0 ? "Limit reached" : percentLabel(percent)}`, percent };
  }
  return { text: plan.limits.length === 1 ? quotaLabel(plan.limits[0], undefined) : "1 plan" };
}

function PlanDetails({ plan, index }: { plan: UsagePlan; index: number }) {
  const title = [plan.provider, plan.name].filter(Boolean).join(" · ");
  const identity = [plan.identity ?? `Account ${index + 1}`, plan.organization].filter(Boolean).join(" · ");
  return (
    <section aria-label={`${title}, ${identity}`} className="min-w-0 space-y-2 border-b border-border px-1 pb-3 pt-2 last:border-b-0">
      <div className="min-w-0">
        <h4 className="wrap-anywhere text-xs font-medium">{title}</h4>
        <p className="wrap-anywhere text-[11px] text-muted-foreground">{identity}</p>
      </div>
      {plan.limits.length === 0 ? <p className="text-xs text-muted-foreground">Usage isn’t available for this account.</p> : (
        <dl className="space-y-2">
          {plan.limits.map((quota, index) => {
            const percent = remainingPercent(quota);
            const tier = quota.scope.tier;
            const label = tier && !quota.label.toLowerCase().includes(tier.toLowerCase()) ? `${quota.label} (${tier})` : quota.label;
            const resetLabel = quota.window?.resetLabel || "resets";
            return <div key={`${quota.id}:${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-xs">
              <dt className="wrap-anywhere text-muted-foreground">{label}</dt>
              <dd className={cn("text-right tabular-nums", quotaTone(percent))}>{quotaLabel(quota, percent)}</dd>
              {quota.window?.resetsAt !== undefined && <dd className="col-span-2 text-right text-[11px] text-muted-foreground">
                {resetLabel[0].toUpperCase() + resetLabel.slice(1)} at <time dateTime={new Date(quota.window.resetsAt).toISOString()}>{timestamp.format(quota.window.resetsAt)}</time>
              </dd>}
              {quota.notes?.map((note, i) => <dd key={i} className="col-span-2 wrap-anywhere text-[11px] text-muted-foreground">{note}</dd>)}
            </div>;
          })}
        </dl>
      )}
      {plan.notes?.map((note, i) => <p key={i} className="wrap-anywhere text-[11px] text-muted-foreground">{note}</p>)}
      {plan.updatedAt !== undefined && <p className="text-[11px] text-muted-foreground">Updated <time dateTime={new Date(plan.updatedAt).toISOString()}>{timestamp.format(plan.updatedAt)}</time></p>}
    </section>
  );
}

export function PlanUsagePopover({ usage, provider, open, onOpenChange }: {
  usage: PlanUsageState;
  provider?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot, refresh } = usage;
  const loading = snapshot?.loading ?? open;
  const plans = loading ? undefined : snapshot?.plans;
  const sameProvider = provider ? plans?.filter((plan) => plan.provider === provider) : undefined;
  const primary = sameProvider?.length ? sameProvider : plans;
  const other = sameProvider?.length ? plans?.filter((plan) => plan.provider !== provider) : undefined;
  const summary: { text?: string; percent?: number } = plans?.length === 1 && sameProvider?.length === 1 && plans[0].limits.length
    ? planSummary(plans[0])
    : { text: loading ? undefined : plans?.length ? `${plans.length} ${plans.length === 1 ? "plan" : "plans"}` : snapshot?.error || plans ? "Unavailable" : undefined };
  return (
    <Popover open={open} onOpenChange={onOpenChange} triggerId={triggerId}>
      <PopoverTrigger id={triggerId} type="button" className="flex min-h-9 w-full shrink-0 items-center gap-2 border-t px-4 text-left text-[11px] hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="shrink-0 text-muted-foreground">Plan usage</span>
        <span className={cn("ml-auto truncate tabular-nums", quotaTone(summary.percent))} title={summary.text}>
          {loading ? <LoaderCircle role="img" aria-label="Loading plan usage" className="size-3.5 animate-spin motion-reduce:animate-none" /> : summary.text}{snapshot?.error && plans?.length ? " · stale" : ""}
        </span>
        <ChevronUp aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-80 max-w-[calc(100vw-1rem)] overflow-auto overscroll-contain p-3 text-xs motion-reduce:animate-none" style={{ maxHeight: "min(28rem, var(--available-height))" }}>
        <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
          <PopoverTitle>Plan usage</PopoverTitle>
          <button type="button" aria-label="Refresh usage" title="Refresh usage" disabled={loading} onClick={() => void refresh(true)} className="grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
            <RefreshCw aria-hidden="true" className="size-3.5" />
          </button>
        </div>
        <div>
          <div role="status" className="flex items-center gap-2 wrap-anywhere text-xs text-muted-foreground empty:hidden">
            {loading ? <><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />Checking usage…</>
              : snapshot?.error ? (plans?.length ? "Refresh failed. Showing previous usage." : "Couldn’t load usage.")
              : plans?.length === 0 ? "No plan usage reported by omp." : null}
          </div>
          {snapshot?.error && !loading && <p className="mt-1 wrap-anywhere text-[11px] text-muted-foreground">{snapshot.error}</p>}
          {plans && plans.length > 1 && <p className="pt-1 text-[11px] text-muted-foreground">omp doesn’t report which account this session uses.</p>}
          {primary?.map((plan, index) => <PlanDetails key={index} plan={plan} index={index} />)}
          {!!other?.length && <details className="border-t border-border pt-2">
            <summary className="cursor-pointer rounded px-1 py-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">Other plans ({other.length})</summary>
            {other.map((plan, index) => <PlanDetails key={index} plan={plan} index={index} />)}
          </details>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
