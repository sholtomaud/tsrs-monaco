// The `plot` global: user code describes line series, the run worker
// normalises them into plain data, and the page renders them as SVG.

export type Point = [number, number];

export interface Series {
  name?: string;
  /** [x, y] pairs, or y values plotted against their index. */
  points: Point[] | number[];
}

export interface PlotOptions {
  title?: string;
  xLabel?: string;
  yLabel?: string;
}

export interface Chart {
  title: string;
  xLabel: string;
  yLabel: string;
  series: { name: string; points: Point[] }[];
}

export function toChart(series: Series | Series[], options: PlotOptions = {}): Chart {
  const list = Array.isArray(series) ? series : [series];
  return {
    title: String(options.title ?? ''),
    xLabel: String(options.xLabel ?? ''),
    yLabel: String(options.yLabel ?? ''),
    series: list.map((s, i) => {
      if (!s || !Array.isArray(s.points)) {
        throw new TypeError('plot() expects { points: [x, y][] | number[] }');
      }
      const points = (s.points as (Point | number)[]).map((p, j): Point =>
        typeof p === 'number' ? [j, p] : [Number(p[0]), Number(p[1])]
      );
      return {
        name: String(s.name ?? `series ${i + 1}`),
        points: points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
      };
    }),
  };
}

/** Evenly spaced "nice" tick values (1, 2 or 5 × 10^n) covering [min, max]. */
export function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) {
    out.push(Number(v.toPrecision(12)));
    if (v >= max) break;
  }
  return out;
}

export const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed'];

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const label = (n: number) =>
  Math.abs(n) >= 1e5 || (Math.abs(n) < 1e-3 && n !== 0)
    ? n.toExponential(1)
    : String(Number(n.toPrecision(6)));

export function renderChart(chart: Chart, width = 640, height = 360): string {
  const all = chart.series.flatMap((s) => s.points);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const xTicks = ticks(Math.min(...xs, 0), Math.max(...xs, 1));
  const yTicks = ticks(Math.min(...ys, 0), Math.max(...ys, 1));
  const [x0, x1] = [xTicks[0], xTicks[xTicks.length - 1]];
  const [y0, y1] = [yTicks[0], yTicks[yTicks.length - 1]];

  const m = { top: chart.title ? 36 : 16, right: 16, bottom: 44, left: 56 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const sx = (x: number) => m.left + ((x - x0) / (x1 - x0)) * w;
  const sy = (y: number) => m.top + h - ((y - y0) / (y1 - y0)) * h;
  const f = (n: number) => n.toFixed(1);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(chart.title || 'Plot')}" font-size="11" fill="currentColor">`,
  ];
  if (chart.title) {
    parts.push(`<text x="${width / 2}" y="20" text-anchor="middle" font-size="13" font-weight="600">${escape(chart.title)}</text>`);
  }
  for (const t of yTicks) {
    parts.push(
      `<line x1="${m.left}" x2="${m.left + w}" y1="${f(sy(t))}" y2="${f(sy(t))}" stroke="currentColor" stroke-opacity="0.12"/>`,
      `<text x="${m.left - 6}" y="${f(sy(t) + 4)}" text-anchor="end" opacity="0.7">${label(t)}</text>`
    );
  }
  for (const t of xTicks) {
    parts.push(
      `<text x="${f(sx(t))}" y="${m.top + h + 16}" text-anchor="middle" opacity="0.7">${label(t)}</text>`
    );
  }
  parts.push(
    `<line x1="${m.left}" x2="${m.left + w}" y1="${m.top + h}" y2="${m.top + h}" stroke="currentColor" stroke-opacity="0.5"/>`,
    `<line x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${m.top + h}" stroke="currentColor" stroke-opacity="0.5"/>`
  );
  if (chart.xLabel) {
    parts.push(`<text x="${m.left + w / 2}" y="${height - 6}" text-anchor="middle">${escape(chart.xLabel)}</text>`);
  }
  if (chart.yLabel) {
    parts.push(`<text transform="translate(14 ${m.top + h / 2}) rotate(-90)" text-anchor="middle">${escape(chart.yLabel)}</text>`);
  }
  chart.series.forEach((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    const d = s.points
      .map(([x, y], j) => `${j ? 'L' : 'M'}${f(sx(x))} ${f(sy(y))}`)
      .join('');
    if (d) {
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
    }
    // Legend, top right.
    const ly = m.top + 8 + i * 16;
    parts.push(
      `<line x1="${m.left + w - 120}" x2="${m.left + w - 104}" y1="${ly}" y2="${ly}" stroke="${color}" stroke-width="2"/>`,
      `<text x="${m.left + w - 98}" y="${ly + 4}">${escape(s.name)}</text>`
    );
  });
  parts.push('</svg>');
  return parts.join('');
}
