import type { AgentMessage, ImageContent, Model, TextContent, ToolCallContent } from "./types";

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: unknown[] = content;
  const parts: string[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) parts.push(block.text);
  }
  return parts.join("\n");
}

function isTextBlock(block: unknown): block is TextContent {
  if (!block || typeof block !== "object" || !("type" in block)) return false;
  return block.type === "text" && "text" in block && typeof block.text === "string";
}

export function messagePlainText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return contentText(message.content);
  return "";
}

export function isUserVisible(message: AgentMessage): boolean {
  if (message.role === "user" || message.role === "developer") {
    return message.synthetic !== true;
  }
  return true;
}

export function toolArgSummary(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const pick = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  switch (toolName) {
    case "bash":
    case "shell":
    case "eval": {
      const command = pick(["command", "code", "script"]) ?? "";
      return firstLine(command, 120);
    }
    case "read":
    case "write":
    case "edit":
    case "ast_edit":
    case "notebook":
      return pick(["path", "file_path", "file"]) ?? "";
    case "grep":
    case "find":
    case "glob":
    case "ast_grep":
      return pick(["pattern", "query", "prefix"]) ?? "";
    case "task":
      return pick(["description", "prompt", "task"]) ?? "";
    case "web_search":
      return pick(["query", "q"]) ?? "";
    case "todo":
      return pick(["op", "operation"]) ?? "";
    case "wait":
    case "vibe_wait":
      return pick(["timeout", "for", "name", "i"]) ?? "waiting for background work";
    default: {
      const direct = pick(["path", "command", "query", "pattern", "description", "url", "task", "i"]);
      if (direct) return firstLine(direct, 120);
      const json = JSON.stringify(args);
      return firstLine(json, 80);
    }
  }
}

export function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function modelLabel(model: Model | undefined): string {
  if (!model) return "No model";
  return model.name?.trim() || model.id;
}

export function formatTokens(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}

export function formatCost(value: number | undefined | null): string {
  if (value == null || Number.isNaN(value)) return "$0.00";
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Drop icon-font glyphs (private-use area) the desktop fonts cannot render. */
export function stripPrivateUse(text: string): string {
  return text
    .replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, "")
    .replace(/^\s+/, "")
    .trim();
}

export function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Remove terminal control sequences that would garble monospace output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function imageBlocks(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isImageBlock);
}

function isImageBlock(block: unknown): block is ImageContent {
  if (!block || typeof block !== "object" || !("type" in block)) return false;
  return block.type === "image" && "mimeType" in block && "data" in block;
}

export function toolCalls(content: unknown): ToolCallContent[] {
  if (!Array.isArray(content)) return [];
  const blocks: unknown[] = content;
  return blocks.filter((block): block is ToolCallContent => isToolCallBlock(block));
}

function isToolCallBlock(block: unknown): block is ToolCallContent {
  if (!block || typeof block !== "object" || !("type" in block)) return false;
  return block.type === "toolCall" && "id" in block && "name" in block;
}

export function toBase64DataUrl(image: ImageContent): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
