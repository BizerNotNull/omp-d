import { useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Gauge,
  LoaderCircle,
  PanelRight,
  Pencil,
  Plus,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAppStore, sessionTitle } from "@/lib/omp/store";
import { modelLabel } from "@/lib/omp/format";

export function TopBar({
  onOpenModels,
  onOpenSettings,
  onTogglePanel,
  panelOpen,
}: {
  onOpenModels: () => void;
  onOpenSettings: () => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
}) {
  const session = useAppStore((state) => state.session);
  const busy = useAppStore((state) => state.busy);
  const status = useAppStore((state) => state.status);
  const thinkingLevels = useAppStore((state) => state.thinkingLevels);
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel);
  const newSession = useAppStore((state) => state.newSession);
  const compact = useAppStore((state) => state.compact);
  const renameSession = useAppStore((state) => state.renameSession);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const title = sessionTitle(session, session?.sessionId ? "Untitled session" : "New session");
  const level = session?.thinkingLevel ?? "off";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {busy && <LoaderCircle className="size-3.5 animate-spin text-amber-500" />}
        <button
          type="button"
          onClick={() => {
            setRenameValue(session?.sessionName ?? "");
            setRenameOpen(true);
          }}
          className="group flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted"
        >
          <span className="max-w-[38vw] truncate text-[12.5px] font-medium">{title}</span>
          <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
        {session?.sessionFile && (
          <button
            type="button"
            className="hidden items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted lg:flex"
            onClick={() => void navigator.clipboard.writeText(session.sessionFile ?? "")}
            aria-label="Copy session file path"
          >
            <Copy className="size-3" />
            session
          </button>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onOpenModels}
          className="flex h-7 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2 text-[11px] transition-colors hover:bg-muted"
        >
          <Cpu className="size-3.5 text-muted-foreground" />
          <span className="max-w-40 truncate">{modelLabel(session?.model)}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              />
            }
          >
            <Brain className="size-3.5" />
            <span className="capitalize">{level}</span>
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Thinking level</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {thinkingLevels.length === 0 && <DropdownMenuItem disabled>No levels</DropdownMenuItem>}
              {thinkingLevels.map((candidate) => (
                <DropdownMenuItem key={candidate} onClick={() => void setThinkingLevel(candidate)}>
                  <span className="flex-1 capitalize">{candidate}</span>
                  {candidate === level && <Check className="size-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden text-muted-foreground hover:text-foreground lg:inline-flex"
          onClick={() => void compact()}
          disabled={status !== "ready" || busy}
          aria-label="Compact context"
          title="Compact context"
        >
          <Gauge className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden text-muted-foreground hover:text-foreground lg:inline-flex"
          onClick={() => void newSession()}
          disabled={status !== "ready"}
          aria-label="New session"
          title="New session"
        >
          <Plus className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "hidden text-muted-foreground hover:text-foreground xl:inline-flex",
            panelOpen && "bg-muted text-foreground",
          )}
          onClick={onTogglePanel}
          aria-label="Toggle activity panel"
        >
          <PanelRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings2 className="size-4" />
        </Button>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>Give this conversation a name you can find later.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            placeholder="Session title"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void renameSession(renameValue);
                setRenameOpen(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void renameSession(renameValue);
                setRenameOpen(false);
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
