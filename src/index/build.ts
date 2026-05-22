// Section-map builder: one indexing sweep + bounded LLM adjudication. SPEC §3.1.
import { runClaudeJson } from "../claude.ts";
import { Cache } from "../cache.ts";
import { layoutPage, linesToText, readingOrder } from "../pdf/columns.ts";
import { extractPageText, loadDocument } from "../pdf/load.ts";
import type { Section, SectionMap } from "../types.ts";
import { ADJUDICATION_SCHEMA } from "../extract/schemas.ts";
import { type AnchoredSection, anchorSections } from "./anchor.ts";
import { detectHeadings, estimateBodySize, type HeadingCandidate, tallySizes } from "./headings.ts";
import { parseToc } from "./toc.ts";

/** Pages of front matter scanned for the printed TOC. */
const FRONT_MATTER_PAGES = 16;
/** Absolute font-size floor for buffering a line as a possible heading. */
const HEADING_FLOOR = 13;

export interface BuildOptions {
  cacheDir: string;
  /** Emit progress (page sweep, etc.). */
  onProgress?: (msg: string) => void;
}

export async function buildIndex(pdfPath: string, opts: BuildOptions): Promise<SectionMap> {
  const log = opts.onProgress ?? (() => {});
  const cache = await Cache.open(pdfPath, opts.cacheDir);
  await cache.ensureDirs();

  const doc = await loadDocument(pdfPath);
  try {
    const pageCount = doc.numPages;
    log(`Indexing ${pageCount} pages…`);

    const sizeWeights = new Map<number, number>();
    const headingLines = new Map<number, { text: string; maxFontSize: number; bold: boolean }[]>();
    const frontLines: { pageNumber: number; text: string }[] = [];

    for (let pn = 1; pn <= pageCount; pn++) {
      const pt = await extractPageText(doc, pn);
      const lines = readingOrder(layoutPage(pt));
      await cache.writePageText(pn, linesToText(lines));

      tallySizes(lines, sizeWeights);

      for (const ln of lines) {
        const numbered = /^\d{1,2}[.)]/.test(ln.text);
        if (ln.maxFontSize >= HEADING_FLOOR || (numbered && ln.bold)) {
          const bucket = headingLines.get(pn) ?? [];
          bucket.push({ text: ln.text, maxFontSize: ln.maxFontSize, bold: ln.bold });
          headingLines.set(pn, bucket);
        }
      }
      if (pn <= FRONT_MATTER_PAGES) {
        for (const ln of lines) frontLines.push({ pageNumber: pn, text: ln.text });
      }
      if (pn % 50 === 0) log(`  …${pn}/${pageCount}`);
    }

    const bodySize = estimateBodySize(sizeWeights);
    const headings: HeadingCandidate[] = [];
    for (const [pn, lns] of headingLines) {
      headings.push(...detectHeadings(pn, lns, bodySize));
    }
    log(`Body text ≈ ${bodySize}pt; ${headings.length} heading candidates.`);

    const toc = parseToc(frontLines);
    log(`Parsed ${toc.length} TOC entries.`);

    let anchored: AnchoredSection[];
    if (toc.length > 0) {
      anchored = anchorSections(toc, headings, pageCount);
      anchored = await adjudicate(anchored, headings, cache, pageCount, log);
    } else {
      log("No TOC found — deriving sections from detected headings.");
      anchored = sectionsFromHeadings(headings, pageCount);
    }

    const sections: Section[] = anchored.map((a) => ({
      id: `ch${a.number}`,
      title: a.title,
      level: 1,
      startPage: a.startPage,
      endPage: a.endPage,
      printedPage: a.printedPage,
      confidence: round2(a.confidence),
      source: a.source,
    }));

    const map: SectionMap = {
      pdfHash: `sha256:${cache.hash}`,
      pdfPath,
      pageCount,
      builtAt: new Date().toISOString(),
      sections,
    };
    await cache.writeSections(map);
    log(`Wrote ${cache.sectionsPath} (${sections.length} sections).`);
    return map;
  } finally {
    await doc.destroy();
  }
}

/**
 * Bounded LLM step: only entries with weak anchors are sent. The model reads
 * the candidate pages (Read over the cache) and returns corrected start pages.
 */
async function adjudicate(
  anchored: AnchoredSection[],
  headings: HeadingCandidate[],
  cache: Cache,
  pageCount: number,
  log: (m: string) => void,
): Promise<AnchoredSection[]> {
  const weak = anchored.filter((a) => a.needsAdjudication);
  if (weak.length === 0) return anchored;
  log(`Adjudicating ${weak.length} weak anchor(s) with claude -p…`);

  const headingList = headings
    .map((h) => `p${h.pageNumber}: "${h.text}" (${h.fontSize.toFixed(0)}pt)`)
    .join("\n");
  const unresolved = weak
    .map(
      (a) =>
        `- number ${a.number}: "${a.title}" (printed page ${a.printedPage ?? "?"}, current guess p${a.startPage})`,
    )
    .join("\n");

  const prompt = `You are fixing a book's section map. Each chapter starts on a PDF page.
The per-page text dumps are in "${cache.pagesDir}" as NNNN.txt (1-based, zero-padded).
Detected heading candidates (PDF page : text : font size):
${headingList}

Resolve the START PDF page for each of these chapters by reading the candidate pages:
${unresolved}

For each, return its number, the 1-based startPage where the chapter title actually
begins, and a confidence 0..1. Pages range 1..${pageCount}.`;

  try {
    const { data } = await runClaudeJson<{
      resolved: { number: number; startPage: number; confidence: number }[];
    }>(prompt, ADJUDICATION_SCHEMA, {
      allowedTools: ["Read", "Grep", "Glob"],
      addDirs: [cache.cacheDir],
      cwd: cache.cacheDir,
    });
    const fix = new Map(data.resolved.map((r) => [r.number, r]));
    const patched = anchored.map((a) => {
      const r = fix.get(a.number);
      if (!r || !a.needsAdjudication) return a;
      return {
        ...a,
        startPage: clamp(r.startPage, 1, pageCount),
        confidence: Math.max(a.confidence, Math.min(0.9, r.confidence)),
        source: "llm-adjudicated" as const,
        needsAdjudication: false,
      };
    });
    // Re-derive end pages now that some starts moved.
    return fixEndPages(patched, pageCount);
  } catch (err) {
    log(`  adjudication skipped (${(err as Error).message.split("\n")[0]}).`);
    return anchored;
  }
}

function fixEndPages(secs: AnchoredSection[], pageCount: number): AnchoredSection[] {
  const sorted = [...secs].sort((a, b) => a.startPage - b.startPage);
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    const endPage = next ? Math.max(s.startPage, next.startPage - 1) : pageCount;
    return { ...s, endPage: clamp(endPage, s.startPage, pageCount) };
  });
}

/** Fallback when no TOC: turn numbered chapter-like headings into sections. */
function sectionsFromHeadings(headings: HeadingCandidate[], pageCount: number): AnchoredSection[] {
  const byNumber = new Map<number, HeadingCandidate>();
  for (const h of headings) {
    if (h.number === undefined) continue;
    const prev = byNumber.get(h.number);
    if (!prev || h.pageNumber < prev.pageNumber) byNumber.set(h.number, h);
  }
  const draft = [...byNumber.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  return draft.map((h, i) => {
    const next = draft[i + 1];
    return {
      number: h.number!,
      title: h.text.replace(/^\s*\d+\s*[.)]?\s*/, "").trim(),
      startPage: h.pageNumber,
      endPage: next ? next.pageNumber - 1 : pageCount,
      confidence: 0.5,
      source: "heuristic" as const,
      needsAdjudication: false,
    };
  });
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
