// Anchor TOC titles to the PDF pages where they appear as headings. SPEC §3.1 step 5.
//
// Anchoring per-title yields the printed→PDF page map directly, so there is no
// single global offset guess. A robust median offset is used only as a
// cross-check and as the fallback for titles we can't anchor confidently.
import type { HeadingCandidate } from "./headings.ts";
import type { TocEntry } from "./toc.ts";

export interface AnchoredSection {
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  printedPage?: number;
  confidence: number;
  source: "toc-anchored" | "heuristic" | "llm-adjudicated";
  /** True when the anchor is weak and should be adjudicated by the model. */
  needsAdjudication: boolean;
}

const MATCH_THRESHOLD = 0.6;
const ANCHOR_TOLERANCE = 6; // pages of slack between anchored page and expected

export function anchorSections(
  toc: TocEntry[],
  headings: HeadingCandidate[],
  pageCount: number,
): AnchoredSection[] {
  // Earliest confidently-matching heading page per TOC entry.
  const anchoredPage = new Map<number, number>();
  for (const entry of toc) {
    let earliest: number | undefined;
    for (const h of headings) {
      if (matchScore(entry, h) >= MATCH_THRESHOLD) {
        if (earliest === undefined || h.pageNumber < earliest) earliest = h.pageNumber;
      }
    }
    if (earliest !== undefined) anchoredPage.set(entry.number, earliest);
  }

  // Robust offset from the anchored entries (printed page 1 → PDF page N).
  const offsets: number[] = [];
  for (const entry of toc) {
    const p = anchoredPage.get(entry.number);
    if (p !== undefined) offsets.push(p - entry.printedStart);
  }
  const medianOffset = offsets.length > 0 ? median(offsets) : 0;

  // First pass: resolve start pages + confidence.
  const draft = toc.map((entry) => {
    const expected = entry.printedStart + medianOffset;
    const anchored = anchoredPage.get(entry.number);
    let startPage: number;
    let confidence: number;
    let source: AnchoredSection["source"];

    if (anchored !== undefined && Math.abs(anchored - expected) <= ANCHOR_TOLERANCE) {
      startPage = anchored;
      confidence = 0.92;
      source = "toc-anchored";
    } else if (anchored !== undefined) {
      // Found a title match, but far from where the offset predicts — ambiguous.
      startPage = anchored;
      confidence = 0.55;
      source = "heuristic";
    } else {
      startPage = Math.round(expected);
      confidence = 0.4;
      source = "heuristic";
    }
    startPage = clamp(startPage, 1, pageCount);
    return { entry, startPage, confidence, source };
  });

  // Second pass: end pages from the next section's start (fallback: printed range).
  return draft.map((d, i) => {
    const next = draft[i + 1];
    let endPage: number;
    if (next) {
      endPage = next.startPage - 1;
    } else if (d.entry.printedEnd !== undefined) {
      endPage = d.entry.printedEnd + medianOffset;
    } else {
      endPage = pageCount;
    }
    endPage = clamp(Math.max(endPage, d.startPage), d.startPage, pageCount);

    return {
      number: d.entry.number,
      title: d.entry.title,
      startPage: d.startPage,
      endPage,
      printedPage: d.entry.printedStart,
      confidence: d.confidence,
      source: d.source,
      needsAdjudication: d.confidence < 0.75,
    } satisfies AnchoredSection;
  });
}

/** Similarity of a TOC entry to a heading candidate (0..1). */
export function matchScore(entry: TocEntry, h: HeadingCandidate): number {
  const ts = titleScore(entry.title, stripLeadingNumber(h.text));
  const numMatch = h.number !== undefined && h.number === entry.number;
  if (ts >= 0.85) return Math.min(1, ts + (numMatch ? 0.05 : 0));
  if (numMatch && ts >= 0.4) return 0.6;
  return ts >= MATCH_THRESHOLD ? ts : 0;
}

function titleScore(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (nb.includes(na) || na.includes(nb)) return 0.85;
  return jaccard(tokens(a), tokens(b));
}

function stripLeadingNumber(text: string): string {
  return text.replace(/^\s*(?:chapter|unit|section)?\s*\d+\s*[.)]?\s*/i, "");
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
