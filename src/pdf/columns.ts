// Column clustering + reading order for (possibly) two-column pages. SPEC §3.1, §9.
//
// Two-column pages defeat naive baseline grouping: the left and right columns
// share baselines, so grouping by baseline alone fuses "left line + right line"
// into one. We therefore (1) detect the gutter from item x-coverage, then
// (2) split any baseline-merged line that has a clear gap straddling the gutter.
import type { PageText, TextItem } from "../types.ts";

/** A visual line: items sharing a baseline, left-to-right. */
export interface Line {
  items: TextItem[];
  /** Baseline distance from the page top (used for vertical ordering). */
  baseline: number;
  minX: number;
  maxX: number;
  /** Largest font size among the line's items (drives heading detection). */
  maxFontSize: number;
  /** True if any item on the line is (likely) bold. */
  bold: boolean;
  text: string;
}

export interface PageLayout {
  lines: Line[];
  /** Detected gutter x, or null for a single-column page. */
  gutterX: number | null;
  width: number;
  height: number;
}

const baselineOf = (it: TextItem): number => it.y + it.height;

/**
 * Detect a vertical gutter from item x-coverage: a near-empty bin in the page's
 * central band, flanked by busy columns on both sides. Returns its center x.
 */
export function detectGutter(items: TextItem[], width: number): number | null {
  const real = items.filter((it) => it.text.trim().length > 0);
  if (real.length < 30) return null;

  const bins = 100;
  const binW = width / bins;
  const cov = new Array<number>(bins).fill(0);
  for (const it of real) {
    const start = clampBin(Math.floor(it.x / binW), bins);
    const end = clampBin(Math.floor((it.x + it.width) / binW), bins);
    for (let b = start; b <= end; b++) cov[b]!++;
  }

  const bandLo = Math.floor(bins * 0.4);
  const bandHi = Math.ceil(bins * 0.6);
  let minBin = bandLo;
  for (let b = bandLo; b <= bandHi; b++) {
    if (cov[b]! < cov[minBin]!) minBin = b;
  }
  const leftMax = Math.max(...cov.slice(Math.floor(bins * 0.15), Math.floor(bins * 0.4)));
  const rightMax = Math.max(...cov.slice(Math.floor(bins * 0.6), Math.floor(bins * 0.85)));

  // The valley must be near-empty relative to both flanking columns.
  if (leftMax === 0 || rightMax === 0) return null;
  if (cov[minBin]! <= 0.1 * Math.min(leftMax, rightMax)) {
    return minBin * binW + binW / 2;
  }
  return null;
}

/** Group raw text items into visual lines by shared baseline. */
function groupLines(items: TextItem[]): Line[] {
  const real = [...items].filter((it) => it.text.trim().length > 0);
  if (real.length === 0) return [];
  real.sort((a, b) => baselineOf(a) - baselineOf(b) || a.x - b.x);

  const tol = Math.max(2, medianFontSize(real) * 0.5);
  const lines: Line[] = [];
  let bucket: TextItem[] = [];
  let bucketBaseline = baselineOf(real[0]!);

  const flush = () => {
    if (bucket.length === 0) return;
    bucket.sort((a, b) => a.x - b.x);
    lines.push(makeLine(bucket));
    bucket = [];
  };

  for (const it of real) {
    const b = baselineOf(it);
    if (bucket.length === 0 || Math.abs(b - bucketBaseline) <= tol) {
      bucket.push(it);
      bucketBaseline = (bucketBaseline * (bucket.length - 1) + b) / bucket.length;
    } else {
      flush();
      bucket.push(it);
      bucketBaseline = b;
    }
  }
  flush();
  return lines;
}

function makeLine(items: TextItem[]): Line {
  let text = "";
  let prev: TextItem | null = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.width);
      const needsSpace = gap > Math.max(1, it.fontSize * 0.22);
      if (needsSpace && !/\s$/.test(text) && !/^\s/.test(it.text)) text += " ";
    }
    text += it.text;
    prev = it;
  }
  const minX = Math.min(...items.map((i) => i.x));
  const maxX = Math.max(...items.map((i) => i.x + i.width));
  return {
    items,
    baseline: items[0]!.y + items[0]!.height,
    minX,
    maxX,
    maxFontSize: Math.max(...items.map((i) => i.fontSize)),
    bold: items.some((i) => /bold|black|heavy|semibold/i.test(i.fontName)),
    text: text.replace(/\s+/g, " ").trim(),
  };
}

/**
 * If a line spans both sides of the gutter but no item actually crosses it,
 * it's two column-lines fused by baseline alignment — split them. A genuinely
 * full-width line (an item straddles the gutter) is returned unchanged.
 */
function splitAtGutter(line: Line, gutter: number): Line[] {
  const tol = 3;
  const straddles = line.items.some((it) => it.x < gutter - tol && it.x + it.width > gutter + tol);
  if (straddles) return [line];

  const left = line.items.filter((it) => it.x + it.width / 2 < gutter);
  const right = line.items.filter((it) => it.x + it.width / 2 >= gutter);
  if (left.length === 0 || right.length === 0) return [line];
  return [makeLine(left), makeLine(right)];
}

export function layoutPage(page: PageText): PageLayout {
  const gutterX = detectGutter(page.items, page.width);
  let lines = groupLines(page.items);
  if (gutterX !== null) {
    lines = lines.flatMap((ln) => splitAtGutter(ln, gutterX));
  }
  return { lines, gutterX, width: page.width, height: page.height };
}

/**
 * Reading order. Single column → top-to-bottom. Two columns → full-width lines
 * act as separators; between them, the left column is read fully, then the right.
 */
export function readingOrder(layout: PageLayout): Line[] {
  const { lines, gutterX } = layout;
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline);
  if (gutterX === null) return sorted;

  const out: Line[] = [];
  let left: Line[] = [];
  let right: Line[] = [];
  const flush = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };

  for (const ln of sorted) {
    if (ln.maxX <= gutterX) left.push(ln);
    else if (ln.minX >= gutterX) right.push(ln);
    else {
      // A line genuinely crossing the gutter is a full-width separator.
      flush();
      out.push(ln);
    }
  }
  flush();
  return out;
}

/** Join already-ordered lines into plain text. */
export function linesToText(lines: Line[]): string {
  return lines
    .map((l) => l.text)
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Reading-ordered plain text for a page. */
export function pageToText(page: PageText): string {
  return linesToText(readingOrder(layoutPage(page)));
}

function medianFontSize(items: TextItem[]): number {
  const sizes = items.map((i) => i.fontSize).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)] ?? 10;
}

function clampBin(b: number, bins: number): number {
  return Math.max(0, Math.min(bins - 1, b));
}
