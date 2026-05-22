// Node environment shims so pdfjs can render with @napi-rs/canvas.
//
// 1. pdfjs (v4) calls process.getBuiltinModule(...), added only in Node 22.3.
//    On older 22.x we polyfill it via createRequire.
// 2. pdfjs needs DOMMatrix/Path2D/ImageData as globals during render.
// 3. pdfjs creates intermediate canvases (soft masks, patterns, groups) through
//    a CanvasFactory; the default one requires the `canvas` package. We supply
//    one backed by @napi-rs/canvas so that dependency is never needed. SPEC §9.
import { createRequire } from "node:module";
import { type Canvas, createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
if (typeof proc.getBuiltinModule !== "function") {
  const req = createRequire(import.meta.url);
  proc.getBuiltinModule = (id: string) => req(id.startsWith("node:") ? id : `node:${id}`);
}

const g = globalThis as unknown as Record<string, unknown>;
g.DOMMatrix ??= DOMMatrix;
g.ImageData ??= ImageData;
g.Path2D ??= Path2D;

interface CanvasAndContext {
  canvas: Canvas | null;
  context: ReturnType<Canvas["getContext"]> | null;
}

/** A pdfjs CanvasFactory backed by @napi-rs/canvas (no `canvas` package needed). */
export class NapiCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: CanvasAndContext, width: number, height: number): void {
    if (!cc.canvas) return;
    cc.canvas.width = Math.max(1, width);
    cc.canvas.height = Math.max(1, height);
  }
  destroy(cc: CanvasAndContext): void {
    if (cc.canvas) {
      cc.canvas.width = 0;
      cc.canvas.height = 0;
    }
    cc.canvas = null;
    cc.context = null;
  }
}

export const canvasFactory = new NapiCanvasFactory();
