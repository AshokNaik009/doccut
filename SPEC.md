# SPEC — Query-Driven PDF Section Extractor

> **Status:** Design locked, pre-implementation
> **Date:** 2026-05-22
> **Source:** Crystallized from a 13-question design grill session
> **Working name:** `doccut` (cosmetic, TBD)

---

## 1. Goal

A Node/TypeScript CLI that takes a **large PDF** and a **fuzzy natural-language query**, locates the 2–3 relevant sections (which may be scattered anywhere in the document), extracts their **text and figures**, and assembles them into a **new Markdown document**. The model (`claude -p`) is used only where genuine judgment is required; everything else is deterministic.

### Reference document
All design choices are grounded in the test file `TestFile-Extract.pdf`:

| Property | Value | Design impact |
|----------|-------|---------------|
| Pages | 376 | Full-doc LLM sweeps too costly → derive structure cheaply |
| Title | *Physics 12th FINAL PDF 22-23* | Math-heavy → equation fidelity matters |
| Bookmarks/outline | **None** | Structure must be *derived*, not read from TOC metadata |
| Layout | **Two-column** | Reading order must be column-aware (forced requirement) |
| Image objects | ~624 raster XObjects | Many decorative/split; diagrams are often *vector* → render, don't pull XObjects |
| Producer | Acrobat Distiller 19 | Real text layer present (not scanned) |

---

## 2. Locked decisions

| # | Branch | Decision | Rationale |
|---|--------|----------|-----------|
| 1 | Query model | **Hybrid** — fuzzy NL query resolved against derived structure; user confirms before extraction | Blind full-doc semantic search is expensive; confirm = human checkpoint before spend |
| 2 | Structure source | **One-time indexing sweep**, seeded by printed-TOC parse, cached to disk | No bookmarks exist; build once, reuse across queries |
| 3 | Architecture | **Deterministic shell + bounded agentic selection core** | Model only at the fuzzy seam; rest is reproducible & cheap |
| 4 | Image strategy | **Figure bounding-box detection (render-based)** | XObject extraction silently misses vector diagrams |
| 5 | Figure detection | **Geometric pre-pass + bounded vision validation**, on *selected pages only* | Mirrors the deterministic-shell philosophy; bounds cost |
| 6 | Output | **Markdown, text-first**; figures = cropped PNGs; equations → LaTeX | Portable, diffable, composable; MD→PDF/DOCX is a cheap later bolt-on |
| 7 | CLI | **Interactive confirm**; subcommands `index` + `extract`; `--yes`/`--dry-run` | Literal realization of the hybrid model; still scriptable |
| 8 | Assembly | **Query order + provenance headers** (source page citations) | Traceability is high-value for a study/reference doc |
| 9 | Model invocation | **Per-step `claude -p` with `--json-schema`**; selection navigates via Read/Grep/Glob over dumped files | Schema-validated outputs; no MCP server needed for v1 |
| 10 | Indexing | **Heuristics first, LLM adjudication only**; TOC titles anchored to actual heading pages | Cheap; anchoring solves the printed-vs-PDF page-offset problem |
| 11 | Vision cost | **Gated vision** (geometric pass decides) + `--max-pages` backstop | Text-only pages cost zero tokens |
| 12 | Bad queries | **Confidence-gated, fail-closed** + disambiguation shortlist in confirm | Never silently extract the wrong pages |
| 13 | Tooling | **TS (ESM) + commander + tsx + node:test + npm** | Minimal ceremony; fastest path to the go/no-go smoke test |

**Core dependencies:** `pdfjs-dist` (text + positions + operator list + rendering), `@napi-rs/canvas` (prebuilt canvas backend for render/crop). Pure-npm — no system dependencies (no Poppler/`brew`).

---

## 3. Architecture & data flow

```
                 ┌─────────────────────────────────────────────┐
   index <pdf>   │  pdfjs text+positions → column-aware text     │
                 │  heuristic headings (font-size + regex)       │
                 │  printed-TOC parse → anchor titles→PDF pages  │
                 │  claude -p adjudicates mismatches (schema)    │
                 │  → .cache/<hash>.sections.json + pages/*.txt  │
                 └─────────────────────────────────────────────┘
                                     │
   extract       ┌──────────────────▼──────────────────────────┐
   --query "…"   │  SELECT: claude -p (Read/Grep/Glob, schema)   │  ← bounded agentic core
                 │  CONFIRM: confidence-gated, disambiguate, U2  │
                 │  PER PAGE: column text  +  geometric pre-pass │
                 │  GATED VISION: only figure/math pages         │  ← claude -p --allowedTools Read
                 │  CROP figures → PNGs                          │
                 │  ASSEMBLE: query-order MD + provenance        │
                 │  → doc.md + doc.assets/                       │
                 └───────────────────────────────────────────────┘
```

### 3.1 `index` pipeline
1. **Hash** the PDF (sha256) → cache key.
2. **Text extraction** (`pdf/load`, `pdf/columns`): pdfjs `getTextContent()` with item transforms; cluster words into columns by x-position; emit reading-ordered plain text per page → `pages/0001.txt …`.
3. **Heuristic headings** (`index/headings`): per-item font size (from transform scale) + bold + regex (`/^(Chapter|Unit|Section|\d+(\.\d+)*)\b/`) → candidate headings **with real PDF page indices**.
4. **TOC parse** (`index/toc`): scan front matter (~first 15 pages) for a Contents block; extract `(title, printedPageNumber)` pairs.
5. **Anchor** (`index/anchor`): for each TOC title, find the PDF page where that title appears as a detected heading. This yields the printed→PDF page map directly — **no global offset guess**. Section ranges = `[headingPage, nextHeadingPage − 1]`.
6. **Adjudication** (`index/build`): call `claude -p` (schema-enforced) **only** for TOC entries with no confident heading match or ambiguous anchors. Bounded, not a full sweep.
7. **Cache**: write `.cache/<hash>.sections.json`.

### 3.2 `extract` pipeline
1. **Load** the section map; auto-run `index` if missing or stale (hash mismatch).
2. **Select** (`extract/select`): `claude -p --allowedTools "Read,Grep,Glob" --json-schema <selection-schema>` with the user query; the model reads the dumped index/pages to locate matches and returns scored selections.
3. **Confirm** (`extract/confirm`, U2): apply confidence bands (§5.4); auto-include high-confidence; show low-confidence as a disambiguation shortlist; warn if selected pages > `--max-pages`; fail closed + prompt refine if nothing qualifies. `--dry-run` stops here; `--yes` auto-accepts high-confidence.
4. **Per selected page:**
   - **Text** (always, free): column-aware extraction.
   - **Geometric pre-pass** (`pdf/geometry`): from the operator list, compute bboxes of image XObjects + vector-path clusters + text blocks; flag pages with figure candidates or dense-math regions.
   - **Gated vision** (`extract/vision`, only flagged pages): render the page to PNG (`pdf/render` @ configured DPI) → `claude -p --allowedTools Read --json-schema <vision-schema>` → snap figure boxes, captions, equation LaTeX.
   - **Crop** figure regions from the render → `doc.assets/figNN.png`.
5. **Assemble** (`extract/assemble`, S2): Markdown in query order; per-section provenance header `## <Title> (source pp. X–Y)`; inline figures with caption + page cite; equations as `$…$` / `$$…$$`. → `doc.md` + `doc.assets/`.

---

## 4. CLI interface

```bash
# Build / refresh the cached section map
doccut index <pdf> [--force] [--cache-dir .cache]

# Extract sections matching a query into a new Markdown doc
doccut extract <pdf> --query "magnetism and electromagnetic induction" \
  [--out doc.md] [--max-pages 50] [--dpi 150] [--yes] [--dry-run] [--cache-dir .cache]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--query` | — (required) | Natural-language description of wanted sections |
| `--out` | `<query-slug>.md` | Output Markdown path; assets in `<out>.assets/` |
| `--max-pages` | 50 | Backstop cap on selected pages (warns/aborts above) |
| `--dpi` | 150 | Render DPI for vision + figure crops |
| `--yes` | false | Skip interactive confirm (auto-accept high-confidence) |
| `--dry-run` | false | Resolve + show proposal, do not extract |
| `--force` | false | Rebuild section-map cache even if present |

---

## 5. Data contracts

### 5.1 `sections.json` (cached section map)
```jsonc
{
  "pdfHash": "sha256:…",
  "pdfPath": "TestFile-Extract.pdf",
  "pageCount": 376,
  "builtAt": "2026-05-22T10:00:00Z",
  "sections": [
    {
      "id": "ch5",
      "title": "Magnetism and Matter",
      "level": 1,
      "startPage": 142,          // 1-based PDF page index
      "endPage": 168,
      "printedPage": 130,        // from TOC, optional
      "confidence": 0.92,
      "source": "toc-anchored"   // "toc-anchored" | "heuristic" | "llm-adjudicated"
    }
  ]
}
```

### 5.2 Selection schema (`--json-schema` for `extract` select step)
```jsonc
{
  "type": "object",
  "required": ["selections"],
  "properties": {
    "selections": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["title", "startPage", "endPage", "confidence"],
        "properties": {
          "sectionId":  { "type": "string" },
          "title":      { "type": "string" },
          "startPage":  { "type": "integer" },
          "endPage":    { "type": "integer" },
          "confidence": { "type": "number" },   // 0..1
          "reason":     { "type": "string" }
        }
      }
    }
  }
}
```

### 5.3 Vision schema (`--json-schema` for per-page vision step)
Coordinates are **rendered-image pixels** at the configured DPI, top-left origin `[x0, y0, x1, y1]`.
```jsonc
{
  "type": "object",
  "required": ["figures", "equations"],
  "properties": {
    "figures": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["bbox"],
        "properties": {
          "bbox":    { "type": "array", "items": {"type":"number"}, "minItems": 4, "maxItems": 4 },
          "caption": { "type": "string" },
          "kind":    { "type": "string", "enum": ["diagram","photo","graph","table"] }
        }
      }
    },
    "equations": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["latex"],
        "properties": {
          "bbox":    { "type": "array", "items": {"type":"number"}, "minItems": 4, "maxItems": 4 },
          "latex":   { "type": "string" },
          "display": { "type": "boolean" }   // true = block ($$), false = inline ($)
        }
      }
    }
  }
}
```

### 5.4 Confidence bands (initial defaults, tunable)
- `≥ 0.75` → **auto-include** in proposal.
- `0.45 – 0.75` → **flag** for disambiguation shortlist.
- `< 0.45` → **drop**.
- If nothing `≥ 0.75` and nothing in the flag band → **fail closed**, prompt query refinement.

---

## 6. Auth & cost model

> See memory `claude-p-subscription-auth` for full detail.

- **`claude -p` and the Agent SDK share auth.** The axis is **local Claude Code session (Pro/Max OAuth) vs `ANTHROPIC_API_KEY`** — not "SDK vs `-p`".
- **Dev / personal runs:** stay logged into Claude Code, leave `ANTHROPIC_API_KEY` unset, use plain `-p` → runs on Pro (subject to Pro limits).
- **`--bare` skips OAuth** → requires an API key. Use `--bare` only for API-key/CI runs; do **not** use it for Pro-local runs.
- **Billing change — June 15, 2026:** `claude -p`/SDK usage on subscription plans draws from a **separate monthly Agent SDK credit**, distinct from interactive limits. Before that date, it draws from interactive limits.
- **Cost driver = vision passes.** Bounded by: gated vision (text-only pages skip the model) + `--max-pages` cap. Build the tool to the API-key interface for portability; run on Pro during dev.

---

## 7. Project structure

```
documents-domain-prj/
├── package.json            # type: module; bin: doccut → tsx src/cli.ts
├── tsconfig.json
├── SPEC.md                 # this file
├── src/
│   ├── cli.ts              # commander: index, extract
│   ├── pdf/
│   │   ├── load.ts         # pdfjs loader; per-page text items + positions + font sizes
│   │   ├── columns.ts      # column clustering / reading-order
│   │   ├── render.ts       # @napi-rs/canvas page→PNG, region crop
│   │   └── geometry.ts     # operator-list bboxes, figure clustering, math-density
│   ├── index/
│   │   ├── headings.ts     # font-size + regex heading detection
│   │   ├── toc.ts          # printed-TOC parse
│   │   ├── anchor.ts       # TOC title → PDF heading page anchoring
│   │   └── build.ts        # section-map builder + claude -p adjudication
│   ├── extract/
│   │   ├── select.ts       # claude -p selection (schema)
│   │   ├── confirm.ts      # U2 interactive confirm + disambiguation
│   │   ├── vision.ts       # gated vision pass (schema)
│   │   └── assemble.ts     # S2 markdown + provenance
│   ├── claude.ts           # claude -p subprocess wrapper (--json-schema, --max-turns, --allowedTools)
│   └── cache.ts            # pdf hash + .cache I/O
├── test/                   # node:test integration vs TestFile-Extract.pdf
└── .cache/                 # gitignored: <hash>.sections.json, pages/*.txt
```

---

## 8. Build order (milestones)

0. **🚦 GO/NO-GO — image-Read smoke test.** Render one page → `claude -p "describe the figure" --allowedTools Read`. If headless `-p` cannot analyze the image, the gated-vision design (steps 5–6) must be redesigned. *Settle this first.*
1. **Scaffold** — package.json, tsconfig, commander skeleton, `claude.ts` wrapper, `cache.ts`.
2. **Text** — `pdf/load` + `pdf/columns`; verify column-aware order on the two-column test file.
3. **Index** — `headings` → `toc` → `anchor` → `build`; verify `sections.json` against the Physics PDF.
4. **Extract (resolve)** — `select` + `confirm`; validate with `--dry-run`.
5. **Figures** — `pdf/geometry` + `pdf/render` + gated `vision` + crop.
6. **Assemble** — `extract/assemble`; produce `doc.md` + `doc.assets/`.
7. **Later** — `--render pdf|docx` (Pandoc); figure-bbox refinement; MCP-based navigation (option C); batch vision.

---

## 9. Risks & open questions

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Headless `-p` image analysis unverified** | High (blocks vision design) | Build step 0 smoke test |
| Heuristic heading detection brittle across styles | Medium | M3 LLM adjudication of mismatches; verify on real doc |
| Geometric figure clustering false-merges | Medium | Vision validation snaps boxes |
| Two-column edge cases (column-spanning figures, headers/footers, multi-column math) | Medium | Tune column clustering; treat full-width blocks specially |
| Math fidelity depends on vision LaTeX quality | Medium | Display-equation crop fallback if LaTeX low-confidence |
| Pro usage budget / June 15 billing change | Medium | Gated vision + `--max-pages`; API-key fallback |
| Pages with no text layer (covers, full-page plates) | Low | Treat as "vision needed" or render as-is |

---

## 10. Out of scope (v1)
- Editing/modifying existing documents.
- Synthesized/rewritten narrative output (`--synthesize`, future).
- Multi-document merge.
- Non-Markdown primary output (PDF/DOCX are later `--render` targets).
- Distribution to other users on subscription auth (disallowed; use API key).
