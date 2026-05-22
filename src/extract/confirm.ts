// CONFIRM (U2): confidence-gated, fail-closed, with a disambiguation shortlist. SPEC §3.2, §5.4.
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Selection } from "../types.ts";

// Confidence bands (SPEC §5.4), tunable.
const AUTO_INCLUDE = 0.75;
const FLAG_FLOOR = 0.45;

export interface ConfirmOptions {
  yes: boolean;
  maxPages: number;
}

export interface ConfirmOutcome {
  accepted: Selection[];
  aborted: boolean;
  reason?: string;
}

/** Count distinct PDF pages covered by a set of (possibly overlapping) ranges. */
export function uniquePageCount(selections: Selection[]): number {
  const pages = new Set<number>();
  for (const s of selections) {
    for (let p = s.startPage; p <= s.endPage; p++) pages.add(p);
  }
  return pages.size;
}

function fmt(s: Selection): string {
  return `pp.${s.startPage}–${s.endPage}  ${s.title}  (conf ${s.confidence.toFixed(2)})${s.reason ? ` — ${s.reason}` : ""}`;
}

export async function confirmSelections(
  selections: Selection[],
  opts: ConfirmOptions,
): Promise<ConfirmOutcome> {
  const high = selections.filter((s) => s.confidence >= AUTO_INCLUDE);
  const flagged = selections.filter((s) => s.confidence >= FLAG_FLOOR && s.confidence < AUTO_INCLUDE);

  // Fail closed: nothing qualifies at all.
  if (high.length === 0 && flagged.length === 0) {
    return {
      accepted: [],
      aborted: true,
      reason:
        "No selection reached the confidence floor. Try a more specific --query (e.g. name the topic or chapter).",
    };
  }

  const interactive = stdin.isTTY && stdout.isTTY && !opts.yes;

  stdout.write("\nProposed extraction:\n");
  if (high.length > 0) {
    stdout.write("  Auto-included (high confidence):\n");
    for (const s of high) stdout.write(`    • ${fmt(s)}\n`);
  }
  if (flagged.length > 0) {
    stdout.write("  Needs your call (lower confidence):\n");
    flagged.forEach((s, i) => stdout.write(`    [${i + 1}] ${fmt(s)}\n`));
  }

  let accepted = [...high];

  if (interactive && flagged.length > 0) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const ans = (
        await rl.question("\nInclude which flagged items? (e.g. 1,3 / 'a' all / Enter none): ")
      ).trim();
      if (ans.toLowerCase() === "a") {
        accepted.push(...flagged);
      } else if (ans.length > 0) {
        const picks = new Set(ans.split(/[,\s]+/).map((n) => parseInt(n, 10)));
        flagged.forEach((s, i) => {
          if (picks.has(i + 1)) accepted.push(s);
        });
      }
    } finally {
      rl.close();
    }
  } else if (!interactive && flagged.length > 0) {
    stdout.write("  (non-interactive: flagged items excluded — re-run without --yes to choose)\n");
  }

  if (accepted.length === 0) {
    return { accepted: [], aborted: true, reason: "Nothing accepted." };
  }

  // Backstop: page cap (SPEC §4).
  const pages = uniquePageCount(accepted);
  if (pages > opts.maxPages) {
    const msg = `Selection covers ${pages} pages, above --max-pages ${opts.maxPages}.`;
    if (interactive) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const ans = (await rl.question(`${msg} Proceed anyway? (y/N): `)).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          return { accepted: [], aborted: true, reason: "Aborted at page cap." };
        }
      } finally {
        rl.close();
      }
    } else {
      return {
        accepted: [],
        aborted: true,
        reason: `${msg} Raise --max-pages to proceed.`,
      };
    }
  }

  // Final confirmation for interactive runs.
  if (interactive) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const ans = (
        await rl.question(`\nExtract ${accepted.length} selection(s), ${pages} pages? (Y/n): `)
      )
        .trim()
        .toLowerCase();
      if (ans === "n" || ans === "no") {
        return { accepted: [], aborted: true, reason: "Cancelled." };
      }
    } finally {
      rl.close();
    }
  }

  return { accepted, aborted: false };
}
