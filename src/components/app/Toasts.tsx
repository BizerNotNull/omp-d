import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";

export function Toasts() {
  const notifications = useAppStore((state) => state.notifications);
  const dismiss = useAppStore((state) => state.dismissToast);
  if (notifications.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-3 bottom-10 z-40 flex w-80 flex-col gap-2">
      {notifications.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            "anim-in pointer-events-auto flex items-start gap-2 rounded-lg border bg-popover p-2.5 text-[11.5px] shadow-lg",
            toast.kind === "error" && "border-destructive/40",
            toast.kind === "warning" && "border-amber-500/40",
          )}
        >
          <span className="mt-0.5 shrink-0">
            {toast.kind === "error" ? (
              <XCircle className="size-3.5 text-destructive" />
            ) : toast.kind === "warning" ? (
              <AlertTriangle className="size-3.5 text-amber-500" />
            ) : toast.kind === "success" ? (
              <CheckCircle2 className="size-3.5 text-emerald-500" />
            ) : (
              <Info className="size-3.5 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            {toast.title && <div className="mb-0.5 font-medium">{toast.title}</div>}
            <div className="break-words text-muted-foreground">{toast.message}</div>
          </div>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
