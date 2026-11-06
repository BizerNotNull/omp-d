import { useState } from "react";
import { Archive, Brain, ChevronDown, Scissors, Sparkles, SquareTerminal, User } from "lucide-react";
import type { AgentMessage, AssistantMessage, ThinkingContent, ToolCallContent, ToolResultMessage } from "@/lib/omp/types";
import { useAppStore, type ToolRun } from "@/lib/omp/store";
import {
  contentText,
  firstLine,
  formatCost,
  formatTokens,
  imageBlocks,
  isUserVisible,
  messagePlainText,
  toBase64DataUrl,
  toolCalls,
} from "@/lib/omp/format";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

export function Transcript({
  messages,
  pending,
}: {
  messages: AgentMessage[];
  pending: Array<{ messageId: string; message: AgentMessage }>;
}) {
  const toolRuns = useAppStore((state) => state.toolRuns);
  const all = [...messages, ...pending.map((entry) => entry.message)];

  const results = new Map<string, ToolResultMessage>();
  const callIds = new Set<string>();
  for (const message of all) {
    if (isToolResult(message)) results.set(message.toolCallId, message);
    if (isAssistant(message)) {
      for (const call of toolCalls(message.content)) callIds.add(call.id);
    }
  }

  const items = all.map((message, index) => {
    const key = `${index}:${message.role}:${typeof message.timestamp === "number" ? message.timestamp : ""}`;
    if (message.role === "user" || message.role === "developer") {
      if (!isUserVisible(message)) return null;
      return <UserBubble key={key} message={message} />;
    }
    if (isAssistant(message)) {
      const streaming = pending.some((entry) => entry.message === message);
      return (
        <AssistantBlock key={key} message={message} results={results} toolRuns={toolRuns} streaming={streaming} />
      );
    }
    if (isToolResult(message)) {
      if (callIds.has(message.toolCallId)) return null;
      return (
        <div key={key} className="pl-10">
          <ToolCard result={message} run={toolRuns[message.toolCallId]} />
        </div>
      );
    }
    return <SystemNote key={key} message={message} />;
  });

  return <div className="flex flex-col gap-1">{items}</div>;
}

function UserBubble({ message }: { message: AgentMessage }) {
  const text = messagePlainText(message);
  const images = imageBlocks(message.content);
  const agentAttributed = message.attribution === "agent";
  return (
    <div className="anim-in group ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {agentAttributed ? "agent" : "you"}
        <User className="size-3" />
      </div>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((image, index) => (
            <img
              key={index}
              src={toBase64DataUrl(image)}
              alt="attachment"
              className="max-h-48 rounded-lg border object-contain"
            />
          ))}
        </div>
      )}
      {text && (
        <div className="rounded-2xl rounded-tr-md border border-border/70 bg-secondary/70 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-secondary-foreground shadow-sm">
          <div className="break-words whitespace-pre-wrap">{text}</div>
        </div>
      )}
    </div>
  );
}

function AssistantBlock({
  message,
  results,
  toolRuns,
  streaming,
}: {
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  toolRuns: Record<string, ToolRun>;
  streaming: boolean;
}) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const hasVisible = blocks.some(
    (block) => block.type === "text" || block.type === "thinking" || block.type === "toolCall",
  );
  const hasProse = blocks.some(
    (block) =>
      (block.type === "text" && "text" in block && String(block.text ?? "").trim()) ||
      (block.type === "thinking" && "thinking" in block && String(block.thinking ?? "").trim()),
  );
  const usage = message.usage;
  const error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;

  return (
    <div className="anim-in flex gap-3 py-2">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-card text-[11px] font-semibold text-muted-foreground">
        π
      </div>
      <div className="min-w-0 flex-1">
        {!hasVisible && streaming && (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <span className="inline-flex gap-1">
              <span className="dot-bounce size-1.5 rounded-full bg-current" />
              <span className="dot-bounce size-1.5 rounded-full bg-current [animation-delay:120ms]" />
              <span className="dot-bounce size-1.5 rounded-full bg-current [animation-delay:240ms]" />
            </span>
            Thinking…
          </div>
        )}

        {blocks.map((block, index) => {
          if (block.type === "text") {
            const text = "text" in block && typeof block.text === "string" ? block.text : "";
            if (!text) return null;
            if (streaming) {
              return (
                <div key={index} className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
                  {text}
                  <span className="stream-caret" />
                </div>
              );
            }
            return <Markdown key={index} text={text} />;
          }
          if (block.type === "thinking") {
            const thinking = block as ThinkingContent;
            return <ThinkingBlock key={index} block={thinking} />;
          }
          if (block.type === "toolCall") {
            const call = block as ToolCallContent;
            return <ToolCard key={call.id ?? index} call={call} result={results.get(call.id)} run={toolRuns[call.id]} />;
          }
          const [image] = imageBlocks([block]);
          if (image) {
            return (
              <img
                key={index}
                src={toBase64DataUrl(image)}
                alt="assistant output"
                className="my-2 max-h-80 rounded-lg border object-contain"
              />
            );
          }
          return null;
        })}

        {error && (
          <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {hasProse && (message.model || usage) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-foreground/70">
            <span>{message.model ?? "assistant"}</span>
            {!streaming && typeof message.duration === "number" && (
              <span>· {(message.duration / 1000).toFixed(1)}s</span>
            )}
            {!streaming && usage && <span>· {formatTokens(usage.totalTokens)} tok</span>}
            {!streaming && usage?.cost?.total !== undefined && usage.cost.total > 0 && (
              <span>· {formatCost(usage.cost.total)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ block }: { block: ThinkingContent }) {
  const [open, setOpen] = useState(false);
  const text = block.thinking ?? "";
  if (!text.trim()) return null;
  return (
    <div className="my-1.5 rounded-lg border border-border/60 bg-muted/25">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Brain className="size-3.5" />
        <span className="italic">{block.narration ? "Narration" : "Thinking"}</span>
        <span className="text-muted-foreground/50">{formatTokens(text.length / 4)} tk</span>
        <ChevronDown className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t px-3 py-2 text-[12px] italic leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}

function SystemNote({ message }: { message: AgentMessage }) {
  const role = message.role;
  if (role === "custom" && message.display === false) return null;
  const text = contentText(message.content) || messagePlainText(message);
  const customType = typeof message.customType === "string" ? message.customType : undefined;
  const label =
    role === "compactionSummary"
      ? "Context compacted"
      : role === "branchSummary"
        ? "Branch summary"
        : role === "bashExecution"
          ? "Shell"
          : role === "pythonExecution"
            ? "Python"
            : customType ?? role;
  if (!text && role !== "compactionSummary") return null;

  if (role === "bashExecution" || role === "pythonExecution") {
    return (
      <div className="my-2 pl-10">
        <div className="rounded-lg border bg-muted/30">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            <SquareTerminal className="size-3.5" /> {label}
          </div>
          <pre className="scroll-thin max-h-72 overflow-auto p-2.5 font-mono text-[11px] whitespace-pre-wrap">
            {text}
          </pre>
        </div>
      </div>
    );
  }
  if (role === "compactionSummary" || role === "branchSummary") {
    return (
      <div className="my-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <div className="h-px flex-1 bg-border/60" />
        {role === "compactionSummary" ? <Scissors className="size-3" /> : <Archive className="size-3" />}
        <span>{label}</span>
        <div className="h-px flex-1 bg-border/60" />
      </div>
    );
  }
  if (role === "custom") {
    return (
      <div className="my-2 pl-10">
        <div className="rounded-lg border border-dashed bg-card/40 px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3" /> {firstLine(label, 40)}
          </div>
          {text && <div className="text-xs break-words whitespace-pre-wrap text-foreground/80">{text}</div>}
        </div>
      </div>
    );
  }
  return null;
}

export function TranscriptEmpty() {
  return (
    <div className="grid-bg relative flex min-h-[50vh] flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 p-10">
      <div className="relative z-10 max-w-md text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-card text-xl font-semibold shadow-sm">
          π
        </div>
        <h2 className="text-lg font-medium tracking-tight">Oh My Pi, with a window</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          The same agent runtime as <span className="font-mono text-xs">omp</span> — sessions, tools, todos and
          background work stay on disk.
        </p>
        <div className="mt-5 grid gap-2 text-left text-xs text-muted-foreground">
          <Suggestion text="Explain this repository and its architecture" />
          <Suggestion text="Find a bug and fix it, then run the tests" />
          <Suggestion text="Review my uncommitted changes" />
        </div>
      </div>
    </div>
  );
}

function Suggestion({ text }: { text: string }) {
  const setEditorText = useAppStore((state) => state.setEditorText);
  return (
    <button
      type="button"
      onClick={() => setEditorText(text)}
      className="group flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-2 text-left transition-colors hover:border-border hover:bg-card"
    >
      <Sparkles className="size-3.5 text-muted-foreground group-hover:text-foreground" />
      <span>{text}</span>
    </button>
  );
}
