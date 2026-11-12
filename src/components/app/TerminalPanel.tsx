import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ChevronDown, Maximize2, Minimize2, Plus, TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/omp/store";
import { TerminalSession, terminalError } from "@/lib/terminal/session";
import { cn } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";

type ShellStatus = { state: "starting" | "running" } | { state: "exited"; code: number } | { state: "error"; message: string };
type TerminalTab = { id: string; number: number };

export interface TerminalPanelProps {
  cwd: string;
  open: boolean;
  onHide: () => void;
}

function terminalTheme(dark: boolean) {
  return {
    background: dark ? "#0a0a0a" : "#ffffff",
    foreground: dark ? "#fafafa" : "#262626",
    cursor: dark ? "#fafafa" : "#262626",
    cursorAccent: dark ? "#0a0a0a" : "#ffffff",
    selectionBackground: dark ? "#ffffff38" : "#00000025",
    black: dark ? "#262626" : "#262626",
    red: dark ? "#f87171" : "#b91c1c",
    green: dark ? "#86efac" : "#15803d",
    yellow: dark ? "#fde047" : "#a16207",
    blue: dark ? "#93c5fd" : "#1d4ed8",
    magenta: dark ? "#d8b4fe" : "#7e22ce",
    cyan: dark ? "#67e8f9" : "#0e7490",
    white: dark ? "#d4d4d4" : "#d4d4d4",
    brightBlack: "#737373",
    brightRed: dark ? "#fca5a5" : "#dc2626",
    brightGreen: dark ? "#bbf7d0" : "#16a34a",
    brightYellow: dark ? "#fef08a" : "#ca8a04",
    brightBlue: dark ? "#bfdbfe" : "#2563eb",
    brightMagenta: dark ? "#e9d5ff" : "#9333ea",
    brightCyan: dark ? "#a5f3fc" : "#0891b2",
    brightWhite: dark ? "#fafafa" : "#fafafa",
  };
}

function ShellView({ cwd, visible, tabId, onStatus }: {
  cwd: string;
  visible: boolean;
  tabId: string;
  onStatus: (id: string, status: ShellStatus) => void;
}) {
  const theme = useAppStore((state) => state.preferences.theme);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let session: TerminalSession | undefined;
    let frame = 0;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: terminalTheme(useAppStore.getState().preferences.theme === "dark"),
      allowProposedApi: false,
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const fit = () => {
      if (disposed || !visibleRef.current || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fitAddon.fit();
      } catch (error) {
        onStatus(tabId, { state: "error", message: `Could not size terminal: ${terminalError(error)}` });
      }
    };
    fitRef.current = fit;
    try {
      terminal.open(host);
      fit();
      // Leave the application's window shortcut untouched, including on macOS.
      terminal.attachCustomKeyEventHandler((event) => !((event.ctrlKey || event.metaKey) && event.code === "Backquote"));
      const input = terminal.onData((data) => session?.write(data));
      const resize = terminal.onResize(({ cols, rows }) => session?.resize(cols, rows));
      session = new TerminalSession(cwd, terminal.cols, terminal.rows, (event) => {
        if (disposed) return;
        if (event.type === "data") {
          terminal.write(new Uint8Array(event.data));
        } else if (event.type === "exit") {
          terminal.options.disableStdin = true;
          // xterm queues this after all preceding raw output, including split UTF-8 sequences.
          terminal.write(`\r\n[Process exited with code ${event.code}]\r\n`, () => {
            if (!disposed) onStatus(tabId, { state: "exited", code: event.code });
          });
        } else {
          onStatus(tabId, { state: "error", message: event.message });
          terminal.write(`\r\n[Terminal error: ${event.message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}]\r\n`);
        }
      }, () => {
        if (!disposed) onStatus(tabId, { state: "running" });
      });
      onStatus(tabId, { state: "starting" });
      // A create failure is delivered through the same visible error path as native errors.
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(fit);
      });
      observer.observe(host);
      if (visibleRef.current) terminal.focus();
      return () => {
        disposed = true;
        cancelAnimationFrame(frame);
        observer.disconnect();
        input.dispose();
        resize.dispose();
        session?.close();
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
      };
    } catch (error) {
      onStatus(tabId, { state: "error", message: `Could not open terminal: ${terminalError(error)}` });
      session?.close();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      return () => { disposed = true; };
    }
  }, [cwd, tabId, onStatus]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (!visible) {
      terminalRef.current?.blur();
      return;
    }
    const frame = requestAnimationFrame(() => {
      fitRef.current?.();
      if (visibleRef.current) terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return <div ref={hostRef} id={`terminal-view-${tabId}`} role="tabpanel" aria-labelledby={`terminal-tab-${tabId}`} className={cn("absolute inset-0 overflow-hidden", !visible && "hidden")} />;
}

function heightBounds() {
  const max = Math.max(100, window.innerHeight - 320);
  return { min: Math.min(140, max), max };
}

export function TerminalPanel({ cwd, open, onHide }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [statuses, setStatuses] = useState<Record<string, ShellStatus>>({});
  const [height, setHeight] = useState(() => Math.min(280, heightBounds().max));
  const [maximized, setMaximized] = useState(false);
  const [bounds, setBounds] = useState(heightBounds);
  const initialized = useRef(false);
  const nextNumber = useRef(1);
  const dragRef = useRef<{ y: number; height: number } | null>(null);

  const addTab = useCallback(() => {
    const tab = { id: crypto.randomUUID(), number: nextNumber.current++ };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }, []);

  useEffect(() => {
    // An unopened, mounted panel must never execute a shell.
    if (open && !initialized.current) {
      initialized.current = true;
      addTab();
    }
  }, [open, addTab]);

  useEffect(() => {
    const resize = () => {
      const next = heightBounds();
      setBounds(next);
      setHeight((current) => Math.max(next.min, Math.min(next.max, current)));
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  const onStatus = useCallback((id: string, status: ShellStatus) => {
    setStatuses((current) => ({ ...current, [id]: status }));
  }, []);

  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (activeId === id) setActiveId(tabs[index + 1]?.id ?? tabs[index - 1]?.id);
    setTabs((current) => current.filter((tab) => tab.id !== id));
    setStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const changeHeight = (next: number) => {
    setMaximized(false);
    setHeight(Math.max(bounds.min, Math.min(bounds.max, next)));
  };
  const displayedHeight = maximized ? bounds.max : height;
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 50 : 10;
    let next: number;
    if (event.key === "ArrowUp") next = displayedHeight + step;
    else if (event.key === "ArrowDown") next = displayedHeight - step;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = bounds.max;
    else return;
    event.preventDefault();
    changeHeight(next);
  };
  const resizePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    changeHeight(dragRef.current.height + dragRef.current.y - event.clientY);
  };
  const activeStatus = activeId ? statuses[activeId] : undefined;

  return (
    <section aria-label="Terminal panel" className={cn("min-h-0 flex-col border-t bg-background", maximized ? "absolute inset-0 z-20" : "relative shrink-0", open ? "flex" : "hidden")} style={maximized ? undefined : { height }}>
      <div
        role="separator"
        aria-label="Resize terminal panel"
        aria-orientation="horizontal"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={displayedHeight}
        aria-valuetext={`${Math.round(displayedHeight)} pixels high`}
        tabIndex={0}
        className={cn("absolute -top-1 z-10 h-2 w-full cursor-row-resize touch-none outline-none hover:bg-primary/20 focus-visible:bg-primary/30", maximized && "hidden")}
        onKeyDown={resizeKey}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { y: event.clientY, height: displayedHeight };
        }}
        onPointerMove={resizePointer}
        onPointerUp={(event) => {
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; }}
        onLostPointerCapture={() => { dragRef.current = null; }}
      />
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">Terminal</span>
        <div role="tablist" aria-label="Terminal tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const status = statuses[tab.id];
            const label = `Shell ${tab.number}${status?.state === "exited" ? ` · exited ${status.code}` : status?.state === "error" ? " · error" : ""}`;
            return (
              <div key={tab.id} className={cn("flex shrink-0 items-center rounded-md text-xs", activeId === tab.id ? "bg-muted text-foreground" : "text-muted-foreground")}>
                <button
                  type="button"
                  role="tab"
                  id={`terminal-tab-${tab.id}`}
                  aria-controls={`terminal-view-${tab.id}`}
                  aria-selected={activeId === tab.id}
                  tabIndex={activeId === tab.id ? 0 : -1}
                  className="rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setActiveId(tab.id)}
                  onKeyDown={(event) => {
                    let index = tabs.findIndex((item) => item.id === tab.id);
                    if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
                    else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
                    else if (event.key === "Home") index = 0;
                    else if (event.key === "End") index = tabs.length - 1;
                    else return;
                    event.preventDefault();
                    setActiveId(tabs[index].id);
                    document.getElementById(`terminal-tab-${tabs[index].id}`)?.focus();
                  }}
                >{label}</button>
                <Button variant="ghost" size="icon-xs" aria-label={`Close shell ${tab.number}`} title={`Close shell ${tab.number}`} onClick={() => closeTab(tab.id)}><X className="size-3" /></Button>
              </div>
            );
          })}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="New terminal" title="New terminal" onClick={addTab}><Plus /></Button>
        <Button variant="ghost" size="icon-xs" aria-label={maximized ? "Restore terminal panel" : "Maximize terminal panel"} title={maximized ? "Restore panel" : "Maximize panel"} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 /> : <Maximize2 />}</Button>
        <Button variant="ghost" size="icon-xs" aria-label="Hide terminal panel" title="Hide terminal (Ctrl+`)" onClick={onHide}><ChevronDown /></Button>
      </div>
      {activeStatus?.state === "error" && <div role="alert" className="max-h-20 shrink-0 overflow-auto break-words border-b px-3 py-1.5 text-xs text-destructive">{activeStatus.message}</div>}
      {activeStatus?.state === "exited" && <div role="status" className="shrink-0 px-3 pt-1 text-xs text-muted-foreground">Process exited with code {activeStatus.code}. Open a new terminal to start another shell.</div>}
      <div className="relative m-2 min-h-0 flex-1">
        {tabs.map((tab) => <ShellView key={tab.id} cwd={cwd} visible={open && activeId === tab.id} tabId={tab.id} onStatus={onStatus} />)}
        {tabs.length === 0 && <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground"><span>No terminals open.</span><Button size="xs" variant="outline" onClick={addTab}><Plus className="size-3" />New terminal</Button></div>}
      </div>
    </section>
  );
}
