import { lazy, Suspense, useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";
import { RightPanel } from "./RightPanel";
import { PlanUsagePopover } from "./PlanUsagePopover";
import { StatusBar } from "./StatusBar";
import { Welcome } from "./Welcome";
import { Toasts } from "./Toasts";
import { ModelPicker } from "./ModelPicker";
import { ProviderLogin } from "./ProviderLogin";
import { SettingsDialog } from "./SettingsDialog";
import { catalogCacheKey, invalidateCatalog, splitExtraArgs } from "@/lib/omp/model-catalog";
import { usePlanUsage } from "@/lib/omp/plan-usage";
import { useAppStore } from "@/lib/omp/store";
import { InspectorDetail } from "./InspectorDetail";
import { useInspectorData, type InspectorSelection } from "@/lib/omp/inspector-data";

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
  const [usageOpen, setUsageOpen] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const usage = usePlanUsage(cwd, preferences.binary, preferences.extraArgs, authRevision, usageOpen);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWorkspace, setTerminalWorkspace] = useState<string>();
  const terminalVisible = terminalOpen && terminalWorkspace === cwd;
  const inspector = useInspectorData();
  const [inspection, setInspection] = useState<{ runtime: number; session?: string; selection: InspectorSelection }>();
  const selection = inspection?.runtime === activeRuntimeId && inspection.session === inspector.session?.sessionId ? inspection.selection : undefined;
  function inspect(value: InspectorSelection) {
    setInspection({ runtime: activeRuntimeId, session: inspector.session?.sessionId, selection: value });
    if (window.innerWidth < 1024) setPanelOpen(false);
  }

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

  function closePanel() {
    setUsageOpen(false);
    setPanelOpen(false);
  }

  function openUsage() {
    setPanelOpen(true);
    setUsageOpen(true);
    void usage.refresh(true);
  }

  function openModels() {
    setUsageOpen(false);
    setModelsOpen(true);
  }

  function completeLogin() {
    setLoginProvider(undefined);
    setAuthRevision((revision) => revision + 1);
    if (cwd) invalidateCatalog(catalogCacheKey(cwd, preferences));
    void useAppStore.getState().fetchModels();
  }

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
        <div className="relative flex min-h-0 flex-1">
          {!modelsOpen && <Sidebar />}
          <main className="relative flex min-w-0 flex-1 flex-col">
            {!modelsOpen && (
              <TopBar
                onOpenModels={openModels}
                onOpenSettings={() => setSettingsOpen(true)}
                onTogglePanel={() => panelOpen ? closePanel() : setPanelOpen(true)}
                panelOpen={panelOpen}
              />
            )}
            {modelsOpen && <div className={loginProvider ? "hidden" : "flex min-h-0 flex-1 flex-col"}><ModelPicker active={!loginProvider} onClose={() => setModelsOpen(false)} onLoginRequest={setLoginProvider} /></div>}
            {modelsOpen && loginProvider && <ProviderLogin key={`${cwd}:${loginProvider}`} provider={loginProvider} options={{ cwd, binary: preferences.binary.trim() || "omp", extraArgs: splitExtraArgs(preferences.extraArgs) }} onBack={() => setLoginProvider(undefined)} onSuccess={completeLogin} />}
            {!modelsOpen && selection && <InspectorDetail selection={selection} data={inspector} onSelect={inspect} onClose={() => setInspection(undefined)} />}
            <div className={modelsOpen || selection ? "hidden" : "flex min-h-0 flex-1 flex-col overflow-hidden"}>
              <ChatView key={`chat-${activeRuntimeId}`} />
              <Composer key={`composer-${activeRuntimeId}`} active={!modelsOpen && !settingsOpen && !selection} onOpenModels={openModels} onOpenSettings={() => setSettingsOpen(true)} onOpenUsage={openUsage} />
            </div>
            {terminalWorkspace === cwd && (
              <Suspense fallback={terminalVisible ? <div role="status" className="border-t p-3 text-xs text-muted-foreground">Loading terminal…</div> : null}>
                <TerminalPanel key={cwd} cwd={cwd} open={terminalVisible && !modelsOpen} onHide={() => setTerminalOpen(false)} />
              </Suspense>
            )}
          </main>
          {panelOpen && !modelsOpen && (
            <RightPanel data={inspector} onInspect={inspect} onClose={closePanel}
              planUsage={<PlanUsagePopover usage={usage} provider={inspector.session?.model?.provider} open={usageOpen} onOpenChange={setUsageOpen} />} />
          )}
        </div>
        <StatusBar terminalOpen={terminalVisible} onToggleTerminal={toggleTerminal} />
        <Toasts />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </TooltipProvider>
  );
}
