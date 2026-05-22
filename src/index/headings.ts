// Heuristic heading detection: font size + bold + numbering regex. SPEC §3.1 step 3.

/** Minimal line shape the heading heuristics need (a `Line` satisfies it). */
export interface HeadingLine {
  text: string;
  maxFontSize: number;
  bold: boolean;
}

export interface HeadingCandidate {
  /** 1-based PDF page index. */
  pageNumber: number;
  text: string;
  fontSize: number;
  bold: boolean;
  /** Leading chapter/section number, e.g. 5 from "5. Oscillations". */
  number?: number;
}

/** Lines that begin like a numbered heading (chapter, unit, section, N.N). */
const HEADING_PREFIX = /^(?:chapter|unit|section)?\s*(\d{1,2})(?:[.)]|\s)/i;

/**
 * Estimate the body text size as the most common font size, weighted by how
 * much text is set at it. Headings are sized relative to this.
 */
export function estimateBodySize(sizeWeights: Map<number, number>): number {
  let best = 11;
  let bestWeight = -1;
  for (const [size, weight] of sizeWeights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best;
}

/** Accumulate per-size character counts from a page's lines (for body-size estimation). */
export function tallySizes(lines: HeadingLine[], into: Map<number, number>): void {
  for (const ln of lines) {
    const key = Math.round(ln.maxFontSize);
    into.set(key, (into.get(key) ?? 0) + ln.text.length);
  }
}

/**
 * Detect heading candidates on one page. A heading is a short line set notably
 * larger than body text, or a clearly numbered title line.
 */
export function detectHeadings(
  pageNumber: number,
  lines: HeadingLine[],
  bodySize: number,
): HeadingCandidate[] {
  const big = Math.max(14, bodySize * 1.3);
  const out: HeadingCandidate[] = [];

  for (const ln of lines) {
    const text = ln.text.trim();
    if (text.length < 2 || text.length > 90) continue;
    if (/^[\d.\s]+$/.test(text)) continue; // pure numbers (page refs etc.)

    const m = HEADING_PREFIX.exec(text);
    const numbered = m !== null;
    const isBig = ln.maxFontSize >= big;
    const boldish = ln.bold && ln.maxFontSize >= bodySize * 1.05;

    // Large font is the strongest signal; numbering + bold backs up borderline sizes.
    if (isBig || (numbered && (isBig || boldish))) {
      out.push({
        pageNumber,
        text,
        fontSize: ln.maxFontSize,
        bold: ln.bold,
        number: m?.[1] ? Number(m[1]) : undefined,
      });
    }
  }
  return out;
}
