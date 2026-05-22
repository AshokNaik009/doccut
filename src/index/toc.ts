// Printed-TOC parse: scan front matter for Contents entries. SPEC §3.1 step 4.

export interface TocEntry {
  /** Chapter/section number printed in the contents. */
  number: number;
  title: string;
  /** Printed page where the entry starts. */
  printedStart: number;
  /** Printed page where the entry ends, if the TOC lists a range. */
  printedEnd?: number;
}

// "5 Oscillations 109-130"  |  "5 Oscillations 109"  |  "5. Oscillations .... 109"
const RANGE_ENTRY = /^(\d{1,2})[.)]?\s+(.+?)[\s.]+(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*$/;
const SINGLE_ENTRY = /^(\d{1,2})[.)]?\s+(.+?)[\s.]+(\d{1,4})\s*$/;

/**
 * Parse TOC entries from front-matter text lines (each tagged with its PDF
 * page). Returns entries sorted by number, de-duplicated, with sane ranges.
 */
export function parseToc(lines: { pageNumber: number; text: string }[]): TocEntry[] {
  const byNumber = new Map<number, TocEntry>();

  for (const { text } of lines) {
    const t = text.trim();
    let entry: TocEntry | null = null;

    const r = RANGE_ENTRY.exec(t);
    if (r) {
      entry = {
        number: Number(r[1]),
        title: cleanTitle(r[2]!),
        printedStart: Number(r[3]),
        printedEnd: Number(r[4]),
      };
    } else {
      const s = SINGLE_ENTRY.exec(t);
      if (s) {
        entry = {
          number: Number(s[1]),
          title: cleanTitle(s[2]!),
          printedStart: Number(s[3]),
        };
      }
    }

    if (!entry) continue;
    if (!isPlausible(entry)) continue;
    // First occurrence wins (the real TOC precedes any back-references).
    if (!byNumber.has(entry.number)) byNumber.set(entry.number, entry);
  }

  const entries = [...byNumber.values()].sort((a, b) => a.number - b.number);
  return entries.filter((e, i) => isMonotonic(entries, i));
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\.{2,}/g, " ") // dot leaders
    .replace(/\s+/g, " ")
    .trim();
}

function isPlausible(e: TocEntry): boolean {
  if (e.title.length < 3 || e.title.length > 80) return false;
  if (!/[a-z]/i.test(e.title)) return false; // titles have letters
  if (e.number < 1 || e.number > 60) return false;
  if (e.printedStart < 1 || e.printedStart > 5000) return false;
  if (e.printedEnd !== undefined && e.printedEnd < e.printedStart) return false;
  return true;
}

/** Keep entries whose start pages don't go backwards (drops stray matches). */
function isMonotonic(entries: TocEntry[], i: number): boolean {
  if (i === 0) return true;
  const prev = entries[i - 1]!;
  const cur = entries[i]!;
  return cur.printedStart >= prev.printedStart;
}
