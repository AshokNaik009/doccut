// Geometric pre-pass: operator-list bboxes + figure clustering + math density. SPEC §3.2, decision 5.
//
// Purpose is to GATE the (costly) vision pass: decide which pages have figure
// candidates or dense math, and hand vision rough boxes to snap. We walk the
// operator list tracking the CTM, collect image + vector-path bounds, and
// cluster nearby ink into figure regions. Boxes are PDF points, top-left origin.
import type { PDFPageProxy } from "pdfjs-dist";
import type { BBox, PageGeometry, PageText } from "../types.ts";
import { pdfjs } from "./load.ts";

const { OPS } = pdfjs;
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Multiply two 2D affine matrices (PDF order: result = m1 ∘ m2). */
function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Transform a unit/path-space box by a matrix → axis-aligned bbox (PDF coords). */
function transformBox(m: Matrix, b: BBox): BBox {
  const pts: [number, number][] = [
    apply(m, b[0], b[1]),
    apply(m, b[2], b[1]),
    apply(m, b[2], b[3]),
    apply(m, b[0], b[3]),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const MATH_GLYPHS = /[∫∑∏∂√±×÷≈≤≥≠≡→←↔∞∇∝∮⊥∈∉⇒⇔αβγδεθλμνπρστφψωΩΔΘΛΦΨΓ]/;

export async function analyzeGeometry(
  page: PDFPageProxy,
  pageText: PageText,
): Promise<PageGeometry> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const pageHeight = pageText.height;

  // CTM stack. The base matrix is identity at viewport scale 1 (PDF points).
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  const inkBoxes: BBox[] = [];

  const pushInk = (bUserSpace: BBox) => {
    // Convert PDF (bottom-left) → top-left origin.
    const [x0, y0, x1, y1] = bUserSpace;
    const top = pageHeight - Math.max(y0, y1);
    const bottom = pageHeight - Math.min(y0, y1);
    const box: BBox = [Math.min(x0, x1), top, Math.max(x0, x1), bottom];
    if (isReasonable(box, pageText.width, pageHeight)) inkBoxes.push(box);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? IDENTITY;
        break;
      case OPS.transform:
        ctm = mul(ctm, args as unknown as Matrix);
        break;
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        // Images are drawn in the unit square, placed by the CTM.
        pushInk(transformBox(ctm, [0, 0, 1, 1]));
        break;
      case OPS.constructPath: {
        // v4 args: [opsArray, coordsArray, minMaxFloat32]. The minMax is the
        // path bounds in path space; transform by CTM for the device-space box.
        const minMax = args[2];
        if (minMax && (minMax as ArrayLike<number>).length >= 4) {
          const mm = minMax as ArrayLike<number>;
          pushInk(transformBox(ctm, [mm[0]!, mm[1]!, mm[2]!, mm[3]!]));
        }
        break;
      }
      default:
        break;
    }
  }

  const figureCandidates = clusterBoxes(inkBoxes);
  const mathDense = isMathDense(pageText);

  return {
    pageNumber: pageText.pageNumber,
    width: pageText.width,
    height: pageHeight,
    figureCandidates,
    mathDense,
    needsVision: figureCandidates.length > 0 || mathDense,
  };
}

/** Reject degenerate / page-sized boxes that aren't real figures. */
function isReasonable(b: BBox, w: number, h: number): boolean {
  const bw = b[2] - b[0];
  const bh = b[3] - b[1];
  if (bw < 8 || bh < 8) return false; // hairlines, rule strokes
  if (bw > w * 0.97 && bh > h * 0.97) return false; // full-page background
  return true;
}

/** Union boxes that overlap or sit within a small gap — a diagram is many strokes. */
function clusterBoxes(boxes: BBox[]): BBox[] {
  const GAP = 12;
  const clusters: BBox[] = [];
  for (const b of boxes) {
    let merged = false;
    for (let i = 0; i < clusters.length; i++) {
      if (near(clusters[i]!, b, GAP)) {
        clusters[i] = union(clusters[i]!, b);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push(b);
  }
  // A second pass catches transitive merges.
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (near(clusters[i]!, clusters[j]!, GAP)) {
          clusters[i] = union(clusters[i]!, clusters[j]!);
          clusters.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  // Keep clusters big enough to be a figure.
  return clusters.filter((c) => c[2] - c[0] >= 40 && c[3] - c[1] >= 40);
}

function near(a: BBox, b: BBox, gap: number): boolean {
  return !(b[0] > a[2] + gap || b[2] < a[0] - gap || b[1] > a[3] + gap || b[3] < a[1] - gap);
}

function union(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function isMathDense(page: PageText): boolean {
  let glyphs = 0;
  for (const it of page.items) {
    const m = it.text.match(new RegExp(MATH_GLYPHS, "g"));
    if (m) glyphs += m.length;
  }
  return glyphs >= 6;
}
