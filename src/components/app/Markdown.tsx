import { memo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";

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

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: Link,
          table: ({ children, ...props }) => (
            <div className="my-3 overflow-x-auto rounded-lg border">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
