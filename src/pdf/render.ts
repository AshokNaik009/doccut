// Page rendering + region cropping via @napi-rs/canvas. SPEC §3.2, decision 4.
import "./canvas-env.ts"; // installs DOMMatrix/Path2D/ImageData globals (must precede render)
import * as fs from "node:fs/promises";
import { type Canvas, createCanvas } from "@napi-rs/canvas";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { BBox } from "../types.ts";

/** The canvas-context type pdfjs's render() expects (avoids needing the DOM lib). */
type RenderCtx = Parameters<PDFPageProxy["render"]>[0]["canvasContext"];

export interface RenderedPage {
  canvas: Canvas;
  /** Rendered pixel dimensions. */
  width: number;
  height: number;
  /** points→pixels factor (dpi / 72). */
  scale: number;
}

/** Render a 1-based page to an in-memory canvas at the given DPI. */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  dpi: number,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  try {
    const scale = dpi / 72;
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    // White background — PDFs assume paper, transparent canvas would look wrong.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);

    await page.render({
      // @napi-rs/canvas's 2d context is API-compatible with what pdfjs needs.
      canvasContext: context as unknown as RenderCtx,
      viewport,
    }).promise;

    return { canvas, width, height, scale };
  } finally {
    page.cleanup();
  }
}

/** Encode a canvas to a PNG file. */
export async function saveCanvasPng(canvas: Canvas, outPath: string): Promise<void> {
  const buf = await canvas.encode("png");
  await fs.writeFile(outPath, buf);
}

/** Render a page straight to a PNG file; returns its pixel dimensions + scale. */
export async function renderPageToPng(
  doc: PDFDocumentProxy,
  pageNumber: number,
  dpi: number,
  outPath: string,
): Promise<{ width: number; height: number; scale: number }> {
  const r = await renderPage(doc, pageNumber, dpi);
  await saveCanvasPng(r.canvas, outPath);
  return { width: r.width, height: r.height, scale: r.scale };
}

/** Crop a pixel-space bbox out of a rendered page and write it as a PNG. */
export async function cropToPng(rendered: RenderedPage, bbox: BBox, outPath: string): Promise<void> {
  const [x0, y0, x1, y1] = clampBox(bbox, rendered.width, rendered.height);
  const w = Math.max(1, Math.round(x1 - x0));
  const h = Math.max(1, Math.round(y1 - y0));
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.drawImage(rendered.canvas, Math.round(x0), Math.round(y0), w, h, 0, 0, w, h);
  await saveCanvasPng(trimWhitespace(out), outPath);
}

/**
 * Trim near-white margins around the content of a canvas (the vision bbox is
 * often loose), keeping a small uniform padding. Returns the original canvas if
 * it's effectively blank.
 */
export function trimWhitespace(canvas: Canvas, whiteThreshold = 248, pad = 6): Canvas {
  const ctx = canvas.getContext("2d");
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const isInk =
        data[i + 3]! > 16 &&
        (data[i]! < whiteThreshold || data[i + 1]! < whiteThreshold || data[i + 2]! < whiteThreshold);
      if (isInk) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return canvas; // all white / empty

  const nx = Math.max(0, minX - pad);
  const ny = Math.max(0, minY - pad);
  const nw = Math.min(width, maxX + pad) - nx + 1;
  const nh = Math.min(height, maxY + pad) - ny + 1;
  if (nx === 0 && ny === 0 && nw >= width && nh >= height) return canvas; // nothing to trim

  const trimmed = createCanvas(nw, nh);
  const tctx = trimmed.getContext("2d");
  tctx.drawImage(canvas, nx, ny, nw, nh, 0, 0, nw, nh);
  return trimmed;
}

function clampBox(bbox: BBox, width: number, height: number): BBox {
  const x0 = Math.max(0, Math.min(bbox[0], bbox[2]));
  const y0 = Math.max(0, Math.min(bbox[1], bbox[3]));
  const x1 = Math.min(width, Math.max(bbox[0], bbox[2]));
  const y1 = Math.min(height, Math.max(bbox[1], bbox[3]));
  return [x0, y0, x1, y1];
}
