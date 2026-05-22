// pdfjs loader: per-page text items with positions + font sizes. SPEC §3.1.
import "./canvas-env.ts"; // env shims (getBuiltinModule, render globals) — load before pdfjs use
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
// The legacy build runs an in-process ("fake") worker, which is what we want
// in Node — no separate worker thread, no DOM.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageText, TextItem } from "../types.ts";
import { canvasFactory } from "./canvas-env.ts";

const require = createRequire(import.meta.url);
const pdfjsPkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
const STANDARD_FONTS = path.join(pdfjsPkgDir, "standard_fonts") + path.sep;
const CMAPS = path.join(pdfjsPkgDir, "cmaps") + path.sep;

/** Open a PDF for reading. Caller must `.destroy()` the returned document. */
export async function loadDocument(pdfPath: string): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const params = {
    data,
    standardFontDataUrl: STANDARD_FONTS,
    cMapUrl: CMAPS,
    cMapPacked: true,
    useSystemFonts: true,
    // Render intermediate canvases via @napi-rs/canvas (no `canvas` package).
    // Valid pdfjs option at runtime; not present in the v4 type defs.
    canvasFactory,
    // Keep pdfjs quiet about recoverable font/render warnings.
    verbosity: 0,
  };
  const task = pdfjs.getDocument(params as Parameters<typeof pdfjs.getDocument>[0]);
  return await task.promise;
}

/** Extract positioned text items for one 1-based page, in top-left origin points. */
export async function extractPageText(doc: PDFDocumentProxy, pageNumber: number): Promise<PageText> {
  const page: PDFPageProxy = await doc.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const content = await page.getTextContent();

    const items: TextItem[] = [];
    for (const raw of content.items) {
      // pdfjs TextItem vs TextMarkedContent — only the former has `str`.
      if (!("str" in raw)) continue;
      const t = raw;
      const str = t.str;
      if (str.length === 0 && !t.hasEOL) continue;

      const transform = t.transform as number[];
      const x = transform[4] ?? 0;
      const baselinePdf = transform[5] ?? 0; // y of baseline, PDF (bottom-left) coords
      const height = t.height || Math.hypot(transform[1] ?? 0, transform[3] ?? 0);
      const fontSize = Math.round((Math.hypot(transform[1] ?? 0, transform[3] ?? 0) || height) * 10) / 10;

      items.push({
        text: str,
        x,
        // Top edge in top-left origin coordinates (y grows downward).
        y: pageHeight - (baselinePdf + height),
        width: t.width,
        height,
        fontSize,
        fontName: t.fontName,
        hasEOL: t.hasEOL,
      });
    }

    return {
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      items,
    };
  } finally {
    page.cleanup();
  }
}

export { pdfjs };
