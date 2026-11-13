import { useState } from "react";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  MessageSquare,
  PanelRight,
  Pencil,
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
  const thinkingLevels = useAppStore((state) => state.thinkingLevels);
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel);
  const renameSession = useAppStore((state) => state.renameSession);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const title = sessionTitle(session, session?.sessionId ? "Untitled session" : "New session");
  const level = session?.thinkingLevel ?? "off";

  return (
    <header aria-label="Session toolbar" className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-sidebar px-3 py-1">
      <div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
        {busy
          ? <LoaderCircle aria-label="Agent working" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          : <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
        <button
          type="button"
          onClick={() => {
            setRenameValue(session?.sessionName ?? "");
            setRenameOpen(true);
          }}
          aria-label={`Rename session: ${title}`}
          title={title}
          className="group flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate text-xs">{title}</span>
          <Pencil aria-hidden="true" className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </div>

      <div className="ml-auto flex min-w-0 max-w-full items-center gap-0.5">
        <button
          type="button"
          onClick={onOpenModels}
          aria-label={`Choose model: ${modelLabel(session?.model)}`}
          title="Choose model"
          className="flex h-7 min-w-0 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="max-w-36 truncate">{modelLabel(session?.model)}</span>
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Thinking level: ${level}`}
                title="Thinking level"
                className="h-7 shrink-0 gap-1 rounded px-2 text-[11px] text-muted-foreground hover:text-foreground"
              />
            }
          >
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

        <span aria-hidden="true" className="mx-1 h-4 shrink-0 border-l" />
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(
            "hidden size-7 rounded text-muted-foreground hover:text-foreground xl:inline-flex",
            panelOpen && "bg-muted text-foreground",
          )}
          onClick={onTogglePanel}
          aria-label="Toggle activity panel"
          aria-pressed={panelOpen}
          title="Toggle activity panel"
        >
          <PanelRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0 rounded text-muted-foreground hover:text-foreground"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings (Ctrl+,)"
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
