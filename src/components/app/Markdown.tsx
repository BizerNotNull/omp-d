import { createContext, memo, useContext, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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

function Link({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
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

function CodeFigure({ kind, source, start, end }: {
  kind: "svg" | "mermaid";
  source: string;
  start?: number;
  end?: number;
}) {
  const text = useContext(StreamingSource);
  let partial = false;
  if (text !== undefined) {
    const raw = text.slice(start ?? 0, end);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    partial = !marker || !new RegExp(`\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(raw.trimEnd());
  }
  const Figure = kind === "svg" ? SvgFigure : MermaidFigure;
  return <Figure source={source} streaming={partial} />;
}

const components: Components = {
  a: Link,
  pre: function CodeFence({ node, children, ...props }) {
    const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
    if (code?.type === "element") {
      const classes = String(code.properties.className ?? "").toLowerCase().split(/[ ,]+/);
      const kind = classes.includes("language-svg") ? "svg" : classes.includes("language-mermaid") ? "mermaid" : undefined;
      if (kind) {
        return (
          <CodeFigure
            kind={kind}
            source={nodeText(code).replace(/\n$/, "")}
            start={node?.position?.start.offset}
            end={node?.position?.end.offset}
          />
        );
      }
    }
    return <pre {...props}>{children}</pre>;
  },
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
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {text}
        </ReactMarkdown>
      </StreamingSource>
    </div>
  );
});
