import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, PanelRight } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import { Button } from "@/components/ui/button";
import { WindowTitleBar } from "./WindowTitleBar";
import { cn } from "@/lib/utils";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";
import { RightPanel } from "./RightPanel";
import { PlanUsagePopover } from "./PlanUsagePopover";
import { StatusBar } from "./StatusBar";
import { Welcome } from "./Welcome";
import { Toasts } from "./Toasts";
import { ModelPicker } from "./ModelPicker";
import { ProviderLogin } from "./ProviderLogin";
import { SettingsPage } from "./SettingsPage";
import { catalogCacheKey, invalidateCatalog, splitExtraArgs } from "@/lib/omp/model-catalog";
import { usePlanUsage } from "@/lib/omp/plan-usage";
import { useAppStore } from "@/lib/omp/store";
import { sessionPathKey, useSessionNavigation } from "@/lib/omp/navigation";
import { InspectorDetail } from "./InspectorDetail";
import { useInspectorData, type InspectorSelection } from "@/lib/omp/inspector-data";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

export function AppShell() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const cwd = useAppStore((state) => state.cwd);
  const activeRuntimeId = useAppStore((state) => state.activeRuntimeId);
  const hydrating = useAppStore((state) => state.hydrating);
  const branching = useAppStore((state) => state.branching);
  const switchingProject = useSessionNavigation((state) => state.switchingProject);
  const switchingWorktree = useSessionNavigation((state) => state.switchingWorktree);
  const workspaceKey = sessionPathKey(cwd);
  const workspacePending = switchingWorktree ? sessionPathKey(switchingWorktree) !== workspaceKey : Boolean(switchingProject);
  const inspectorCwd = switchingWorktree ?? (switchingProject ? undefined : cwd);
  const conversationLoading = workspacePending || hydrating || branching;
  const theme = useAppStore((state) => state.preferences.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [loginProvider, setLoginProvider] = useState<string>();
  const preferences = useAppStore((state) => state.preferences);
  const [panelOpen, setPanelOpen] = useState(true);
  const [usageOpen, setUsageOpen] = useState(false);
  const [authRevision, setAuthRevision] = useState(0);
  const usage = usePlanUsage(inspectorCwd, preferences.binary, preferences.extraArgs, authRevision, usageOpen);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWorkspace, setTerminalWorkspace] = useState<string>();
  const terminalVisible = terminalOpen && terminalWorkspace === cwd;
  const inspector = useInspectorData(inspectorCwd, workspacePending);
  const inspectorWorkspace = sessionPathKey(inspectorCwd);
  const [inspection, setInspection] = useState<{ runtime: number; workspace: string; session?: string; selection: InspectorSelection }>();
  let selection: InspectorSelection | undefined;
  if (inspectorCwd && inspection?.workspace === inspectorWorkspace) {
    const kind = inspection.selection.kind;
    if (kind === "diff" || kind === "changes" ||
      (inspection.runtime === activeRuntimeId && !inspector.sessionLoading && inspection.session === inspector.session?.sessionId
        && (kind !== "agent" || !inspector.transcriptLoading))) {
      selection = inspection.selection;
    }
  }
  function inspect(value: InspectorSelection) {
    setInspection({ runtime: activeRuntimeId, workspace: inspectorWorkspace, session: inspector.session?.sessionId, selection: value });
    if (window.innerWidth < 1024) setPanelOpen(false);
  }

  function toggleTerminal() {
    if (!cwd) return;
    if (conversationLoading) return;
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

  const openSettings = useCallback(() => {
    setUsageOpen(false);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openSettings();
      } else if (!settingsOpen && (event.ctrlKey || event.metaKey) && event.code === "Backquote" && !event.altKey) {
        event.preventDefault();
        if (cwd && !conversationLoading) {
          setTerminalWorkspace(cwd);
          setTerminalOpen((open) => terminalWorkspace !== cwd || !open);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cwd, terminalWorkspace, conversationLoading, openSettings, settingsOpen]);

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

  function resumeSession(query: string) {
    const app = useAppStore.getState();
    const path = sessionPathKey(query);
    const open = query && app.openSessions.find((session) =>
      session.sessionId === query || sessionPathKey(session.path) === path);
    if (open) {
      app.selectRuntime(open.id);
      return;
    }
    const navigation = useSessionNavigation.getState();
    const match = query && navigation.sessionListing?.sessions.find((session) =>
      session.sessionId === query || sessionPathKey(session.path) === path);
    if (match) {
      void app.switchSession(match.path, match.cwd);
      return;
    }
    navigation.setView("recent");
    navigation.setQuery(query);
    sessionSearchRef.current?.focus();
  }

  function completeLogin() {
    setLoginProvider(undefined);
    setAuthRevision((revision) => revision + 1);
    if (cwd) invalidateCatalog(catalogCacheKey(cwd, preferences));
    void useAppStore.getState().fetchModels();
  }

  return (
    <TooltipProvider>
      {settingsOpen && <SettingsPage onClose={() => setSettingsOpen(false)} />}
      <div className={settingsOpen ? "hidden" : "flex h-full w-full flex-col bg-background text-foreground"}>
        {!settingsOpen && <WindowTitleBar
          onOpenSettings={openSettings}
          actions={cwd && !modelsOpen && !conversationLoading && (
            <Button variant="ghost" size="icon-sm"
              className={cn("size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground", panelOpen && "bg-muted text-foreground")}
              onClick={() => panelOpen ? closePanel() : setPanelOpen(true)}
              aria-label="Toggle activity panel"
              aria-pressed={panelOpen}
              title="Toggle Inspector"
            >
              <PanelRight aria-hidden="true" className="size-4" />
            </Button>
          )}
        />}
        {!cwd && <Welcome />}
        {cwd && <div className="relative flex min-h-0 flex-1">
          {!modelsOpen && <Sidebar searchRef={sessionSearchRef} />}
          <main className="relative flex min-w-0 flex-1 flex-col">
            {modelsOpen && <div className={loginProvider ? "hidden" : "flex min-h-0 flex-1 flex-col"}><ModelPicker active={!settingsOpen && !loginProvider} onClose={() => setModelsOpen(false)} onLoginRequest={setLoginProvider} /></div>}
            {modelsOpen && loginProvider && <ProviderLogin key={`${cwd}:${loginProvider}`} provider={loginProvider} options={{ cwd, binary: preferences.binary.trim() || "omp", extraArgs: splitExtraArgs(preferences.extraArgs) }} onBack={() => setLoginProvider(undefined)} onSuccess={completeLogin} />}
            {!modelsOpen && conversationLoading && !selection && <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{branching ? "Loading conversation branch…" : "Loading conversation…"}</div>}
            {!modelsOpen && selection && <InspectorDetail selection={selection} data={inspector} onSelect={inspect} onClose={() => setInspection(undefined)} />}
            <div className={modelsOpen || selection || conversationLoading ? "hidden" : "@container flex min-h-0 flex-1 flex-col overflow-hidden"}>
              <ChatView key={`chat-${activeRuntimeId}`} />
              <Composer key={`composer-${activeRuntimeId}`} active={!modelsOpen && !settingsOpen && !selection && !conversationLoading} onOpenModels={openModels} onOpenSettings={openSettings} onOpenUsage={openUsage} onResume={resumeSession} />
            </div>
            {terminalWorkspace === cwd && (
              <Suspense fallback={terminalVisible && !settingsOpen && !conversationLoading ? <div role="status" className="flex items-center gap-2 border-t p-3 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />Loading terminal…</div> : null}>
                <TerminalPanel key={cwd} cwd={cwd} open={terminalVisible && !settingsOpen && !modelsOpen && !conversationLoading} onHide={() => setTerminalOpen(false)} />
              </Suspense>
            )}
          </main>
          {panelOpen && !modelsOpen && (
            <RightPanel data={inspector} onInspect={inspect} onClose={closePanel}
              planUsage={inspectorCwd && <PlanUsagePopover usage={usage} provider={inspector.session?.model?.provider} open={usageOpen} onOpenChange={setUsageOpen} />} />
          )}
        </div>}
        {cwd && <StatusBar terminalOpen={terminalVisible} onToggleTerminal={toggleTerminal} />}
      </div>
      <Toasts />
    </TooltipProvider>
  );
}
