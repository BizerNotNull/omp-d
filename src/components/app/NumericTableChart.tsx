import { useId } from "react";

type Dimension = "count" | "percent" | "duration" | "bytes";

interface Quantity {
  value: number;
  dimension: Dimension;
}

export interface NumericTableData {
  labelHeader: string;
  labels: string[];
  series: { name: string; values: number[]; written: string[] }[];
  unit: string;
}

// Deliberately whole-cell only: ranges, estimates, versions and prose are not measurements.
const QUANTITY = /^([+\-−]?)(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\.(\d+))\s*(%|ms|s|B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/;
const IDENTIFIER_HEADER = /(?:^|[\s_\-])(?:ids?|uuid|guid|versions?|ver|releases?|builds?|sha|hash|commits?|ports?|pid|index|idx|rank|codes?|zip|years?|dates?|timestamps?)(?:$|[\s_\-(])/i;
const UNITS: Record<string, { dimension: Dimension; factor: number }> = {
  "%": { dimension: "percent", factor: 1 },
  ms: { dimension: "duration", factor: 1 },
  s: { dimension: "duration", factor: 1000 },
  B: { dimension: "bytes", factor: 1 },
  kB: { dimension: "bytes", factor: 1000 },
  KB: { dimension: "bytes", factor: 1000 },
  MB: { dimension: "bytes", factor: 1e6 },
  GB: { dimension: "bytes", factor: 1e9 },
  TB: { dimension: "bytes", factor: 1e12 },
  KiB: { dimension: "bytes", factor: 1024 },
  MiB: { dimension: "bytes", factor: 1024 ** 2 },
  GiB: { dimension: "bytes", factor: 1024 ** 3 },
  TiB: { dimension: "bytes", factor: 1024 ** 4 },
};

function quantity(text: string, headerUnit?: string): Quantity | null {
  const match = QUANTITY.exec(text.trim());
  if (!match) return null;
  // Leading zeroes are codes more often than counts. Decimal zeroes are fine.
  if (match[2] && /^0\d/.test(match[2])) return null;
  const magnitude = Number(match[2] ? `${match[2].replaceAll(",", "")}${match[3] ? `.${match[3]}` : ""}` : `0.${match[4]}`);
  const unit = match[5] || headerUnit;
  const definition = unit ? UNITS[unit] : undefined;
  if (headerUnit && match[5] && UNITS[headerUnit].dimension !== UNITS[match[5]].dimension) return null;
  const value = (match[1] === "-" || match[1] === "−" ? -1 : 1) * magnitude * (definition?.factor ?? 1);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
  return { value, dimension: definition?.dimension ?? "count" };
}

/** Recognize only complete, rectangular category comparisons with one shared unit.
 * No values are silently discarded, no units are guessed from neighboring cells,
 * and ID/version columns are never plotted. The original table remains primary.
 */
export function parseNumericTable(headers: string[], rows: string[][]): NumericTableData | null {
  if (headers.length < 2 || headers.length > 5 || rows.length < 2 || rows.length > 24) return null;
  if (rows.some((row) => row.length !== headers.length) || headers.some((header) => !header.trim())) return null;
  const series: NumericTableData["series"] = [];
  let labelIndex = -1;
  let dimension: Dimension | undefined;
  for (let column = 0; column < headers.length; column++) {
    const header = headers[column].trim();
    const unitMatch = /(?:^|[\s(])(%|ms|s|B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\)?$/.exec(header);
    const cells = rows.map((row) => row[column].trim());
    const parsed = cells.map((cell) => quantity(cell, unitMatch?.[1]));
    if (parsed.every((cell) => cell !== null)) {
      if (IDENTIFIER_HEADER.test(header) || /^(?:#|no\.?)$/i.test(header)) return null;
      // Unknown parenthesized units (kg, requests/s, etc.) must not become counts.
      if (!unitMatch && (/\([^)]*\)$/.test(header) || header.includes("/"))) return null;
      const columnDimension = parsed[0]!.dimension;
      if (parsed.some((cell) => cell!.dimension !== columnDimension)) return null;
      if (dimension && dimension !== columnDimension) return null;
      dimension = columnDimension;
      series.push({ name: header, values: parsed.map((cell) => cell!.value), written: cells });
    } else {
      // Only one genuinely textual category column; partially numeric columns
      // are not labels, and metric-per-row tables may compare unrelated units.
      if (labelIndex !== -1 || parsed.some((cell) => cell !== null) || /^(?:metric|measure|statistic|stat)s?$/i.test(header)) return null;
      if (cells.some((cell) => !cell || cell.length > 120 || /^[-+−.\d]/.test(cell))) return null;
      labelIndex = column;
    }
  }
  if (labelIndex < 0 || series.length === 0 || rows.length * series.length > 64) return null;
  const labels = rows.map((row) => row[labelIndex].trim());
  if (new Set(labels).size !== labels.length) return null;
  if (!series.some((entry) => entry.values.some((value) => value !== 0))) return null;
  const unit = dimension === "duration" ? "ms" : dimension === "bytes" ? "B" : dimension === "percent" ? "%" : "";
  return { labelHeader: headers[labelIndex].trim(), labels, series, unit };
}

const COLORS = ["var(--figure-c1)", "var(--figure-c2)", "var(--figure-c3)", "var(--figure-c4)"];
const compact = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

function axisValue(value: number, unit: string): string {
  const magnitude = Math.abs(value);
  const text = magnitude !== 0 && (magnitude < 0.001 || magnitude >= 1e9) ? value.toExponential(2) : compact.format(value);
  return unit === "%" ? `${text}%` : `${text}${unit ? ` ${unit}` : ""}`;
}

export function NumericTableChart({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const id = useId();
  const data = parseNumericTable(headers, rows);
  if (!data) return null;
  const { labels, series, unit } = data;
  const values = series.flatMap((entry) => entry.values);
  const magnitude = Math.max(...values.map(Math.abs));
  // Scale in normalized space to keep even subnormal values and large signed
  // ranges from overflowing or losing the zero baseline.
  const lower = Math.min(0, ...values.map((value) => value / magnitude));
  const upper = Math.max(0, ...values.map((value) => value / magnitude));
  const left = 180;
  const plotWidth = 430;
  const x = (value: number) => left + (value / magnitude - lower) / (upper - lower) * plotWidth;
  const zero = x(0);
  const rowHeight = series.length * 23 + 14;
  const top = 22;
  const bottom = top + labels.length * rowHeight;
  const height = bottom + 38;
  const ticks = Array.from({ length: 5 }, (_, index) => lower + (upper - lower) * index / 4);
  const summary = labels.map((label, row) => `${label}: ${series.map((entry) => `${entry.name} ${entry.written[row]}`).join(", ")}`).join("; ");
  return (
    <figure className="numeric-table-chart" style={{ margin: "12px 0", color: "var(--foreground)" }}>
      <figcaption style={{ fontSize: 12, color: "var(--muted-foreground)", marginBottom: 8 }}>
        Numeric comparison{unit ? ` (${unit})` : ""} · {data.labelHeader}
      </figcaption>
      <div className="numeric-table-chart-legend" style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 12, marginBottom: 6 }}>
        {series.map((entry, index) => (
          <span key={index} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, background: COLORS[index], display: "inline-block" }} />
            {entry.name}
          </span>
        ))}
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg role="img" aria-labelledby={`${id}-title ${id}-description`} viewBox={`0 0 720 ${height}`} width="100%" style={{ display: "block", minWidth: 480, height: "auto", fontFamily: "inherit" }}>
          <title id={`${id}-title`}>{`Numeric comparison by ${data.labelHeader}`}</title>
          <desc id={`${id}-description`}>Grouped horizontal bars on a shared linear axis including zero{unit ? `, normalized to ${unit}` : ""}. {summary}</desc>
          {ticks.map((tick, index) => {
            const position = left + (tick - lower) / (upper - lower) * plotWidth;
            return (
              <g key={index} aria-hidden="true">
                <line x1={position} x2={position} y1={top - 8} y2={bottom} stroke="var(--border)" />
                <text x={position} y={bottom + 20} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">{axisValue(tick * magnitude, unit)}</text>
              </g>
            );
          })}
          <line aria-hidden="true" x1={zero} x2={zero} y1={top - 8} y2={bottom} stroke="var(--muted-foreground)" />
          {labels.map((label, row) => (
            <g key={row} aria-hidden="true">
              <text x={left - 12} y={top + row * rowHeight + (series.length * 23) / 2} dominantBaseline="middle" textAnchor="end" fontSize={12} fill="var(--foreground)">
                <title>{label}</title>{label.length > 24 ? `${label.slice(0, 23)}…` : label}
              </text>
              {series.map((entry, column) => {
                const value = entry.values[row];
                const position = x(value);
                const y = top + row * rowHeight + column * 23;
                return (
                  <g key={column}>
                    <rect x={Math.min(zero, position)} y={y} width={Math.abs(position - zero)} height={17} rx={2} fill={COLORS[column]}>
                      <title>{`${label} · ${entry.name}: ${entry.written[row]}`}</title>
                    </rect>
                    <text x={left + plotWidth + 12} y={y + 12} fontSize={11} fill="var(--foreground)">
                      <title>{entry.written[row]}</title>{entry.written[row].length > 15 ? `${entry.written[row].slice(0, 14)}…` : entry.written[row]}
                    </text>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
    </figure>
  );
}
