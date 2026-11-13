/** Complete a streaming SVG without ever adding it to the application DOM. */
export function closePartialSvg(source: string): string | null {
  const open: string[] = [];
  let rootSeen = false;
  let end = 0;
  let index = 0;
  for (;;) {
    const lt = source.indexOf("<", index);
    if (lt < 0) {
      const amp = source.lastIndexOf("&");
      end = amp >= index && !source.includes(";", amp) ? amp : source.length;
      break;
    }
    end = lt;
    const close = constructEnd(source, lt);
    if (close < 0) break;
    if (source.startsWith("</", lt)) {
      const name = source.slice(lt + 2, close - 1).trim();
      const at = open.lastIndexOf(name);
      if (at >= 0) open.length = at;
    } else if (source[lt + 1] !== "!" && source[lt + 1] !== "?") {
      const name = /^<([^\s/>]+)/.exec(source.slice(lt, close))?.[1];
      if (name) {
        if (source[close - 2] !== "/") open.push(name);
        if (!rootSeen && name === "svg") rootSeen = true;
      }
    }
    index = close;
    end = close;
  }
  if (!rootSeen) return null;
  let document = source.slice(0, end);
  for (let at = open.length - 1; at >= 0; at--) document += `</${open[at]}>`;
  return document;
}

function constructEnd(source: string, lt: number): number {
  const after = (terminator: string, from: number): number => {
    const at = source.indexOf(terminator, from);
    return at < 0 ? -1 : at + terminator.length;
  };
  if (source.startsWith("<!--", lt)) return after("-->", lt + 4);
  if (source.startsWith("<![CDATA[", lt)) return after("]]>", lt + 9);
  if (source.startsWith("<?", lt)) return after("?>", lt + 2);
  let quote: string | undefined;
  let subset = false;
  for (let at = lt + 1; at < source.length; at++) {
    const char = source[at];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" && source[lt + 1] === "!") subset = true;
    else if (char === "]") subset = false;
    else if (char === ">" && !subset) return at + 1;
  }
  return -1;
}

/** Only ordinary file writes have the TUI's under-card figure preview. */
export function writeFigure(name: string, args: Record<string, unknown> | undefined, isError: boolean) {
  if (name !== "write" || isError || !args) return undefined;
  const path = typeof args.file_path === "string" ? args.file_path : args.path;
  if (typeof path !== "string" || (path.includes("://") && !path.startsWith("local://"))) return undefined;
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase();
  const lang = extension === "svg" ? "svg" : extension === "mmd" || extension === "mermaid" ? "mermaid" : undefined;
  if (!lang || typeof args.content !== "string" || !args.content.trim()) return undefined;
  return { lang, source: args.content };
}
