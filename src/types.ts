// Shared data contracts for doccut. See SPEC.md §5.

/** A detected section in the cached section map (SPEC §5.1). */
export interface Section {
  id: string;
  title: string;
  level: number;
  /** 1-based PDF page index. */
  startPage: number;
  endPage: number;
  /** Printed page number from the TOC, if known. */
  printedPage?: number;
  confidence: number;
  source: "toc-anchored" | "heuristic" | "llm-adjudicated";
}

/** Cached section map written to .cache/<hash>.sections.json (SPEC §5.1). */
export interface SectionMap {
  pdfHash: string;
  pdfPath: string;
  pageCount: number;
  builtAt: string;
  sections: Section[];
}

/** One selection returned by the agentic select step (SPEC §5.2). */
export interface Selection {
  sectionId?: string;
  title: string;
  startPage: number;
  endPage: number;
  /** 0..1 */
  confidence: number;
  reason?: string;
}

export interface SelectionResult {
  selections: Selection[];
}

/** A pixel-space bounding box [x0, y0, x1, y1], top-left origin. */
export type BBox = [number, number, number, number];

/** A figure detected on a page by the vision pass (SPEC §5.3). */
export interface VisionFigure {
  bbox: BBox;
  caption?: string;
  kind?: "diagram" | "photo" | "graph" | "table";
}

/** An equation detected on a page by the vision pass (SPEC §5.3). */
export interface VisionEquation {
  bbox?: BBox;
  latex: string;
  /** true = block ($$), false = inline ($). */
  display?: boolean;
}

export interface VisionResult {
  figures: VisionFigure[];
  equations: VisionEquation[];
}

/** A single text token with its page-space position (pdf points, top-left origin). */
export interface TextItem {
  text: string;
  /** Left edge, in PDF points from the left of the page. */
  x: number;
  /** Top edge, in PDF points from the top of the page. */
  y: number;
  width: number;
  height: number;
  /** Font size in points (derived from the text transform). */
  fontSize: number;
  fontName: string;
  /** Whether pdfjs marked this as the end of a text run with trailing whitespace. */
  hasEOL: boolean;
}

/** Per-page extraction result from pdf/load. */
export interface PageText {
  /** 1-based PDF page index. */
  pageNumber: number;
  width: number;
  height: number;
  items: TextItem[];
}

/** Geometric pre-pass output for one page (SPEC §3.2). */
export interface PageGeometry {
  pageNumber: number;
  width: number;
  height: number;
  /** Candidate figure regions in PDF points, top-left origin. */
  figureCandidates: BBox[];
  /** True if dense math-like content was detected. */
  mathDense: boolean;
  /** True if the page warrants a vision pass. */
  needsVision: boolean;
}
