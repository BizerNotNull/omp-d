import { expect, test } from "bun:test";
import { closePartialSvg, writeFigure } from "../src/lib/omp/figures";
import { imageBlocks, toBase64DataUrl } from "../src/lib/omp/format";

test("streamed SVG closes open elements without completing partial attributes or entities", () => {
  expect(closePartialSvg('<svg viewBox="0 0 100 20"><g><text>hello')).toBe('<svg viewBox="0 0 100 20"><g><text>hello</text></g></svg>');
  expect(closePartialSvg('<svg><rect width="10')).toBe('<svg></svg>');
  expect(closePartialSvg('<svg><text>A &am')).toBe('<svg><text>A </text></svg>');
  expect(closePartialSvg('<svg><!-- pending')).toBe('<svg></svg>');
  expect(closePartialSvg('<svg><text><![CDATA[pending')).toBe('<svg><text></text></svg>');
  expect(closePartialSvg('<svg><text title="a > b">ok</text></svg>')).toBe('<svg><text title="a > b">ok</text></svg>');
  expect(closePartialSvg('<svg viewBox="')).toBeNull();
});

test("write figure preview follows file extensions and excludes device calls and errors", () => {
  expect(writeFigure("write", { path: "local://chart.SVG", content: "<svg/>" }, false)).toEqual({ lang: "svg", source: "<svg/>" });
  expect(writeFigure("write", { file_path: "D:\\diagrams\\flow.mmd", content: "graph LR; A-->B" }, false)?.lang).toBe("mermaid");
  expect(writeFigure("write", { path: "xd://tool.svg", content: "<svg/>" }, false)).toBeUndefined();
  expect(writeFigure("write", { path: "chart.svg", content: "<svg/>" }, true)).toBeUndefined();
  expect(writeFigure("write", { path: "chart.ts", content: "<svg/>" }, false)).toBeUndefined();
});

test("image blocks reject malformed payloads and retain raster/SVG bytes", () => {
  const svg = { type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" };
  expect(imageBlocks([svg, { type: "image", data: null, mimeType: "image/png" }])).toEqual([svg]);
  expect(toBase64DataUrl({ ...svg, type: "image" })).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  expect(toBase64DataUrl({ type: "image", mimeType: "image/png", data: "data:image/png;base64,AA==" })).toBe("data:image/png;base64,AA==");
});
