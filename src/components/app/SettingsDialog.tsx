import { useEffect, useState } from "react";
import { Copy, FolderCog, LoaderCircle, RotateCcw, Save, Square } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAppStore, loadPreferences, type Preferences } from "@/lib/omp/store";
import { cn } from "@/lib/utils";
import { NativeSettings } from "./NativeSettings";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const preferences = useAppStore((state) => state.preferences);
  const updatePreferences = useAppStore((state) => state.updatePreferences);
  const restart = useAppStore((state) => state.restart);
  const cwd = useAppStore((state) => state.cwd);
  const session = useAppStore((state) => state.session);
  const startInfo = useAppStore((state) => state.startInfo);
  const protocolVersion = useAppStore((state) => state.protocolVersion);
  const diagnostics = useAppStore((state) => state.diagnostics);
  const disconnect = useAppStore((state) => state.disconnect);
  const [draft, setDraft] = useState<Preferences>(preferences);
  const [applyBusy, setApplyBusy] = useState(false);
  const [section, setSection] = useState<"native" | "desktop">("native");

  useEffect(() => {
    if (open) setDraft(loadPreferences());
  }, [open]);

  async function applyAndRestart() {
    updatePreferences(draft);
    if (!cwd) {
      onOpenChange(false);
      return;
    }
    setApplyBusy(true);
    try {
      await restart();
    } finally {
      setApplyBusy(false);
      onOpenChange(false);
    }
  }

  async function openSessionsFolder() {
    try {
      const root = await invoke<string>("sessions_root");
      await openPath(root);
    } catch {
      // Opening the folder is a convenience; failures stay silent.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Native Oh My Pi configuration and desktop launch preferences.
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 gap-1 border-b pb-2" role="group" aria-label="Settings section">
          {(["native", "desktop"] as const).map((value) => (
            <Button key={value} variant={section === value ? "secondary" : "ghost"} size="sm"
              aria-pressed={section === value} onClick={() => setSection(value)}>
              {value === "native" ? "Oh My Pi" : "Desktop & runtime"}
            </Button>
          ))}
        </div>

        <div className={section === "native" ? "min-h-0 flex-1 overflow-y-auto scroll-thin" : "hidden"}>
          <NativeSettings active={open && section === "native"} />
        </div>

        <div className={section === "desktop" ? "scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" : "hidden"}>
          <p className="text-xs text-muted-foreground">Launch preferences are stored by omp-d. Save &amp; restart applies them to the agent while preserving the current session.</p>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="omp-binary">omp binary</Label>
              <Input
                id="omp-binary"
                value={draft.binary}
                onChange={(event) => setDraft({ ...draft, binary: event.target.value })}
                placeholder="omp"
                className="font-mono text-[12px]"
              />
              <p className="text-[10.5px] text-muted-foreground">
                Resolved from PATH unless an absolute path is given.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="omp-model">Initial model</Label>
              <Input
                id="omp-model"
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                placeholder="Optional, e.g. anthropic/claude-sonnet-4-5"
                className="font-mono text-[12px]"
              />
              <p className="text-[10.5px] text-muted-foreground">
                Leave empty to let omp restore the session model or its default role.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="omp-args">Extra arguments</Label>
              <Input
                id="omp-args"
                value={draft.extraArgs}
                onChange={(event) => setDraft({ ...draft, extraArgs: event.target.value })}
                placeholder="--hide-thinking --no-lsp"
                className="font-mono text-[12px]"
              />
            </div>
            <div className="flex items-center gap-3">
              <Label>Theme</Label>
              <div className="inline-flex rounded-lg border p-0.5">
                {(["dark", "light"] as const).map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    onClick={() => setDraft({ ...draft, theme })}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] capitalize transition-colors",
                      draft.theme === theme ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {theme}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="text-[11px] font-medium">Runtime</div>
            <div className="grid gap-1 overflow-hidden rounded-lg border bg-muted/20 p-2.5 font-mono text-[10.5px] text-muted-foreground">
              <div className="flex min-w-0 items-baseline gap-4">
                <span className="shrink-0">command</span>
                <span className="min-w-0 flex-1 truncate text-right text-foreground/80">{startInfo?.program ?? "—"}</span>
              </div>
              <div className="flex min-w-0 items-baseline gap-4">
                <span className="shrink-0">args</span>
                <span className="min-w-0 flex-1 truncate text-right text-foreground/80">{startInfo?.args.join(" ") ?? "—"}</span>
              </div>
              <div className="flex min-w-0 items-baseline gap-4">
                <span className="shrink-0">pid / generation</span>
                <span className="min-w-0 flex-1 truncate text-right text-foreground/80">
                  {startInfo ? `${startInfo.pid} / ${startInfo.generation}` : "—"}
                </span>
              </div>
              <div className="flex min-w-0 items-baseline gap-4">
                <span className="shrink-0">protocol</span>
                <span className="min-w-0 flex-1 truncate text-right text-foreground/80">
                  {protocolVersion !== undefined ? `v${protocolVersion} → v2 frames` : "—"}
                </span>
              </div>
              <div className="flex min-w-0 items-baseline gap-4">
                <span className="shrink-0">session file</span>
                <span className="min-w-0 flex-1 truncate text-right text-foreground/80">{session?.sessionFile ?? "unsaved"}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void openSessionsFolder()}>
                <FolderCog className="size-3.5" /> Sessions folder
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!session?.sessionFile}
                onClick={() => void navigator.clipboard.writeText(session?.sessionFile ?? "")}
              >
                <Copy className="size-3.5" /> Copy path
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive"
                onClick={() => void disconnect()}
              >
                <Square className="size-3 fill-current" /> Stop agent
              </Button>
            </div>
          </div>

          {diagnostics.length > 0 && (
            <>
              <Separator />
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium">stderr</span>
                  <span className="text-[10px] text-muted-foreground">{diagnostics.length} lines</span>
                </div>
                <pre className="scroll-thin max-h-40 overflow-auto rounded-lg border bg-muted/20 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                  {diagnostics.slice(-40).join("\n")}
                </pre>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {section === "desktop" && <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              const drafts = loadPreferences();
              setDraft(drafts);
            }}
          >
            <RotateCcw className="size-3.5" /> Revert
          </Button>}
          {section === "desktop" ? <Button onClick={() => void applyAndRestart()} disabled={applyBusy} className="gap-1.5">
            {applyBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            Save &amp; restart
          </Button> : <Button disabled={!cwd || applyBusy} className="gap-1.5" onClick={async () => {
            setApplyBusy(true);
            try { await restart(); } finally { setApplyBusy(false); }
          }}>
            <RotateCcw className={cn("size-3.5", applyBusy && "animate-spin")} /> Restart agent
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
