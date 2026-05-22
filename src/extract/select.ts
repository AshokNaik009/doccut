// SELECT: bounded agentic core — claude -p navigates the index to find matches. SPEC §3.2.
import type { Cache } from "../cache.ts";
import { runClaudeJson } from "../claude.ts";
import type { SectionMap, SelectionResult } from "../types.ts";
import { SELECTION_SCHEMA } from "./schemas.ts";

export async function selectSections(
  map: SectionMap,
  query: string,
  cache: Cache,
): Promise<{ result: SelectionResult; costUsd?: number }> {
  const sectionList = map.sections
    .map((s) => `  ${s.id}: "${s.title}" — PDF pp. ${s.startPage}–${s.endPage}`)
    .join("\n");

  const prompt = `A user wants to extract material from a ${map.pageCount}-page PDF (a textbook).
Their query: "${query}"

The book's chapters (PDF page ranges, 1-based):
${sectionList}

The full reading-ordered text of every page is in "${cache.pagesDir}" as NNNN.txt
(zero-padded, e.g. 0142.txt is PDF page 142). Use Grep/Read/Glob over that directory to
confirm which pages actually cover the query — do not rely on titles alone.

Return the 2–3 most relevant selections. Each selection is a contiguous PDF page range
(may be a whole chapter or a tighter sub-range you verified by reading). For each, give:
- sectionId (the chapter id above) if it maps to one, else omit
- title (a short human label for what you selected)
- startPage, endPage (1-based PDF page indices, within 1..${map.pageCount})
- confidence 0..1 that this range genuinely matches the query
- reason (one sentence citing what you found)

Prefer precision: if only part of a chapter matches, return the tighter range.`;

  const { data, costUsd } = await runClaudeJson<SelectionResult>(prompt, SELECTION_SCHEMA, {
    allowedTools: ["Read", "Grep", "Glob"],
    addDirs: [cache.cacheDir],
    cwd: cache.cacheDir,
  });

  // Defensive clamping — the model occasionally returns out-of-range pages.
  const selections = (data.selections ?? [])
    .map((s) => ({
      ...s,
      startPage: clamp(Math.min(s.startPage, s.endPage), 1, map.pageCount),
      endPage: clamp(Math.max(s.startPage, s.endPage), 1, map.pageCount),
      confidence: clamp(s.confidence, 0, 1),
    }))
    .filter((s) => s.endPage >= s.startPage);

  return { result: { selections }, costUsd };
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
