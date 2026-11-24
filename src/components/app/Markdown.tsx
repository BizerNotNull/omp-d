import { createContext, memo, useContext, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import { defaultHandlers } from "mdast-util-to-hast";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { SvgFigure } from "./SvgFigure";
import { MermaidFigure } from "./MermaidFigure";
import { NumericTableChart } from "./NumericTableChart";

type MarkdownNode = { type: string; value?: string; tagName?: string; children?: MarkdownNode[] };

// The synchronous transformer owns a reusable syntax grammar registry.
const highlight = rehypeHighlight();
const rehypePlugins = [() => highlight];
const remarkPlugins = [remarkGfm, remarkBreaks];
const StreamingSource = createContext<string | undefined>(undefined);
const ParsedMarkdown = memo(ReactMarkdown);

const remarkRehypeOptions: Options["remarkRehypeOptions"] = {
  handlers: {
    code(state, node) {
      if (node.type !== "code") return undefined;
      const fence = defaultHandlers.code(state, node);
      // Plain code fences don't need ReactMarkdown to retain their HAST subtree.
      const [code] = fence.children;
      const classes = String(code?.type === "element" ? code.properties.className ?? "" : "").toLowerCase().split(/[ ,]+/);
      if (classes.includes("language-svg")) fence.tagName = "omp-svg-fence";
      else if (classes.includes("language-mermaid")) fence.tagName = "omp-mermaid-fence";
      return fence;
    },
  },
};

function nodeText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(nodeText).join("") ?? "";
}

function tableRows(node: MarkdownNode): string[][] {
  const rows: string[][] = [];
  function visit(current: MarkdownNode) {
    if (current.tagName === "tr") rows.push((current.children ?? []).filter((cell) => cell.tagName === "td" || cell.tagName === "th").map(nodeText));
    else current.children?.forEach(visit);
  }
  visit(node);
  return rows;
}

function Link({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (!href) return;
        void openUrl(href).catch(() => setFailed(true));
      }}
      className={cn("underline underline-offset-2 hover:text-foreground", failed && "text-destructive")}
    >
      {children}
    </a>
  );
}

function CodeFigure({ node }: ExtraProps) {
  const text = useContext(StreamingSource);
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (!code) return null;
  let partial = false;
  if (text !== undefined) {
    const raw = text.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    partial = !marker || !new RegExp(`\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(raw.trimEnd());
  }
  const Figure = node?.tagName === "omp-svg-fence" ? SvgFigure : MermaidFigure;
  return <Figure source={nodeText(code).replace(/\n$/, "")} streaming={partial} />;
}

const components: Components & Record<"omp-svg-fence" | "omp-mermaid-fence", typeof CodeFigure> = {
  a: Link,
  "omp-svg-fence": CodeFigure,
  "omp-mermaid-fence": CodeFigure,
  table: function Table({ node, children, ...props }) {
    const streaming = useContext(StreamingSource) !== undefined;
    const [headers = [], ...rows] = node && !streaming ? tableRows(node) : [];
    return (
      <>
        <div className="my-3 overflow-x-auto rounded-lg border">
          <table {...props}>{children}</table>
        </div>
        {!streaming && <NumericTableChart headers={headers} rows={rows} />}
      </>
    );
  },
};

export const Markdown = memo(function Markdown({ text, className, streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cn("chat-markdown", className)}>
      <StreamingSource value={streaming ? text : undefined}>
        <ParsedMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          remarkRehypeOptions={remarkRehypeOptions}
          components={components}
        >
          {text}
        </ParsedMarkdown>
      </StreamingSource>
    </div>
  );
});
