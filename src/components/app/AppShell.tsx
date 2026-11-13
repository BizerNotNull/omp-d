import { lazy, Suspense, useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";
import { RightPanel } from "./RightPanel";
import { StatusBar } from "./StatusBar";
import { Welcome } from "./Welcome";
import { Toasts } from "./Toasts";
import { ExtensionDialogs } from "./ExtensionDialogs";
import { ModelPicker } from "./ModelPicker";
import { ProviderLogin } from "./ProviderLogin";
import { SettingsDialog } from "./SettingsDialog";
import { splitExtraArgs } from "@/lib/omp/model-catalog";
import { useAppStore } from "@/lib/omp/store";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

export function AppShell() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const cwd = useAppStore((state) => state.cwd);
  const activeRuntimeId = useAppStore((state) => state.activeRuntimeId);
  const theme = useAppStore((state) => state.preferences.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [loginProvider, setLoginProvider] = useState<string>();
  const preferences = useAppStore((state) => state.preferences);
  const [panelOpen, setPanelOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWorkspace, setTerminalWorkspace] = useState<string>();
  const terminalVisible = terminalOpen && terminalWorkspace === cwd;

  function toggleTerminal() {
    if (!cwd) return;
    setTerminalWorkspace(cwd);
    setTerminalOpen(!terminalVisible);
  }

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && event.code === "Backquote" && !event.altKey) {
        event.preventDefault();
        if (cwd) {
          setTerminalWorkspace(cwd);
          setTerminalOpen((open) => terminalWorkspace !== cwd || !open);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cwd, terminalWorkspace]);

  if (!cwd) {
    return (
      <TooltipProvider>
        <div className="h-full w-full bg-background text-foreground">
          <Welcome onOpenSettings={() => setSettingsOpen(true)} />
          <Toasts />
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-full w-full flex-col bg-background text-foreground">
        {!modelsOpen && <TopBar
          onOpenModels={() => setModelsOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onTogglePanel={() => setPanelOpen((value) => !value)}
          panelOpen={panelOpen}
        />}
        <div className="flex min-h-0 flex-1">
          {!modelsOpen && <Sidebar />}
          <main className="relative flex min-w-0 flex-1 flex-col">
            {modelsOpen && <div className={loginProvider ? "hidden" : "flex min-h-0 flex-1 flex-col"}><ModelPicker active={!loginProvider} onClose={() => setModelsOpen(false)} onLoginRequest={setLoginProvider} /></div>}
            {modelsOpen && loginProvider && <ProviderLogin key={`${cwd}:${loginProvider}`} provider={loginProvider} options={{ cwd, binary: preferences.binary.trim() || "omp", extraArgs: splitExtraArgs(preferences.extraArgs) }} onBack={() => setLoginProvider(undefined)} onSuccess={() => { setLoginProvider(undefined); void useAppStore.getState().fetchModels(); }} />}
            <div className={modelsOpen ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-hidden"}>
              <ChatView key={`chat-${activeRuntimeId}`} />
              <Composer key={`composer-${activeRuntimeId}`} active={!modelsOpen && !settingsOpen} onOpenModels={() => setModelsOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
            </div>
            {terminalWorkspace === cwd && (
              <Suspense fallback={terminalVisible ? <div role="status" className="border-t p-3 text-xs text-muted-foreground">Loading terminal…</div> : null}>
                <TerminalPanel key={cwd} cwd={cwd} open={terminalVisible && !modelsOpen} onHide={() => setTerminalOpen(false)} />
              </Suspense>
            )}
          </main>
          {panelOpen && !modelsOpen && <RightPanel />}
        </div>
        <StatusBar terminalOpen={terminalVisible} onToggleTerminal={toggleTerminal} />
        <ExtensionDialogs />
        <Toasts />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </TooltipProvider>
  );
}
