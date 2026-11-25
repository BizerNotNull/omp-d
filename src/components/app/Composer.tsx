import { useEffect, useEffectEvent, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ImagePlus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPathReferences } from "@/lib/omp/file-reference";
import { PromptTextarea } from "./PromptText";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import type { AvailableCommand, ImageContent } from "@/lib/omp/types";
import { ComposerStatus } from "./ComposerStatus";
import { AgentRequestCard } from "./AgentRequestCard";
import { BtwPanel } from "./BtwPanel";
import { SendButton } from "./SendButton";

function readImage(file: File): Promise<ImageContent | undefined> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const comma = dataUrl.indexOf(",");
      if (comma < 0) {
        resolve(undefined);
        return;
      }
      const mimeType = dataUrl.slice(5, dataUrl.indexOf(";")) || file.type || "image/png";
      resolve({ type: "image", mimeType, data: dataUrl.slice(comma + 1) });
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

const localCommands: AvailableCommand[] = [
  { name: "model", description: "Choose a model for this session", source: "builtin" },
  { name: "models", description: "Browse providers, roles, and models", source: "builtin" },
  { name: "settings", description: "Configure Oh My Pi and desktop preferences", source: "builtin" },
  { name: "usage", description: "Show provider plan usage", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Find a project session", input: { hint: "[session id or search]" }, source: "builtin" },
  { name: "restart", description: "Restart the current agent and resume its session", source: "builtin" },
  { name: "btw", description: "Ask a side question or open side question history", input: { hint: "[question]" }, source: "builtin" },
  {
    name: "goal", description: "Show the current goal or set an objective", source: "builtin",
    subcommands: [
      { name: "set", description: "Start a goal", usage: "<objective>" },
      { name: "show", description: "Show current goal details" },
      { name: "pause", description: "Pause the current goal" },
      { name: "resume", description: "Resume a paused goal" },
      { name: "drop", description: "Drop the current goal" },
    ],
  },
];

export function Composer({ onOpenModels, onOpenSettings, onOpenUsage, onResume, active }: {
  onOpenModels: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onResume: (query: string) => void;
  active: boolean;
}) {
  const draft = useAppStore((state) => state.draftText);
  const setDraft = useAppStore((state) => state.setDraftText);
  const images = useAppStore((state) => state.draftImages);
  const setImages = useAppStore((state) => state.setDraftImages);
  const submitting = useAppStore((state) => state.submitting);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const readingDroppedImages = useAppStore((state) => state.droppedImagesPending) > 0;
  const readDroppedImages = useAppStore((state) => state.readDroppedImages);
  const dropTargetRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const suggestionsRef = useRef<HTMLDivElement | null>(null);
  const lastEditorToken = useRef(0);

  const busy = useAppStore((state) => state.busy);
  const applyingPlan = useAppStore((state) => Boolean(state.statusMarks["ompd:plan-applying"]));
  const branching = useAppStore((state) => state.branching);
  const status = useAppStore((state) => state.status);
  const commands = useAppStore((state) => state.commands);
  const queue = useAppStore((state) => state.queue);
  const editorToken = useAppStore((state) => state.editorToken);
  const prompt = useAppStore((state) => state.prompt);
  const abort = useAppStore((state) => state.abort);
  const removeQueued = useAppStore((state) => state.removeQueued);
  const restart = useAppStore((state) => state.restart);
  const newSession = useAppStore((state) => state.newSession);

  const canDrop = active && !branching && (status === "ready" || status === "starting");
  const onNativeDrop = useEffectEvent((event: DragDropEvent) => {
    if (!canDrop || event.type === "leave") {
      setDraggingFiles(false);
      return;
    }
    const scale = window.devicePixelRatio;
    const hit = document.elementFromPoint(event.position.x / scale, event.position.y / scale);
    const overComposer = Boolean(hit && dropTargetRef.current?.contains(hit));
    setDraggingFiles(overComposer && event.type !== "drop");
    if (!overComposer || event.type !== "drop" || !event.paths.length) return;

    const paths: string[] = [];
    const imagePaths: string[] = [];
    for (const path of event.paths) {
      (/\.(?:png|jpe?g|gif|webp)$/i.test(path) ? imagePaths : paths).push(path);
    }
    insertFilePaths(paths);
    textareaRef.current?.focus({ preventScroll: true });
    if (imagePaths.length) void readDroppedImages(imagePaths);
  });

  useEffect(() => {
    if (!canDrop || !isTauri()) return;
    let disposed = false;
    const subscription = getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (!disposed) onNativeDrop(payload);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten?.());
      setDraggingFiles(false);
    };
  }, [canDrop]);

  useEffect(() => {
    if (active && (status === "ready" || status === "starting")) textareaRef.current?.focus();
  }, [active, status]);

  useEffect(() => {
    if (editorToken !== lastEditorToken.current) {
      lastEditorToken.current = editorToken;
      if (active) textareaRef.current?.focus();
    }
  }, [editorToken, active]);

  const commandQuery = /^\/(\S*?)(?:[ \t]+([^\s]*))?$/.exec(draft);
  const nameQuery = commandQuery?.[1].toLowerCase();
  const subcommandQuery = commandQuery?.[2]?.toLowerCase();
  const suggestions = useMemo(() => {
    if (nameQuery === undefined) return [];
    const matches: AvailableCommand[] = [];
    const seen = new Set<string>();
    for (const command of [...localCommands, ...commands]) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        if (seen.has(name) || name === "ompd-workspace" || name === "guided-goal") continue;
        seen.add(name);
        if (subcommandQuery === undefined) {
          if (name.toLowerCase().startsWith(nameQuery)) matches.push(name === command.name ? command : { ...command, name });
        } else if (name.toLowerCase() === nameQuery) {
          for (const subcommand of command.subcommands ?? []) {
            if (!subcommand.name.toLowerCase().startsWith(subcommandQuery)) continue;
            matches.push({
              name: `${name} ${subcommand.name}`,
              source: command.source,
              description: subcommand.description,
              input: subcommand.usage ? { hint: subcommand.usage } : undefined,
            });
          }
        }
      }
    }
    return matches;
  }, [commands, nameQuery, subcommandQuery]);

  useEffect(() => setSuggestionIndex(0), [nameQuery, subcommandQuery]);

  useEffect(() => {
    suggestionsRef.current?.children[suggestionIndex]?.scrollIntoView({ block: "nearest" });
  }, [suggestionIndex, suggestions]);

  const disabled = status !== "ready" || submitting || branching || readingDroppedImages || applyingPlan;
  const btwCommand = /^\/btw(?:\s|$)/.test(draft.trimStart());

  function submit(behavior?: "followUp") {
    if (disabled) return;
    const text = draft.trim();
    if (!text && !images.length) return;
    if (text === "/model" || text === "/models") {
      setDraft("");
      onOpenModels();
      return;
    }
    if (text === "/settings") {
      setDraft("");
      onOpenSettings();
      return;
    }
    if (text === "/usage") {
      setDraft("");
      onOpenUsage();
      return;
    }
    if (text === "/new") {
      setDraft("");
      void newSession();
      return;
    }
    const sessionSearch = /^\/resume(?:[\s:]+([\s\S]+))?$/.exec(text);
    if (sessionSearch) {
      setDraft("");
      onResume(sessionSearch[1]?.trim() ?? "");
      return;
    }
    textareaRef.current?.focus({ preventScroll: true });
    void prompt(behavior);
  }

  function chooseCommand(command: AvailableCommand) {
    if (command.name === "model" || command.name === "models" || command.name === "settings" || command.name === "usage") {
      setDraft("");
      if (command.name === "settings") onOpenSettings();
      else if (command.name === "usage") onOpenUsage();
      else onOpenModels();
      return;
    }
    setDraft(`/${command.name} `);
    textareaRef.current?.focus();
  }

  function insertFilePaths(paths: string[]) {
    if (!paths.length) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const references = formatPathReferences(paths);
    const { value, selectionStart, selectionEnd } = textarea;
    const before = selectionStart > 0 && /\S/.test(value[selectionStart - 1]) ? " " : "";
    const after = selectionEnd < value.length && /\S/.test(value[selectionEnd]) ? " " : "";
    textarea.setRangeText(`${before}${references}${after}`, selectionStart, selectionEnd, "end");
    setDraft(textarea.value);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map(readImage)).then((results) => {
      setImages((current) => [...current, ...results.filter((image): image is ImageContent => Boolean(image))]);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || branching) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && `/${suggestions[suggestionIndex]?.name}` === draft.trim()) {
      event.preventDefault();
      submit();
      return;
    }
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSuggestionIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !event.altKey)) {
        event.preventDefault();
        const command = suggestions[suggestionIndex];
        if (command) chooseCommand(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft("");
        return;
      }
    }
    if (event.key === "Escape" && busy) {
      event.preventDefault();
      void abort();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(event.altKey ? "followUp" : undefined);
    }
  }

  if (status !== "ready" && status !== "starting") {
    return (
      <div className="border-t bg-background/90 py-3 backdrop-blur">
        <div className="conversation-lane flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {status === "error"
              ? useAppStore.getState().error ?? "The agent failed to start."
              : status === "stopped"
                ? "The agent process is not running."
                : "Open a project to start a session."}
          </span>
          {(status === "stopped" || status === "error") && (
            <Button size="sm" onClick={() => void restart()}>
              Restart agent
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="z-10 bg-background pt-2 pb-3">
      <div className="conversation-lane">
        {(queue.steering.length > 0 || queue.followUp.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {queue.steering.map((message, index) => (
              <QueueChip
                key={`steer-${index}-${message}`}
                label="steering"
                message={message}
                live={index < (queue.liveSteered ?? 0)}
                disabled={branching}
                onRemove={() => void removeQueued(message, "steering")}
              />
            ))}
            {queue.followUp.map((message, index) => (
              <QueueChip
                key={`follow-${index}-${message}`}
                label="queued"
                message={message}
                disabled={branching}
                onRemove={() => void removeQueued(message, "followUp")}
              />
            ))}
          </div>
        )}

        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((image, index) => (
              <div key={index} className="group relative">
                <img
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt="attachment"
                  className="h-16 w-16 rounded-lg border object-cover"
                />
                <button
                  type="button"
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                  aria-label="Remove attachment"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <AgentRequestCard />
        <BtwPanel />

        <div className="relative">
          {suggestions.length > 0 && (
            <div className="anim-in absolute bottom-full mb-2 w-full overflow-hidden rounded-xl border bg-popover shadow-xl">
              <div className="border-b px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Slash commands
              </div>
              <div ref={suggestionsRef} className="max-h-64 overflow-y-auto p-1">
                {suggestions.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
                    disabled={disabled}
                    onMouseEnter={() => setSuggestionIndex(index)}
                    onClick={() => chooseCommand(command)}
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                      index === suggestionIndex ? "bg-muted text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span className="font-mono text-foreground/90">/{command.name}</span>
                    {command.input?.hint && <span className="font-mono text-[10px] text-muted-foreground/70">{command.input.hint}</span>}
                    <span className="truncate">{command.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            ref={dropTargetRef}
            className={cn(
              "rounded-2xl border border-border/80 bg-card shadow-[0_8px_30px_-12px_rgba(0,0,0,0.45)] focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/10",
              canDrop && draggingFiles && "border-ring ring-3 ring-ring/20",
            )}
          >
            <PromptTextarea
              ref={textareaRef}
              disabled={branching}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              placeholder={busy ? "Steer the agent — Enter sends now, Alt+Enter queues a follow-up" : "Ask Oh My Pi anything, or type / for commands"}
              className="max-h-52 min-h-11 resize-none border-0 bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center gap-1.5 px-2 pb-2">
              <span className="pl-1.5 text-[10px] text-muted-foreground/70">
                {canDrop && draggingFiles ? "Drop to reference files or attach images" : readingDroppedImages ? "Loading dropped images…" : status === "starting" ? "Starting omp… You can write while it loads." : busy ? "agent is working" : draft.startsWith("/") ? "slash command" : "Enter to send · Shift+Enter newline"}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                {images.length > 0 && (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <ImagePlus className="size-3" /> {images.length}
                  </span>
                )}
                {busy && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void abort()}
                    disabled={branching}
                    aria-label="Stop the agent"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Square className="size-3.5 fill-current" />
                  </Button>
                )}
                <SendButton
                  disabled={disabled || (!draft.trim() && images.length === 0)}
                  onClick={() => submit()}
                  pending={submitting || status === "starting"}
                >
                  {btwCommand ? draft.trim() === "/btw" ? "History" : "Ask" : busy ? "Steer" : "Send"}
                </SendButton>
              </div>
            </div>
          </div>
        </div>
        <ComposerStatus active={active} />
      </div>
    </div>
  );
}

function QueueChip({
  label,
  message,
  live,
  onRemove,
  disabled,
}: {
  label: string;
  message: string;
  live?: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex max-w-full items-center gap-1.5 rounded-full border bg-muted/40 py-1 pr-1 pl-2.5 text-[10px]">
      <span className="uppercase tracking-wide text-muted-foreground/80">{label}</span>
      {live && <span className="text-amber-500">live</span>}
      <span className="max-w-64 truncate text-foreground/80">{message}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove queued message"
        className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
