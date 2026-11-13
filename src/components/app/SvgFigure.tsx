import { memo, useEffect, useMemo, useState } from "react";
import { closePartialSvg } from "@/lib/omp/figures";

const TOKENS: Record<string, string> = {
  fg: "--foreground", muted: "--muted-foreground", border: "--border", surface: "--secondary",
  accent: "--primary", success: "--figure-success", warning: "--figure-warning", error: "--destructive",
  c1: "--figure-c1", c2: "--figure-c2", c3: "--figure-c3", c4: "--figure-c4", c5: "--figure-c5", c6: "--figure-c6",
};

function imageSource(source: string): string | undefined {
  // SVG-as-image disables scripts, event handlers and external resources.
  // Never mount the parsed document or use dangerouslySetInnerHTML here.
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return undefined;
  const namespaced = source.replace(/<svg(?=[\s/>])[^>]*>/, (tag) => {
    const xmlns = /\sxmlns\s*=/.test(tag) ? "" : ' xmlns="http://www.w3.org/2000/svg"';
    const xlink = source.includes("xlink:") && !/\sxmlns:xlink\s*=/.test(tag) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : "";
    return tag.replace("<svg", `<svg${xmlns}${xlink}`);
  });
  const doc = new DOMParser().parseFromString(namespaced, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg" || doc.querySelector("parsererror")) return undefined;
  const theme = getComputedStyle(document.documentElement);
  for (const [name, token] of Object.entries(TOKENS)) root.style.setProperty(`--${name}`, theme.getPropertyValue(token).trim());
  if (!root.hasAttribute("color")) root.setAttribute("color", "var(--fg)");
  if (!root.hasAttribute("font-family")) root.setAttribute("font-family", "sans-serif");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

export const SvgFigure = memo(function SvgFigure({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const [epoch, setEpoch] = useState(0);
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    const observer = new MutationObserver(() => setEpoch((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, []);
  const src = useMemo(() => {
    const document = streaming ? closePartialSvg(source) : source;
    return document ? imageSource(document) : undefined;
  }, [source, streaming, epoch]);
  if (!src || failed === src) return <pre><code className="language-svg">{source}</code></pre>;
  return <img src={src} alt="SVG figure" className="my-3 block h-auto max-w-full" onError={() => setFailed(src)} />;
});
