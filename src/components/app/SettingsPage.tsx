import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Copy, FolderCog, LoaderCircle, RotateCcw, Save, Square } from "lucide-react";
import { invoke } from "@/lib/diagnostics";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore, loadPreferences, type Preferences } from "@/lib/omp/store";
import { cn } from "@/lib/utils";
import { NativeSettings } from "./NativeSettings";
import { pickerRowClass } from "./picker-styles";
import { SettingsSelect, SettingsSelectOption } from "./SettingsSelect";
import { WindowTitleBar } from "./WindowTitleBar";

const sections = {
  native: "Oh My Pi",
  desktop: "Desktop & runtime",
} as const;
type SettingsSection = keyof typeof sections;

const sectionIds = ["native", "desktop"] as const;
const themeLabels = { light: "Light", dark: "Dark" } as const;
const launchFields = [
  { key: "binary", id: "omp-binary", label: "omp binary", hint: "Resolved from PATH unless an absolute path is given.", placeholder: "omp" },
  { key: "model", id: "omp-model", label: "Initial model", hint: "Leave blank to restore the session model or use the default role.", placeholder: "provider/model-id" },
  { key: "extraArgs", id: "omp-args", label: "Extra arguments", hint: "Passed to omp when it starts.", placeholder: "--hide-thinking --no-lsp" },
] as const;
const launchRowClass = "grid min-w-0 items-center gap-1.5 py-2 @min-[22rem]:grid-cols-2 @min-[22rem]:gap-3";

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
  const themeId = useId();
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
      <WindowTitleBar />
      <header className="flex h-10 shrink-0 items-center gap-2 border-b bg-card px-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back from settings" title="Back from settings (Esc)" onClick={onClose} disabled={applyBusy}>
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <h1 id="settings-title" ref={headingRef} tabIndex={-1} className="truncate text-xs font-medium outline-none">Settings</h1>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Settings sections" className="shrink-0 border-b border-sidebar-border bg-sidebar/40 px-3 py-2 md:w-40 md:border-r md:border-b-0 md:p-0 lg:w-44">
          <SettingsSelect aria-label="Settings section" value={section} label={sections[section]}
            disabled={applyBusy} onValueChange={setSection} className="w-full md:hidden">
            {sectionIds.map((id) => <SettingsSelectOption key={id} value={id}>{sections[id]}</SettingsSelectOption>)}
          </SettingsSelect>
          <div className="hidden md:block">
            <h2 className="px-3 pt-3 pb-1.5 text-[11px] font-medium text-muted-foreground">Sections</h2>
            <div className="space-y-0.5 px-2 pb-2">
              {sectionIds.map((id) => (
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
              <div className="@container min-w-0 space-y-2 p-3">
                <h3 className="text-xs font-medium">Launch preferences</h3>
                <p className="text-xs text-muted-foreground">Save &amp; restart applies these preferences and preserves the current session.</p>
                <div className="divide-y border-y">
                  {launchFields.map(({ key, id, label, hint, placeholder }) => (
                    <div key={key} className={launchRowClass}>
                      <div className="space-y-1">
                        <Label htmlFor={id} className="text-xs">{label}</Label>
                        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
                      </div>
                      <Input id={id} aria-describedby={`${id}-hint`} value={draft[key]} disabled={applyBusy}
                        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} placeholder={placeholder}
                        autoComplete="off" spellCheck={false}
                        className="h-7 min-w-0 max-w-72 bg-background font-mono text-xs md:text-xs @min-[22rem]:justify-self-end" />
                    </div>
                  ))}
                  <div className={launchRowClass}>
                    <Label htmlFor={themeId} className="text-xs">Theme</Label>
                    <SettingsSelect id={themeId} value={draft.theme} label={themeLabels[draft.theme]} disabled={applyBusy}
                      onValueChange={(theme) => setDraft({ ...draft, theme })} className="@min-[22rem]:justify-self-end">
                      <SettingsSelectOption value="light">{themeLabels.light}</SettingsSelectOption>
                      <SettingsSelectOption value="dark">{themeLabels.dark}</SettingsSelectOption>
                    </SettingsSelect>
                  </div>
                </div>
              </div>

              <div className="min-w-0 space-y-4 p-3">
                <div className="space-y-2">
                  <h3 className="text-xs font-medium">Runtime</h3>
                  <p className="text-xs text-muted-foreground">Current agent process and session.</p>
                  <dl className="divide-y border-y text-xs">
                    {[
                      ["Command", startInfo?.program ?? "—"],
                      ["Arguments", startInfo?.args.join(" ") ?? "—"],
                      ["PID / generation", startInfo ? `${startInfo.pid} / ${startInfo.generation}` : "—"],
                      ["Protocol", protocolVersion !== undefined ? `v${protocolVersion} → v2 frames` : "—"],
                      ["Session file", session?.sessionFile ?? "Unsaved"],
                    ].map(([label, value]) => (
                      <div key={label} className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-2 py-2">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="font-mono [overflow-wrap:anywhere]">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => void openSessionsFolder()}>
                      <FolderCog aria-hidden="true" className="size-3.5" /> Sessions folder
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      disabled={!session?.sessionFile}
                      onClick={() => void navigator.clipboard.writeText(session?.sessionFile ?? "")}
                    >
                      <Copy aria-hidden="true" className="size-3.5" /> Copy path
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-destructive"
                      onClick={() => void disconnect()}
                    >
                      <Square aria-hidden="true" className="size-3 fill-current" /> Stop agent
                    </Button>
                  </div>
                </div>

                {diagnostics.length > 0 && (
                  <div className="space-y-1.5 border-t pt-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-medium">stderr</h3>
                      <span className="text-[11px] text-muted-foreground">{diagnostics.length} lines</span>
                    </div>
                    <pre className="scroll-thin max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                      {diagnostics.slice(-40).join("\n")}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </section>

          <footer className="shrink-0 border-t bg-card">
            <div className="flex flex-wrap justify-end gap-2 px-3 py-2">
              {section === "desktop" ? <>
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => setDraft(loadPreferences())} disabled={applyBusy}>
                  <RotateCcw aria-hidden="true" className="size-3.5" /> Revert
                </Button>
                <Button size="sm" className="text-xs" onClick={() => void applyAndRestart()} disabled={applyBusy}>
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
