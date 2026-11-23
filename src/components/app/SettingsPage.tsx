import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, FolderCog, LoaderCircle, RotateCcw, Save, Square } from "lucide-react";
import { invoke } from "@/lib/diagnostics";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAppStore, loadPreferences, type Preferences } from "@/lib/omp/store";
import { cn } from "@/lib/utils";
import { NativeSettings } from "./NativeSettings";
import { pickerRowClass } from "./picker-styles";

const sections = {
  native: "Oh My Pi",
  desktop: "Desktop & runtime",
} as const;
type SettingsSection = keyof typeof sections;

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const updatePreferences = useAppStore((state) => state.updatePreferences);
  const restart = useAppStore((state) => state.restart);
  const cwd = useAppStore((state) => state.cwd);
  const session = useAppStore((state) => state.session);
  const startInfo = useAppStore((state) => state.startInfo);
  const protocolVersion = useAppStore((state) => state.protocolVersion);
  const diagnostics = useAppStore((state) => state.diagnostics);
  const disconnect = useAppStore((state) => state.disconnect);
  const [draft, setDraft] = useState<Preferences>(loadPreferences);
  const [applyBusy, setApplyBusy] = useState(false);
  const [section, setSection] = useState<SettingsSection>("native");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function applyAndRestart() {
    updatePreferences(draft);
    if (!cwd) {
      onClose();
      return;
    }
    setApplyBusy(true);
    try {
      await restart();
    } finally {
      onClose();
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
    <main aria-labelledby="settings-title" className="flex h-full w-full flex-col bg-background text-foreground" onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !applyBusy && event.currentTarget.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
      <header className="shrink-0 border-b bg-card">
        <div className="flex min-h-12 items-center gap-2 px-3 md:px-5">
          <Button variant="ghost" size="icon-sm" aria-label="Back from settings" title="Back from settings (Esc)" onClick={onClose} disabled={applyBusy}>
            <ArrowLeft aria-hidden="true" className="size-4" />
          </Button>
          <h1 id="settings-title" ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">Settings</h1>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Settings sections" className="shrink-0 border-b border-sidebar-border bg-sidebar/40 px-3 py-2 md:w-40 md:border-r md:border-b-0 md:p-0 lg:w-44">
          <select aria-label="Settings section" value={section} disabled={applyBusy}
            onChange={(event) => setSection(event.target.value as SettingsSection)}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 md:hidden">
            <option value="native">{sections.native}</option>
            <option value="desktop">{sections.desktop}</option>
          </select>
          <div className="hidden md:block">
            <h2 className="px-3 pt-3 pb-1.5 text-[11px] font-medium text-muted-foreground">Sections</h2>
            <div className="space-y-0.5 px-2 pb-2">
              {(["native", "desktop"] as const).map((id) => (
                <button key={id} type="button" aria-current={section === id ? "true" : undefined}
                  aria-controls={`settings-${id}`} onClick={() => setSection(id)} disabled={applyBusy}
                  className={cn(pickerRowClass, "min-h-7 disabled:opacity-50",
                    section === id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
                  {sections[id]}
                </button>
              ))}
            </div>
          </div>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-11 shrink-0 items-center border-b px-3">
            <h2 id="settings-section-title" className="text-xs font-medium">{sections[section]}</h2>
          </div>
          <section id="settings-native" aria-labelledby="settings-section-title" hidden={section !== "native"} className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="px-3 py-3">
              <NativeSettings active={section === "native"} />
            </div>
          </section>

          <section id="settings-desktop" aria-labelledby="settings-section-title" hidden={section !== "desktop"} className="@container scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="grid divide-y @min-[48rem]:grid-cols-2 @min-[48rem]:divide-x @min-[48rem]:divide-y-0">
              <div className="min-w-0 space-y-3 p-3">
                <h3 className="text-xs font-medium">Launch preferences</h3>
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
                          aria-pressed={draft.theme === theme}
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
              </div>

              <div className="min-w-0 space-y-4 p-3">
                <div className="space-y-2">
                  <h3 className="text-xs font-medium">Runtime</h3>
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
            </div>
          </section>

          <footer className="shrink-0 border-t bg-card">
            <div className="flex flex-wrap justify-end gap-2 px-3 py-2">
              {section === "desktop" ? <>
                <Button variant="outline" size="sm" onClick={() => setDraft(loadPreferences())} disabled={applyBusy}>
                  <RotateCcw aria-hidden="true" className="size-3.5" /> Revert
                </Button>
                <Button size="sm" onClick={() => void applyAndRestart()} disabled={applyBusy}>
                  {applyBusy ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden="true" className="size-3.5" />}
                  Save &amp; restart
                </Button>
              </> : <Button size="sm" disabled={!cwd || applyBusy} onClick={async () => {
                setApplyBusy(true);
                try { await restart(); } finally { setApplyBusy(false); }
              }}>
                <RotateCcw aria-hidden="true" className={cn("size-3.5", applyBusy && "animate-spin motion-reduce:animate-none")} /> Restart agent
              </Button>}
            </div>
          </footer>
        </div>
      </div>
    </main>
  );
}
