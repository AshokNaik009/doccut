# doccut — query-driven PDF section extractor

Give `doccut` a **large PDF** and a **fuzzy natural-language query**. It locates the
2–3 relevant sections (anywhere in the document), extracts their **text and figures**,
and assembles them into a **new Markdown document** with provenance citations.

The model (`claude -p`) is used only where genuine judgment is required — selecting
which pages match, and reading figures/equations off rendered pages. Everything else
(text extraction, column ordering, the TOC→page index, figure cropping) is deterministic.

> Built to the design in [`SPEC.md`](./SPEC.md).

---

## Requirements

- **Node ≥ 18** (developed on Node 22). No system dependencies — `pdfjs-dist` and
  `@napi-rs/canvas` are pure-npm with prebuilt binaries (no Poppler / `brew`).
- **Claude Code CLI** on your `PATH` (`claude`). `doccut` shells out to `claude -p`.
  - Stay logged into Claude Code and leave `ANTHROPIC_API_KEY` **unset** to run on your
    Pro/Max subscription. Set `ANTHROPIC_API_KEY` to bill the API instead — same interface.

## Install

```bash
npm install
```

Run via the bundled scripts or `tsx` directly:

```bash
npx tsx src/cli.ts --help
# or
npm run doccut -- --help
```

---

## Usage

### 1. Build the section index (one time per PDF)

```bash
npx tsx src/cli.ts index <pdf> [--force] [--cache-dir .cache]
```

Sweeps the PDF once (extracting column-aware text per page) and derives the section map.
It is **agnostic to the PDF's layout** — it tries the most authoritative structure source
available and falls back gracefully:

1. **PDF outline / bookmarks** (`getOutline`) — used directly when present (most published
   PDFs have these). The single most reliable source.
2. **Printed Table of Contents** — parsed from the front matter, then each title is
   **anchored** to the PDF page where it actually begins (no printed-vs-PDF offset
   guesswork). Weak anchors are resolved by one bounded `claude -p` call.
3. **Detected headings** — when there's no outline or TOC, sections are derived from
   font-size/numbering heuristics.
4. **Fixed page windows** — last resort, so the index is never empty.

Single- and two-column layouts are handled (the reading order detects the gutter). Scanned
PDFs with no text layer are detected and flagged — structure/text search is then limited,
but figures and equations still come from the vision pass on extracted pages.

Results are cached in `.cache/` keyed by the PDF's content hash, so re-indexing is skipped
unless the file changes or you pass `--force`. `extract` auto-runs this if the cache is
missing.

### 2. Extract sections matching a query

```bash
npx tsx src/cli.ts extract <pdf> --query "magnetism and electromagnetic induction" \
  [--out doc.md] [--max-pages 50] [--dpi 150] [--yes] [--dry-run] [--cache-dir .cache]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--query` | *(required)* | Natural-language description of the sections you want |
| `--out` | `<query-slug>.md` | Output Markdown path; figures go in `<out-basename>.assets/` |
| `--max-pages` | `50` | Backstop cap on selected pages (warns / aborts above) |
| `--dpi` | `150` | Render DPI for the vision pass and figure crops |
| `--yes` | `false` | Skip the interactive confirm (auto-accept high-confidence selections) |
| `--dry-run` | `false` | Resolve and print the proposal, but do not extract |
| `--force` | `false` | (index) Rebuild the section-map cache even if present |
| `--cache-dir` | `.cache` | Where the index cache lives |

**What happens during `extract`:**

1. **Select** — `claude -p` (with `Read`/`Grep`/`Glob` over the cached page text) finds
   the matching page ranges and scores each with a confidence.
2. **Confirm** — selections are banded: `≥0.75` auto-included, `0.45–0.75` offered as a
   disambiguation shortlist, `<0.45` dropped. If nothing qualifies it **fails closed** and
   asks you to refine the query. `--yes` accepts the high-confidence set; `--dry-run` stops
   here.
3. **Per page** — text is taken for free; a geometric pre-pass decides which pages have
   figures or dense math. **Only those pages** are rendered and sent to a vision pass
   (`claude -p --allowedTools Read`) that returns figure boxes + captions and equation LaTeX.
4. **Assemble** — Markdown in query order, each section headed with its source page range,
   figures inlined as cropped PNGs, equations as `$…$` / `$$…$$`.

---

## Examples

```bash
# Cheap preview only — see what would be selected, spend nothing on vision:
npx tsx src/cli.ts extract book.pdf --query "isothermal and adiabatic processes" --dry-run

# Full extraction, non-interactive:
npx tsx src/cli.ts extract book.pdf \
  --query "isothermal and adiabatic thermodynamic processes" \
  --yes --out out/thermo.md

# Interactive: choose which lower-confidence sections to include:
npx tsx src/cli.ts extract book.pdf --query "wave optics interference"
```

Output for the thermodynamics example:

```
out/thermo.md            # the assembled document
out/thermo.assets/       # fig01.png, fig02.png, … (cropped figures)
```

### Example output (excerpt of `out/thermo.md`)

Produced by the `--yes --out out/thermo.md` command above. Note the provenance header
with source page range, the "why selected" rationale from the agentic select step, the
inlined cropped figure, and the clean LaTeX transcribed by the vision pass:

````markdown
# Extract: isothermal and adiabatic thermodynamic processes

> Generated by **doccut** from `TestFile-Extract.pdf` on 2026-05-22. Sections are
> ordered by relevance to the query; page numbers cite the source PDF.

## Isothermal process (definition, p-V diagram, work done) (source pp. 100–101)

*Why selected: Pages 100–101 are the dedicated 'Isothermal process' sub-section
defining ΔT=0, deriving isothermal work and showing its p-V diagram, plus a worked example.*

2. Isothermal process:
A process in which change in pressure and volume takes place at a constant temperature
is called an isothermal process or isothermal change. For such a system ΔT = 0 …

![Fig. 4.15: p-V diagram of an isothermal process.](thermo.assets/fig01.png)

*Fig. 4.15: p-V diagram of an isothermal process. — graph (source p. 100)*

<!-- equations transcribed from p. 100 -->
$$
W = \int_{V_1}^{V_2} p\, dV
$$

$$
W = nRT \ln\frac{V_2}{V_1}
$$

$pV = nRT$   $\Delta U = 0$
````

That run produced a 689-line document and cropped **5 figures** into `out/thermo.assets/`.

---

## Cost & performance

- **Indexing** is mostly deterministic — one PDF sweep (~30s for 376 pages) plus at most a
  single small adjudication call. Cached afterward.
- **The vision pass is the cost driver.** It is *gated*: text-only pages never reach the
  model, and `--max-pages` caps how many pages can be processed. Each rendered page sent to
  vision costs roughly $0.10–0.15. Narrow your `--query` and use `--dry-run` to keep spend
  predictable.

## How it's structured

```
src/
  cli.ts            commander entrypoint (index, extract)
  claude.ts         claude -p subprocess wrapper (--json-schema, --allowedTools)
  cache.ts          PDF hashing + .cache layout
  pdf/
    load.ts         pdfjs loader, positioned text items
    columns.ts      gutter detection + two-column reading order
    render.ts       page → PNG, region crop (@napi-rs/canvas)
    geometry.ts     operator-list bboxes, figure clustering, math density
  index/
    outline.ts        structure from PDF bookmarks (top-priority source)
    headings.ts toc.ts anchor.ts build.ts   heading/TOC derivation + builder
  extract/
    select.ts confirm.ts vision.ts assemble.ts run.ts   the extract pipeline
    schemas.ts      JSON schemas for the model calls
```

## Tests

```bash
npm test        # node:test unit tests for the deterministic core
npm run typecheck
```

## Notes & limits (v1)

- Markdown is the primary output by design; PDF/DOCX are intended as a later `--render`
  bolt-on (e.g. via Pandoc).
- The page text layer reproduces math as garbled inline text; the clean version comes from
  the vision LaTeX block. Some duplication is expected.
- Figure crop boxes are approximate (the vision pass snaps them) and may include a little
  surrounding whitespace or caption.
- Scope excludes editing existing documents, rewritten/synthesized narrative, and
  multi-document merge.
