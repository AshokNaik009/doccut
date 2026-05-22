#!/usr/bin/env -S npx tsx
// doccut CLI: `index` builds the cached section map, `extract` pulls sections. SPEC §4.
import { Command } from "commander";
import { buildIndex } from "./index/build.ts";
import { Cache } from "./cache.ts";

const program = new Command();
program
  .name("doccut")
  .description("Query-driven PDF section extractor → Markdown")
  .version("0.1.0");

program
  .command("index")
  .description("Build / refresh the cached section map for a PDF")
  .argument("<pdf>", "path to the PDF")
  .option("--cache-dir <dir>", "cache directory", ".cache")
  .option("--force", "rebuild even if a cached map exists", false)
  .action(async (pdf: string, opts: { cacheDir: string; force: boolean }) => {
    const cache = await Cache.open(pdf, opts.cacheDir);
    if (!opts.force && (await cache.hasSections())) {
      const map = await cache.readSections();
      console.log(`Cached section map present (${map.sections.length} sections). Use --force to rebuild.`);
      printSections(map.sections);
      return;
    }
    const map = await buildIndex(pdf, { cacheDir: opts.cacheDir, onProgress: (m) => console.error(m) });
    printSections(map.sections);
  });

program
  .command("extract")
  .description("Extract sections matching a query into a Markdown document")
  .argument("<pdf>", "path to the PDF")
  .requiredOption("--query <text>", "natural-language description of wanted sections")
  .option("--out <file>", "output Markdown path (default: <query-slug>.md)")
  .option("--max-pages <n>", "backstop cap on selected pages", (v) => parseInt(v, 10), 50)
  .option("--dpi <n>", "render DPI for vision + figure crops", (v) => parseInt(v, 10), 150)
  .option("--yes", "skip interactive confirm (auto-accept high-confidence)", false)
  .option("--dry-run", "resolve + show proposal, do not extract", false)
  .option("--cache-dir <dir>", "cache directory", ".cache")
  .action(async (pdf: string, opts) => {
    const { runExtract } = await import("./extract/run.ts");
    await runExtract(pdf, {
      query: opts.query,
      out: opts.out,
      maxPages: opts.maxPages,
      dpi: opts.dpi,
      yes: opts.yes,
      dryRun: opts.dryRun,
      cacheDir: opts.cacheDir,
    });
  });

function printSections(sections: { startPage: number; endPage: number; title: string; confidence: number; source: string }[]): void {
  for (const s of sections) {
    console.log(
      `  pp.${String(s.startPage).padStart(3)}–${String(s.endPage).padStart(3)}  ` +
        `${s.title}  (${s.source}, conf ${s.confidence})`,
    );
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
