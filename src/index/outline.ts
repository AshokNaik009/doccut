// Structure from the PDF outline (bookmarks). Most-authoritative source when present. SPEC §3.1.
//
// The printed-TOC path (toc.ts/anchor.ts) assumes a textbook-style contents page.
// Real PDFs vary wildly in layout, but a great many ship an embedded outline —
// which is explicit structure we can read directly instead of deriving it.
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnchoredSection } from "./anchor.ts";

interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

/**
 * Build sections from the document outline, or null if there is no usable one.
 * Picks the shallowest outline level that yields a sensible number of entries,
 * so a single "book title" root expands to its chapters.
 */
export async function sectionsFromOutline(
  doc: PDFDocumentProxy,
  pageCount: number,
): Promise<AnchoredSection[] | null> {
  const outline = (await doc.getOutline().catch(() => null)) as RawOutlineItem[] | null;
  if (!outline || outline.length === 0) return null;

  const level = chooseLevel(outline);
  const resolved: { title: string; page: number }[] = [];
  for (const item of level) {
    const title = cleanTitle(item.title);
    if (!title) continue;
    const page = await resolvePage(doc, item.dest);
    if (page !== null) resolved.push({ title, page });
  }
  if (resolved.length < 2) return null;

  resolved.sort((a, b) => a.page - b.page);
  // Collapse entries that resolve to the same start page (keep the first title).
  const deduped = resolved.filter((r, i) => i === 0 || r.page !== resolved[i - 1]!.page);

  return deduped.map((r, i) => {
    const startPage = clamp(r.page, 1, pageCount);
    const nextStart = deduped[i + 1]?.page ?? pageCount + 1;
    return {
      number: i + 1,
      title: r.title,
      startPage,
      endPage: clamp(nextStart - 1, startPage, pageCount),
      confidence: 0.95,
      source: "outline",
      needsAdjudication: false,
    } satisfies AnchoredSection;
  });
}

/** Walk down outline levels until one has a usable count (≥2, not absurdly many). */
export function chooseLevel(outline: RawOutlineItem[]): RawOutlineItem[] {
  let level = outline;
  for (let depth = 0; depth < 4; depth++) {
    if (level.length >= 2 && level.length <= 80) return level;
    const next = level.flatMap((i) => i.items ?? []);
    if (next.length === 0) return level;
    level = next;
  }
  return level;
}

/** Resolve an outline destination to a 1-based page number, or null. */
async function resolvePage(doc: PDFDocumentProxy, dest: RawOutlineItem["dest"]): Promise<number | null> {
  try {
    let explicit = dest;
    if (typeof explicit === "string") {
      explicit = (await doc.getDestination(explicit)) as unknown[] | null;
    }
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (ref === null || ref === undefined) return null;
    const index = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return index + 1;
  } catch {
    return null;
  }
}

function cleanTitle(raw: string): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
