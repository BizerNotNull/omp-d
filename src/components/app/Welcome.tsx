import { AlertTriangle, FolderOpen, LoaderCircle, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/omp/store";

export function Welcome({ onOpenSettings }: { onOpenSettings: () => void }) {
  const status = useAppStore((state) => state.status);
  const error = useAppStore((state) => state.error);
  const cwd = useAppStore((state) => state.cwd);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const restart = useAppStore((state) => state.restart);

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-2xl font-semibold shadow-sm">
            π
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">omp-d</h1>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            <Settings2 className="size-4" />
          </Button>
        </div>

        {status === "starting" ? (
          <div className="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Starting the omp RPC process{cwd ? ` in ${cwd}` : ""}…
          </div>
        ) : status === "error" ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="size-4" />
              The agent did not start
            </div>
            <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">{error}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void restart()} disabled={!cwd}>
                Retry
              </Button>
              <Button size="sm" variant="outline" onClick={() => void openProjectDialog()}>
                Choose another folder
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-center py-6">
            <Button className="gap-2" onClick={() => void openProjectDialog()}>
              <FolderOpen className="size-4" />
              Choose project folder
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
