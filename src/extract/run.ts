// EXTRACT orchestrator: select → confirm → per-page vision → assemble. SPEC §3.2.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Cache } from "../cache.ts";
import { buildIndex } from "../index/build.ts";
import { analyzeGeometry } from "../pdf/geometry.ts";
import { extractPageText, loadDocument } from "../pdf/load.ts";
import { cropToPng, renderPage, saveCanvasPng } from "../pdf/render.ts";
import type { Selection } from "../types.ts";
import { type AssembleMeta, assembleMarkdown, type PageContent, type SectionContent } from "./assemble.ts";
import { confirmSelections } from "./confirm.ts";
import { selectSections } from "./select.ts";
import { runVision } from "./vision.ts";

export interface ExtractOptions {
  query: string;
  out?: string;
  maxPages: number;
  dpi: number;
  yes: boolean;
  dryRun: boolean;
  cacheDir: string;
}

export async function runExtract(pdfPath: string, opts: ExtractOptions): Promise<void> {
  const log = (m: string) => console.error(m);
  let totalCost = 0;

  // 1. Ensure a fresh index (auto-build if missing/stale; hash is in the filename).
  const cache = await Cache.open(pdfPath, opts.cacheDir);
  if (!(await cache.hasSections()) || !(await cache.hasPageDumps())) {
    log("No cached index for this PDF — building it now…");
    await buildIndex(pdfPath, { cacheDir: opts.cacheDir, onProgress: log });
  }
  const map = await cache.readSections();

  // 2. SELECT (bounded agentic core).
  log(`\nSelecting sections for: "${opts.query}"…`);
  const { result, costUsd: selCost } = await selectSections(map, opts.query, cache);
  totalCost += selCost ?? 0;
  if (result.selections.length === 0) {
    log("The model returned no selections. Try rephrasing --query.");
    return;
  }

  // 3. CONFIRM (or dry-run preview).
  if (opts.dryRun) {
    printProposal(result.selections);
    log(`\n(dry run — not extracting; select cost ~$${totalCost.toFixed(4)})`);
    return;
  }
  const outcome = await confirmSelections(result.selections, { yes: opts.yes, maxPages: opts.maxPages });
  if (outcome.aborted) {
    log(`\nExtraction stopped: ${outcome.reason}`);
    return;
  }

  // 4. Prepare output paths.
  const outPath = path.resolve(opts.out ?? `${slug(opts.query)}.md`);
  const assetsName = `${path.basename(outPath, path.extname(outPath))}.assets`;
  const assetsDir = path.join(path.dirname(outPath), assetsName);
  await fs.mkdir(assetsDir, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doccut-"));

  // 5. Per selected page: text (free) + gated vision (figures/equations).
  const doc = await loadDocument(pdfPath);
  let figCounter = 0;
  try {
    const sections: SectionContent[] = [];
    for (const sel of outcome.accepted) {
      const pages: PageContent[] = [];
      for (let pn = sel.startPage; pn <= sel.endPage; pn++) {
        const text = await cache.readPageText(pn).catch(() => "");
        const pageText = await extractPageText(doc, pn);
        const page = await doc.getPage(pn);
        let figures: PageContent["figures"] = [];
        let equations: PageContent["equations"] = [];

        try {
          const geom = await analyzeGeometry(page, pageText);
          if (geom.needsVision) {
            log(`  vision: page ${pn} (${geom.figureCandidates.length} candidate(s)${geom.mathDense ? ", math" : ""})`);
            const rendered = await renderPage(doc, pn, opts.dpi);
            const tmpPng = path.join(tmpDir, `page-${pn}.png`);
            await saveCanvasPng(rendered.canvas, tmpPng);
            const { result: vision, costUsd } = await runVision(tmpPng, rendered.width, rendered.height);
            totalCost += costUsd ?? 0;

            for (const fig of vision.figures) {
              const name = `fig${String(++figCounter).padStart(2, "0")}.png`;
              await cropToPng(rendered, fig.bbox, path.join(assetsDir, name));
              figures.push({ assetPath: `${assetsName}/${name}`, caption: fig.caption, kind: fig.kind });
            }
            equations = vision.equations.map((e) => ({ latex: e.latex, display: e.display }));
          }
        } catch (err) {
          log(`  (vision skipped for page ${pn}: ${(err as Error).message.split("\n")[0]})`);
        } finally {
          page.cleanup();
        }

        pages.push({ pageNumber: pn, text, figures, equations });
      }
      sections.push({
        title: sel.title,
        startPage: sel.startPage,
        endPage: sel.endPage,
        reason: sel.reason,
        pages,
      });
    }

    // 6. ASSEMBLE.
    const meta: AssembleMeta = {
      query: opts.query,
      pdfPath: path.relative(process.cwd(), pdfPath),
      builtAt: new Date().toISOString().slice(0, 10),
    };
    const md = assembleMarkdown(sections, meta);
    await fs.writeFile(outPath, md, "utf8");

    log(`\n✓ Wrote ${outPath}`);
    if (figCounter > 0) log(`  ${figCounter} figure(s) in ${assetsDir}/`);
    log(`  approx. model cost: $${totalCost.toFixed(4)}`);
  } finally {
    await doc.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function printProposal(selections: Selection[]): void {
  console.error("\nProposed selections (by confidence):");
  for (const s of [...selections].sort((a, b) => b.confidence - a.confidence)) {
    const band = s.confidence >= 0.75 ? "auto" : s.confidence >= 0.45 ? "flag" : "drop";
    console.error(
      `  [${band}] pp.${s.startPage}–${s.endPage}  ${s.title}  (conf ${s.confidence.toFixed(2)})` +
        `${s.reason ? `\n         ${s.reason}` : ""}`,
    );
  }
}

function slug(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "extract"
  );
}
