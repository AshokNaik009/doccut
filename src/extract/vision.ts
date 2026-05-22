// GATED VISION: render flagged page → claude -p reads it → figure boxes + LaTeX. SPEC §3.2, §5.3.
import * as path from "node:path";
import { runClaudeJson } from "../claude.ts";
import type { BBox, VisionResult } from "../types.ts";
import { VISION_SCHEMA } from "./schemas.ts";

/**
 * Run the vision pass on a rendered page image. `width`/`height` are the
 * rendered pixel dimensions; returned bboxes are normalized to pixels.
 */
export async function runVision(
  pngPath: string,
  width: number,
  height: number,
): Promise<{ result: VisionResult; costUsd?: number }> {
  const dir = path.dirname(path.resolve(pngPath));
  const prompt = `Read the image file ${path.resolve(pngPath)}. It is a rendered PDF page,
${width}×${height} pixels (top-left origin).

Identify:
1. Figures — diagrams, photographs, graphs, or tables. For each give a tight bounding box
   [x0,y0,x1,y1] in PIXELS, a short caption (use the printed caption if present), and its kind.
2. Equations — give the LaTeX and whether each is display (block) or inline. Include a pixel
   bbox when the equation is a distinct displayed block.

Do not report running headers, footers, page numbers, or body paragraphs as figures.
If the page has no real figures or equations, return empty arrays.`;

  const { data, costUsd } = await runClaudeJson<VisionResult>(prompt, VISION_SCHEMA, {
    allowedTools: ["Read"],
    addDirs: [dir],
    cwd: dir,
  });

  const figures = (data.figures ?? [])
    .filter((f) => Array.isArray(f.bbox) && f.bbox.length === 4)
    .map((f) => ({ ...f, bbox: toPixels(f.bbox, width, height) }));
  const equations = (data.equations ?? [])
    .filter((e) => typeof e.latex === "string" && e.latex.trim().length > 0)
    .map((e) => ({
      ...e,
      bbox: e.bbox && e.bbox.length === 4 ? toPixels(e.bbox, width, height) : undefined,
    }));

  return { result: { figures, equations }, costUsd };
}

/**
 * Models return either pixel coords or normalized fractions (observed both).
 * If every coordinate is ≤ 1.5, treat as fractions of the image and scale.
 */
export function toPixels(bbox: BBox, width: number, height: number): BBox {
  const fractional = bbox.every((v) => v >= 0 && v <= 1.5);
  const b: BBox = fractional
    ? [bbox[0] * width, bbox[1] * height, bbox[2] * width, bbox[3] * height]
    : bbox;
  return [
    clamp(Math.min(b[0], b[2]), 0, width),
    clamp(Math.min(b[1], b[3]), 0, height),
    clamp(Math.max(b[0], b[2]), 0, width),
    clamp(Math.max(b[1], b[3]), 0, height),
  ];
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
