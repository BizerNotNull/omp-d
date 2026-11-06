import { useEffect, useState } from "react";
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
import { SettingsDialog } from "./SettingsDialog";
import { useAppStore } from "@/lib/omp/store";

export function AppShell() {
  const bootstrap = useAppStore((state) => state.bootstrap);
  const cwd = useAppStore((state) => state.cwd);
  const theme = useAppStore((state) => state.preferences.theme);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        <div className="flex min-h-0 flex-1">
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
          <main className="flex min-w-0 flex-1 flex-col">
            <TopBar
              onOpenModels={() => setModelsOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onTogglePanel={() => setPanelOpen((value) => !value)}
              panelOpen={panelOpen}
            />
            <ChatView />
            <Composer />
          </main>
          {panelOpen && <RightPanel />}
        </div>
        <StatusBar />
        <ExtensionDialogs />
        <Toasts />
        <ModelPicker open={modelsOpen} onOpenChange={setModelsOpen} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </div>
    </TooltipProvider>
  );
}
