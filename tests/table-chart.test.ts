import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NumericTableChart, parseNumericTable } from "../src/components/app/NumericTableChart";

test("recognizes signed, grouped and fractional quantities without altering row order", () => {
  const data = parseNumericTable(["Model", "Change"], [["Beta", "−1,250.5"], ["Alpha", "+.25"], ["Gamma", "0"]]);
  expect(data).toEqual({
    labelHeader: "Model", labels: ["Beta", "Alpha", "Gamma"], unit: "",
    series: [{ name: "Change", values: [-1250.5, 0.25, 0], written: ["−1,250.5", "+.25", "0"] }],
  });
});

test("percentages stay percentage points, not fractions", () => {
  expect(parseNumericTable(["Model", "Share"], [["A", "25%"], ["B", "-5%"]])?.series[0].values).toEqual([25, -5]);
  expect(parseNumericTable(["Model", "Share (%)"], [["A", "25"], ["B", "50%"]])?.unit).toBe("%");
});

test("normalizes duration cells and header units across multiple series", () => {
  const data = parseNumericTable(["Model", "Before (s)", "After ms"], [["A", "1.5", "250"], ["B", "200 ms", "0.5 s"]]);
  expect(data?.unit).toBe("ms");
  expect(data?.series.map((entry) => entry.values)).toEqual([[1500, 200], [250, 500]]);
  expect(data?.series.map((entry) => entry.name)).toEqual(["Before (s)", "After ms"]);
});

test("distinguishes decimal and binary bytes and preserves original value labels", () => {
  const data = parseNumericTable(["Backend", "Size"], [["A", "1 KB"], ["B", "1 KiB"], ["C", "1.5 MB"]]);
  expect(data?.unit).toBe("B");
  expect(data?.series[0].values).toEqual([1000, 1024, 1500000]);
  expect(data?.series[0].written).toEqual(["1 KB", "1 KiB", "1.5 MB"]);
});

test("category column can follow the numeric series", () => {
  expect(parseNumericTable(["Count", "Model"], [["2", "A"], ["4", "B"]])?.labels).toEqual(["A", "B"]);
});

test("rejects mixed or ambiguous units rather than silently dropping values", () => {
  for (const rows of [
    [["A", "20%"], ["B", "20"]],
    [["A", "20 ms"], ["B", "20 MB"]],
    [["A", "20 ms"], ["B", "20"]],
    [["A", "20 kg"], ["B", "30 kg"]],
    [["A", "20 Mb"], ["B", "30 Mb"]],
  ]) expect(parseNumericTable(["Model", "Value"], rows)).toBeNull();
  expect(parseNumericTable(["Model", "Latency (ms)"], [["A", "20 MB"], ["B", "30 MB"]])).toBeNull();
  expect(parseNumericTable(["Model", "Duration", "Size"], [["A", "20 ms", "20 B"], ["B", "30 ms", "30 B"]])).toBeNull();
  expect(parseNumericTable(["Model", "Weight (kg)"], [["A", "20"], ["B", "30"]])).toBeNull();
  expect(parseNumericTable(["Model", "Requests/s"], [["A", "20"], ["B", "30"]])).toBeNull();
});

test("does not plot versions, IDs, dates, codes or metric-per-row tables", () => {
  for (const header of ["Version", "Issue ID", "ID", "Build", "Commit", "Port", "Rank", "Date", "Year", "#", "No."]) {
    expect(parseNumericTable(["Model", header], [["A", "12"], ["B", "13"]])).toBeNull();
  }
  for (const value of ["1.2.3", "v1.2", "0012", "2026-11-13", "#123", "12e4", "NaN", "Infinity", "9007199254740992"]) {
    expect(parseNumericTable(["Model", "Value"], [["A", value], ["B", "2"]])).toBeNull();
  }
  expect(parseNumericTable(["Metric", "Value"], [["CPU", "20"], ["RAM", "30"]])).toBeNull();
});

test("requires complete rectangular data, unique text labels and a nonzero comparison", () => {
  for (const rows of [
    [["A", "1"]],
    [["A", "1"], ["B"]],
    [["A", "1"], ["B", "2", "extra"]],
    [["A", "1"], ["A", "2"]],
    [["", "1"], ["B", "2"]],
    [["A", "0"], ["B", "0"]],
    [["A", "1"], ["B", "N/A"]],
    [["A", "1"], ["B", "1–2"]],
    [["A", "1"], ["B", "~2"]],
    [["A", "1"], ["B", "12,34"]],
    [["A", "1"], ["B", "2 (estimated)"]],
  ]) expect(parseNumericTable(["Model", "Value"], rows)).toBeNull();
  expect(parseNumericTable(["Value", "Other"], [["1", "2"], ["3", "4"]])).toBeNull();
  expect(parseNumericTable(["Model", "Value"], Array.from({ length: 25 }, (_, index) => [`Model ${index}`, "1"]))).toBeNull();
});

test("SVG is accessible, has negative baseline geometry and escapes untrusted labels", () => {
  const markup = renderToStaticMarkup(createElement(NumericTableChart, {
    headers: ["Model", "Before", "After"],
    rows: [["<script>alert(1)</script>", "-10", "20"], ["B", "5", "-5"]],
  }));
  expect(markup).toContain('role="img"');
  expect(markup).toContain("aria-labelledby=");
  expect(markup).toContain("<desc");
  expect(markup).toContain("&lt;script&gt;");
  expect(markup).not.toContain("<script>");
  const bars = [...markup.matchAll(/<rect x="([^"]+)" y="[^"]+" width="([^"]+)"/g)].map((match) => ({ x: Number(match[1]), width: Number(match[2]) }));
  expect(bars.every((bar) => bar.width > 0 && Number.isFinite(bar.x))).toBe(true);
  // The negative and positive first-row bars meet at the shared zero baseline.
  expect(bars[0].x + bars[0].width).toBeCloseTo(bars[1].x);
  expect(markup).not.toContain("NaN");
});

test("unsupported comparisons render nothing", () => {
  expect(renderToStaticMarkup(createElement(NumericTableChart, {
    headers: ["Name", "Version"], rows: [["A", "1.2.3"], ["B", "2.0.0"]],
  }))).toBe("");
});
