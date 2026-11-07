import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ArrowUp, CornerDownLeft, ImagePlus, LoaderCircle, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/omp/store";
import type { AvailableCommand, ImageContent } from "@/lib/omp/types";

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

export function Composer({ onOpenModels, active }: { onOpenModels: () => void; active: boolean }) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageContent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastEditorToken = useRef(0);
  const sendingRef = useRef(false);

  const busy = useAppStore((state) => state.busy);
  const status = useAppStore((state) => state.status);
  const commands = useAppStore((state) => state.commands);
  const queue = useAppStore((state) => state.queue);
  const editorText = useAppStore((state) => state.editorText);
  const editorToken = useAppStore((state) => state.editorToken);
  const prompt = useAppStore((state) => state.prompt);
  const abort = useAppStore((state) => state.abort);
  const removeQueued = useAppStore((state) => state.removeQueued);
  const restart = useAppStore((state) => state.restart);

  useEffect(() => {
    if (active && status === "ready") textareaRef.current?.focus();
  }, [active, status]);

  useEffect(() => {
    if (editorToken !== lastEditorToken.current && editorText) {
      lastEditorToken.current = editorToken;
      setDraft(editorText);
      if (active) textareaRef.current?.focus();
    }
  }, [editorText, editorToken, active]);

  const commandQuery = useMemo(() => {
    if (!draft.startsWith("/")) return undefined;
    const token = draft.slice(1).split(/\s/)[0] ?? "";
    if (draft.slice(1).includes(" ")) return undefined;
    return token;
  }, [draft]);

  const suggestions = useMemo(() => {
    if (commandQuery === undefined) return [];
    const query = commandQuery.toLowerCase();
    const available: AvailableCommand[] = [
      { name: "model", description: "Choose a model for this session", source: "builtin" },
      { name: "models", description: "Browse providers, roles, and models", source: "builtin" },
      ...commands.filter((command) => command.name !== "model" && command.name !== "models"),
    ];
    return available
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .slice(0, 8);
  }, [commands, commandQuery]);

  useEffect(() => setSuggestionIndex(0), [commandQuery]);

  const disabled = status !== "ready" || submitting;

  async function submit(behavior?: "steer" | "followUp") {
    if (disabled || sendingRef.current) return;
    const text = draft.trim();
    if (!text) return;
    if (text === "/model" || text === "/models") {
      setDraft("");
      onOpenModels();
      return;
    }
    sendingRef.current = true;
    setSubmitting(true);
    try {
      const sent = await prompt(draft, images.length ? images : undefined, busy ? behavior ?? "steer" : undefined);
      if (sent) {
        setDraft("");
        setImages([]);
      }
    } finally {
      sendingRef.current = false;
      setSubmitting(false);
      textareaRef.current?.focus();
    }
  }

  function chooseCommand(command: AvailableCommand) {
    if (command.name === "model" || command.name === "models") {
      setDraft("");
      onOpenModels();
      return;
    }
    setDraft(`/${command.name} `);
    textareaRef.current?.focus();
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
      void submit(event.altKey ? "followUp" : undefined);
    }
  }

  if (status !== "ready") {
    return (
      <div className="sticky bottom-0 border-t bg-background/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {status === "starting"
              ? "Starting omp…"
              : status === "error"
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
          {status === "starting" && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
        </div>
      </div>
    );
  }

  return (
    <div className="sticky bottom-0 z-10 bg-gradient-to-t from-background via-background to-background/0 px-4 pt-6 pb-3">
      <div className="mx-auto max-w-3xl">
        {(queue.steering.length > 0 || queue.followUp.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {queue.steering.map((message, index) => (
              <QueueChip
                key={`steer-${index}-${message}`}
                label="steering"
                message={message}
                live={index < (queue.liveSteered ?? 0)}
                onRemove={() => void removeQueued(message, "steering")}
              />
            ))}
            {queue.followUp.map((message, index) => (
              <QueueChip
                key={`follow-${index}-${message}`}
                label="queued"
                message={message}
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

        <div className="relative">
          {suggestions.length > 0 && (
            <div className="anim-in absolute bottom-full mb-2 w-full overflow-hidden rounded-xl border bg-popover shadow-xl">
              <div className="border-b px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Slash commands
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {suggestions.map((command, index) => (
                  <button
                    key={command.name}
                    type="button"
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

          <div className="rounded-2xl border border-border/80 bg-card shadow-[0_8px_30px_-12px_rgba(0,0,0,0.45)] focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/10">
            <Textarea
              ref={textareaRef}
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
                {busy ? "agent is working" : draft.startsWith("/") ? "slash command" : "Enter to send · Shift+Enter newline"}
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
                    aria-label="Stop the agent"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Square className="size-3.5 fill-current" />
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={disabled || (!draft.trim() && images.length === 0)}
                  onClick={() => void submit(undefined)}
                  className="gap-1.5"
                >
                  {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
                  {busy ? "Steer" : "Send"}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-2 px-1 text-[10px] text-muted-foreground/60">
          <CornerDownLeft className="size-2.5" />
          <span>Enter sends; Alt+Enter queues a follow-up; Esc stops a running turn.</span>
        </div>
      </div>
    </div>
  );
}

function QueueChip({
  label,
  message,
  live,
  onRemove,
}: {
  label: string;
  message: string;
  live?: boolean;
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
        aria-label="Remove queued message"
        className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
