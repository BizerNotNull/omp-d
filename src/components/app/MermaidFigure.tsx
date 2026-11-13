import { useEffect, useState } from "react";

let renderQueue: Promise<void> = Promise.resolve();
let nextDiagramId = 0;

type DiagramImage = {
  source: string;
  dark: boolean;
  url: string | null;
};

export function MermaidFigure({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  const [image, setImage] = useState<DiagramImage | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => setDark(root.classList.contains("dark"));
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    updateTheme();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A syntactically valid prefix can still be an unfinished diagram. Wait for
    // the caller to mark the fence complete rather than guessing from parsing.
    if (streaming || !source.trim()) return;

    const render = async () => {
      // Keep the heavy renderer out of the initial transcript bundle.
      if (cancelled) return;
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;

      // Initialization is global, so serialize it together with rendering.
      // Lock these keys against per-diagram init directives/frontmatter too.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        theme: dark ? "dark" : "default",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        secure: [
          "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
          "suppressErrorRendering", "htmlLabels", "flowchart", "theme",
          "themeVariables", "themeCSS", "fontFamily", "dompurifyConfig",
        ],
      });

      // Mermaid needs connected SVG nodes for text/layout measurements. Its
      // strict renderer owns this inert scratch tree; React only displays an img.
      const container = document.createElement("div");
      container.className = "pointer-events-none fixed -left-[100000px] top-0 w-[1200px] opacity-0";
      container.setAttribute("aria-hidden", "true");
      container.inert = true;
      document.body.appendChild(container);
      try {
        const { svg } = await mermaid.render(`ompd-mermaid-${++nextDiagramId}`, source, container);
        if (!cancelled) {
          setImage({ source, dark, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
        }
      } finally {
        // Also remove Mermaid's temporary/error nodes when rendering rejects.
        container.remove();
      }
    };

    const pending = renderQueue.then(render);
    renderQueue = pending.catch(() => {
      if (!cancelled) setImage({ source, dark, url: null });
    });
    return () => { cancelled = true; };
  }, [source, streaming, dark]);

  const currentImage = !streaming && image?.source === source && image.dark === dark ? image : null;
  if (currentImage?.url) {
    return (
      <figure className="my-3 overflow-x-auto rounded-lg border bg-background p-3">
        <img
          src={currentImage.url}
          alt="Mermaid diagram"
          className="mx-auto block h-auto max-w-full"
          onError={() => setImage({ source, dark, url: null })}
        />
      </figure>
    );
  }

  return (
    <figure className="my-3 overflow-hidden rounded-lg border">
      {currentImage && (
        <figcaption className="border-b px-3 py-2 text-xs text-muted-foreground">
          Unable to render diagram; showing Mermaid source.
        </figcaption>
      )}
      <pre className="m-0 overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed">
        <code className="language-mermaid">{source}</code>
      </pre>
    </figure>
  );
}
