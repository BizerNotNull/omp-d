import type { ReactNode } from "react";
import { AlertTriangle, FolderOpen, LoaderCircle, Pi, Settings2, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/omp/store";

export function Welcome({ onOpenSettings }: { onOpenSettings: () => void }) {
  const status = useAppStore((state) => state.status);
  const error = useAppStore((state) => state.error);
  const cwd = useAppStore((state) => state.cwd);
  const openProjectDialog = useAppStore((state) => state.openProjectDialog);
  const restart = useAppStore((state) => state.restart);

  return (
    <div className="grid-bg flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card text-2xl font-semibold shadow-sm">
            π
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">omp-d</h1>
            <p className="text-xs text-muted-foreground">A desktop window onto Oh My Pi.</p>
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
          <>
            <div className="rounded-2xl border bg-card p-5 shadow-sm">
              <h2 className="text-sm font-medium">Open a project</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                omp-d runs the local <span className="font-mono text-[11px]">omp</span> binary in RPC mode and talks
                to it over stdio. Sessions, tools, todos and checkpoints stay in Oh My Pi&apos;s own storage.
              </p>
              <Button className="mt-4 gap-2" onClick={() => void openProjectDialog()}>
                <FolderOpen className="size-4" />
                Choose project folder
              </Button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
              <Feature icon={<TerminalSquare className="size-3.5" />} label="RPC over stdio" value="v1 + v2 frames" />
              <Feature icon={<Pi className="size-3.5" />} label="Sessions" value="resume on disk" />
              <Feature icon={<LoaderCircle className="size-3.5" />} label="Streaming" value="text, thinking, tools" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Feature({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card/50 px-3 py-2">
      <div className="flex items-center gap-1.5 text-foreground/80">
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{value}</div>
    </div>
  );
}
