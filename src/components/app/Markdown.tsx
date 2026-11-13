import { memo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { SvgFigure } from "./SvgFigure";
import { MermaidFigure } from "./MermaidFigure";
import { NumericTableChart } from "./NumericTableChart";

type MarkdownNode = { type: string; value?: string; tagName?: string; children?: MarkdownNode[] };

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

export const Markdown = memo(function Markdown({ text, className, streaming = false }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: Link,
          pre: ({ node, children, ...props }) => {
            const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
            if (code?.type === "element") {
              const classes = String(code.properties.className ?? "").toLowerCase();
              const source = nodeText(code).replace(/\n$/, "");
              const raw = text.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset ?? text.length);
              const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
              const closed = marker && new RegExp(`\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(raw.trimEnd());
              const partial = streaming && !closed;
              if (classes.split(/[ ,]+/).includes("language-svg")) return <SvgFigure source={source} streaming={partial} />;
              if (classes.split(/[ ,]+/).includes("language-mermaid")) return <MermaidFigure source={source} streaming={partial} />;
            }
            return <pre {...props}>{children}</pre>;
          },
          table: ({ node, children, ...props }) => {
            const [headers = [], ...rows] = node ? tableRows(node) : [];
            return (
              <>
                <div className="my-3 overflow-x-auto rounded-lg border">
                  <table {...props}>{children}</table>
                </div>
                {!streaming && <NumericTableChart headers={headers} rows={rows} />}
              </>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
