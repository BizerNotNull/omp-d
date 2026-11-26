import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function WindowTitleBar({ actions, onOpenSettings }: {
  actions?: ReactNode;
  onOpenSettings?: () => void;
}) {
  return (
    <header aria-label="Window title bar" className="relative flex h-10 shrink-0 select-none justify-between border-b bg-sidebar">
      {/* Tauri only treats the event target itself as draggable. Keep the interactive controls above this surface. */}
      <div data-tauri-drag-region aria-hidden="true" className="absolute inset-0" />
      <div className="pointer-events-none relative flex min-w-0 items-center gap-2.5 pl-2.5 pr-1 sm:pl-3 sm:pr-2">
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-md border bg-background pb-px text-sm font-semibold leading-none">π</span>
        <span className="sr-only text-xs font-semibold tracking-tight sm:not-sr-only sm:shrink-0">omp-d</span>
      </div>
      <div className="pointer-events-none relative flex min-w-0 items-stretch justify-end">
        {(actions || onOpenSettings) && <div className="flex items-center gap-0.5 px-1 sm:gap-1 sm:px-2 [&_button]:pointer-events-auto">
          {actions}
          {onOpenSettings && <Button variant="ghost" size="icon-sm" className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            onClick={onOpenSettings} aria-label="Settings" title="Settings (Ctrl+,)">
            <Settings aria-hidden="true" className="size-4" />
          </Button>}
        </div>}
        {isTauri() && <WindowControls />}
      </div>
    </header>
  );
}

function WindowControls() {
  const [appWindow] = useState(getCurrentWindow);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    function sync() {
      void appWindow.isMaximized().then((value) => {
        if (active) setMaximized(value);
      }).catch((error) => window.reportError(error));
    }
    const subscription = appWindow.onResized(() => {
      if (!active) return;
      clearTimeout(timer);
      // Resizing by hand can emit a frame per pixel; query once the window settles.
      timer = window.setTimeout(sync, 60);
    });
    void subscription.then(() => { if (active) sync(); }).catch((error) => window.reportError(error));
    return () => {
      active = false;
      clearTimeout(timer);
      void subscription.then((unlisten) => unlisten(), () => {});
    };
  }, [appWindow]);

  return (
    <div role="group" aria-label="Window controls" className="pointer-events-auto flex shrink-0 border-l">
      <CaptionButton label="Minimize" onClick={() => appWindow.minimize()} path="M1 6h10" />
      <CaptionButton label={maximized ? "Restore down" : "Maximize"} onClick={() => appWindow.toggleMaximize()}
        path={maximized ? "M3.5 3.5V1.5h7v7h-2m-7-5h7v7h-7z" : "M1.5 1.5h9v9h-9z"} />
      <CaptionButton label="Close window" onClick={() => appWindow.close()} path="m1.5 1.5 9 9m0-9-9 9" close />
    </div>
  );
}

function CaptionButton({ label, onClick, path, close }: {
  label: string;
  onClick: () => Promise<void>;
  path: string;
  close?: boolean;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={() => void onClick().catch((error) => window.reportError(error))}
      className={cn("grid w-9 place-items-center text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:w-[46px]",
        close ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#a4261c]" : "hover:bg-muted-foreground/15 active:bg-muted-foreground/25")}>
      <svg aria-hidden="true" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor">
        <path d={path} />
      </svg>
    </button>
  );
}
