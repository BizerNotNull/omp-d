import { memo, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  Clock,
  FileCode2,
  FileText,
  Globe,
  HelpCircle,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ToolCallContent, ToolResultMessage } from "@/lib/omp/types";
import type { ToolRun } from "@/lib/omp/store";
import { imageBlocks, stripAnsi, toolArgSummary, truncate } from "@/lib/omp/format";
import { writeFigure } from "@/lib/omp/figures";
import { ContentImage } from "./ContentImage";
import { SvgFigure } from "./SvgFigure";
import { MermaidFigure } from "./MermaidFigure";

function iconForTool(name: string): ReactNode {
  const className = "size-3.5 shrink-0";
  switch (name) {
    case "bash":
    case "shell":
    case "eval":
    case "run":
      return <Terminal className={className} />;
    case "read":
      return <FileText className={className} />;
    case "write":
    case "edit":
    case "ast_edit":
    case "notebook":
      return <Pencil className={className} />;
    case "grep":
    case "glob":
    case "find":
    case "ast_grep":
    case "security_scan":
      return <Search className={className} />;
    case "web_search":
    case "browser":
    case "fetch":
      return <Globe className={className} />;
    case "todo":
    case "python":
    case "debug":
      return <FileCode2 className={className} />;
    case "task":
      return <Bot className={className} />;
    case "yield":
    case "resolve":
      return <Sparkles className={className} />;
    case "ask":
    case "questionnaire":
      return <HelpCircle className={className} />;
    case "wait":
    case "vibe_wait":
      return <Clock className={className} />;
    default:
      return <Wrench className={className} />;
  }
}

function StatusMark({ status }: { status: ToolRun["status"] | "pending" }) {
  if (status === "running") {
    return <LoaderCircle className="size-3.5 animate-spin text-amber-500" aria-label="running" />;
  }
  if (status === "error") {
    return <AlertCircle className="size-3.5 text-destructive" aria-label="failed" />;
  }
  if (status === "success") {
    return <Check className="size-3.5 text-emerald-500" aria-label="succeeded" />;
  }
  return <CircleDashed className="size-3.5 text-muted-foreground" aria-label="queued" />;
}

function detailsDiff(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || !("diff" in details)) return undefined;
  const diff = details.diff;
  return typeof diff === "string" && diff.trim() ? diff : undefined;
}

function detailsText(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const candidate = JSON.stringify(details, null, 2);
  if (!candidate || candidate === "{}") return undefined;
  return truncate(candidate, 3000);
}

function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const limit = 2000;
  const shown = lines.length > limit ? lines.slice(0, limit) : lines;
  return (
    <pre className="scroll-thin max-h-80 overflow-auto rounded-md border bg-zinc-950/70 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-300">
      {shown.map((line, index) => {
        const add = line.startsWith("+");
        const remove = line.startsWith("-");
        const hunk = line.startsWith("@@");
        return (
          <div
            key={index}
            className={cn(
              add && "text-emerald-400",
              remove && "text-rose-400",
              hunk && "text-sky-400",
            )}
          >
            {line || " "}
          </div>
        );
      })}
      {lines.length > limit && (
        <div className="pt-1 text-muted-foreground">… {lines.length - limit} more lines truncated for display</div>
      )}
    </pre>
  );
}

export const ToolCard = memo(function ToolCard({
  call,
  result,
  run,
}: {
  call?: ToolCallContent;
  result?: ToolResultMessage;
  run?: ToolRun;
}) {
  const name = call?.name ?? result?.toolName ?? run?.toolName ?? "tool";
  const args = call?.arguments ?? run?.args;
  const summary = useMemo(() => toolArgSummary(name, args), [name, args]);
  const rawOutput = result ? outputText(result) : run?.output;
  const output = rawOutput ? stripAnsi(rawOutput) : undefined;
  const details = result?.details ?? run?.details;
  const diff = detailsDiff(details);
  const status: ToolRun["status"] | "pending" = run?.status ?? (result ? (result.isError ? "error" : "success") : "pending");
  const [expanded, setExpanded] = useState(status === "error");
  const [showDetails, setShowDetails] = useState(false);

  const preview = useMemo(() => output?.slice(0, 1400), [output]);
  const displayOutput = useMemo(() => {
    if (!output) return undefined;
    const limit = 24_000;
    return output.length > limit
      ? `${output.slice(0, limit)}\n… [${output.length - limit} characters truncated; use Copy to get the full output]`
      : output;
  }, [output]);
  const detailsPreview = useMemo(() => (showDetails ? detailsText(details) : undefined), [showDetails, details]);
  const hasDetails = Boolean(details && typeof details === "object" && Object.keys(details).length > 0);
  const images = result ? imageBlocks(result.content) : run?.images ?? [];
  const figure = writeFigure(name, args, status === "error");

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-xl border bg-card/70 transition-colors",
        status === "error" ? "border-destructive/40" : "border-border/80",
        status === "running" && "border-amber-500/30",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        <span className={cn("flex size-6 items-center justify-center rounded-md bg-muted", status === "error" && "bg-destructive/10")}>
          {iconForTool(name)}
        </span>
        <span className="font-mono text-[11px] font-medium tracking-tight text-foreground/90">{name}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{summary}</span>
        ) : (
          <span className="flex-1" />
        )}
        <StatusMark status={status} />
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>

      {!expanded && preview && (
        <div className="border-t bg-background/60 px-3 py-2">
          <pre className="scroll-thin max-h-24 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
            {preview}
          </pre>
        </div>
      )}

      {expanded && (
        <div className="anim-in space-y-2 border-t bg-background/60 px-3 py-2.5">
          {call?.intent && <p className="text-[11px] text-muted-foreground">{call.intent}</p>}
          {name === "bash" && typeof args?.command === "string" && (
            <div className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px] text-foreground/90">
              <span className="mr-1.5 text-emerald-500">$</span>
              <span className="whitespace-pre-wrap break-words">{args.command}</span>
            </div>
          )}
          {diff ? (
            <DiffBlock diff={diff} />
          ) : displayOutput ? (
            <div className="space-y-1">
              <pre className="scroll-thin max-h-96 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                {displayOutput}
              </pre>
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => void navigator.clipboard.writeText(output ?? "")}
              >
                Copy output
              </button>
            </div>
          ) : status === "running" ? (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Working…
            </p>
          ) : null}


          {!diff && hasDetails && (
            <div>
              <button
                type="button"
                className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                onClick={() => setShowDetails((value) => !value)}
              >
                {showDetails ? "Hide details" : "Details"}
              </button>
              {showDetails && (
                <pre className="scroll-thin mt-1 max-h-64 overflow-auto rounded-md border bg-muted/20 p-2 font-mono text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
                  {detailsPreview ?? "No details"}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      {(images.length > 0 || figure) && (
        <div className="space-y-2 border-t bg-background/60 px-3 py-2.5">
          {images.map((image, index) => <ContentImage key={index} image={image} alt="tool output" />)}
          {figure?.lang === "svg" && <SvgFigure source={figure.source} streaming={status === "running" || status === "pending"} />}
          {figure?.lang === "mermaid" && <MermaidFigure source={figure.source} streaming={status === "running" || status === "pending"} />}
        </div>
      )}
    </div>
  );
});

function outputText(result: ToolResultMessage): string | undefined {
  const text = result.content
    ?.filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("");
  return text?.trim() ? text : undefined;
}
