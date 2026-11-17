// Adapted from oh-my-pi's modes/magic-keywords and tui/prompt/markdown-prose.
// Presentation only: omp owns keyword settings, notices, and thinking effort.
const keywords = [
  { word: "ultrathink", hue: [0, 330] },
  { word: "chillax", hue: [180, 235], lightness: [62, 45] },
  { word: "orchestrate", hue: [150, 280] },
  { word: "workflowz", hue: [30, 150] },
  { word: "jevify", hue: [300, 420] },
] as const;

const keywordPattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)(${keywords.map(({ word }) => word).join("|")})(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`,
  "gu",
);
const fencePattern = /^( {0,3})([`~]{3,})/;
const tagName = /[A-Za-z][A-Za-z0-9-]*/y;

function tagAt(text: string, start: number) {
  const closing = text[start + 1] === "/";
  tagName.lastIndex = start + (closing ? 2 : 1);
  const match = tagName.exec(text);
  if (!match) return undefined;
  let quote = "";
  for (let i = tagName.lastIndex; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "<") {
      return undefined;
    } else if (char === ">") {
      return { name: match[0].toLowerCase(), end: i + 1, closing, selfClosing: text[i - 1] === "/" };
    }
  }
  return undefined;
}

function maskNonProse(text: string): string {
  if (!/[`<]/.test(text) && !text.includes("~~~")) return text;
  const masked = new Uint8Array(text.length);
  let fenceChar = "";
  let fenceLength = 0;
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end);
    const fence = fencePattern.exec(line);
    if (fenceChar) {
      masked.fill(1, start, end);
      if (fence && fence[2][0] === fenceChar && fence[2].length >= fenceLength
        && !line.slice(fence[1].length + fence[2].length).trim()) fenceChar = "";
    } else if (fence && !(fence[2][0] === "`" && line.slice(fence[1].length + fence[2].length).includes("`"))) {
      fenceChar = fence[2][0];
      fenceLength = fence[2].length;
      masked.fill(1, start, end);
    }
    if (newline < 0) break;
    start = end + 1;
  }
  for (let i = 0; i < text.length;) {
    if (masked[i]) { i++; continue; }
    if (text[i] === "`") {
      let runEnd = i + 1;
      while (text[runEnd] === "`") runEnd++;
      let close = -1;
      for (let j = runEnd; j < text.length;) {
        if (masked[j] || text[j] !== "`") { j++; continue; }
        let end = j + 1;
        while (text[end] === "`") end++;
        if (end - j === runEnd - i) { close = end; break; }
        j = end;
      }
      if (close >= 0) masked.fill(1, i, close);
      i = close >= 0 ? close : runEnd;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      const stop = end < 0 ? text.length : end + 3;
      masked.fill(1, i, stop);
      i = stop;
    } else if (text[i] === "<") {
      const tag = tagAt(text, i);
      if (!tag) { i++; continue; }
      let stop = tag.end;
      if (!tag.closing && !tag.selfClosing) {
        let depth = 1;
        for (let j = tag.end; j < text.length;) {
          if (masked[j] || text[j] !== "<") { j++; continue; }
          const next = tagAt(text, j);
          if (!next) { j++; continue; }
          if (next.name === tag.name) {
            if (next.closing) depth--;
            else if (!next.selfClosing) depth++;
            if (!depth) { stop = next.end; break; }
          }
          j = next.end;
        }
      }
      masked.fill(1, i, stop);
      i = stop;
    } else i++;
  }
  return text.split("").map((char, index) => masked[index] && char !== "\n" ? " " : char).join("");
}

export interface MagicKeywordRange {
  from: number;
  to: number;
  word: string;
}

export function magicKeywordRanges(text: string): MagicKeywordRange[] {
  if (!keywords.some(({ word }) => text.includes(word))) return [];
  return Array.from(maskNonProse(text).matchAll(keywordPattern), (match) => ({
    from: match.index,
    to: match.index + match[0].length,
    word: match[0],
  }));
}

export const magicKeywordGradients = Object.fromEntries(keywords.map((keyword) => {
  const lightness = "lightness" in keyword ? keyword.lightness : [62, 62];
  const stops = Array.from({ length: 14 }, (_, index) => {
    const t = index / 14;
    const hue = (keyword.hue[0] + t * (keyword.hue[1] - keyword.hue[0])) % 360;
    const light = lightness[0] + t * (lightness[1] - lightness[0]);
    return `hsl(${hue} 90% ${light}%)`;
  });
  return [keyword.word, `linear-gradient(90deg, ${[...stops, stops[0]].join(", ")})`];
}));
