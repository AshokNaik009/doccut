// Fast, deterministic unit tests for the non-LLM core. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { detectGutter } from "../src/pdf/columns.ts";
import { anchorSections, matchScore } from "../src/index/anchor.ts";
import { chooseLevel, sectionsFromOutline } from "../src/index/outline.ts";
import { parseToc } from "../src/index/toc.ts";
import { uniquePageCount } from "../src/extract/confirm.ts";
import { toPixels } from "../src/extract/vision.ts";
import type { TextItem } from "../src/types.ts";

const item = (x: number, width: number): TextItem => ({
  text: "word",
  x,
  y: 100,
  width,
  height: 10,
  fontSize: 11,
  fontName: "F",
  hasEOL: false,
});

test("detectGutter finds the central gutter of a two-column page", () => {
  const items: TextItem[] = [];
  for (let i = 0; i < 20; i++) items.push(item(50 + (i % 5) * 40, 35)); // left column
  for (let i = 0; i < 20; i++) items.push(item(350 + (i % 5) * 40, 35)); // right column
  const g = detectGutter(items, 600);
  assert.ok(g !== null, "expected a gutter");
  // Left column ends ≈245, right starts ≈350; the gutter must fall in that gap.
  assert.ok(g! > 240 && g! < 360, `gutter ${g} should sit in the empty band`);
});

test("detectGutter returns null for a single-column page", () => {
  const items: TextItem[] = [];
  for (let i = 0; i < 40; i++) items.push(item(50, 500)); // full-width lines
  assert.equal(detectGutter(items, 600), null);
});

test("parseToc reads numbered range entries", () => {
  const lines = [
    { pageNumber: 10, text: "Sr. No Title Page No" },
    { pageNumber: 10, text: "4 Thermodynamics 75-108" },
    { pageNumber: 10, text: "5 Oscillations 109-130" },
    { pageNumber: 10, text: "some prose line that is not an entry" },
  ];
  const toc = parseToc(lines);
  assert.equal(toc.length, 2);
  assert.deepEqual(toc[0], { number: 4, title: "Thermodynamics", printedStart: 75, printedEnd: 108 });
  assert.equal(toc[1]!.title, "Oscillations");
});

test("matchScore links a TOC entry to its heading", () => {
  const entry = { number: 5, title: "Oscillations", printedStart: 109, printedEnd: 130 };
  const strong = matchScore(entry, { pageNumber: 119, text: "5. Oscillations", fontSize: 18, bold: false, number: 5 });
  assert.ok(strong >= 0.85, `expected strong match, got ${strong}`);
  const weak = matchScore(entry, { pageNumber: 1, text: "5.1 Introduction", fontSize: 12, bold: true, number: 5 });
  assert.ok(weak < 0.85, `subsection should not match the chapter title strongly, got ${weak}`);
});

test("anchorSections derives offset and end pages", () => {
  const toc = [
    { number: 1, title: "Rotational Dynamics", printedStart: 1, printedEnd: 25 },
    { number: 2, title: "Fluids", printedStart: 26, printedEnd: 55 },
  ];
  const headings = [
    { pageNumber: 11, text: "1. Rotational Dynamics", fontSize: 18, bold: false, number: 1 },
    { pageNumber: 36, text: "2. Fluids", fontSize: 18, bold: false, number: 2 },
  ];
  const secs = anchorSections(toc, headings, 376);
  assert.equal(secs[0]!.startPage, 11); // printed 1 → PDF 11 (offset 10)
  assert.equal(secs[0]!.endPage, 35); // up to next start - 1
  assert.equal(secs[0]!.source, "toc-anchored");
  assert.equal(secs[1]!.startPage, 36);
});

test("chooseLevel descends past a single root to its children", () => {
  const single = [{ title: "Book", dest: null, items: [{ title: "A", dest: null }, { title: "B", dest: null }] }];
  assert.equal(chooseLevel(single).length, 2);
  const twoTop = [{ title: "A", dest: null }, { title: "B", dest: null }];
  assert.equal(chooseLevel(twoTop).length, 2);
});

test("sectionsFromOutline resolves dests (array + named) into ordered sections", async () => {
  const mockDoc = {
    async getOutline() {
      return [
        { title: "Chapter One", dest: [{ num: 1 }], items: [] },
        { title: "Chapter Two", dest: "named-two", items: [] },
      ];
    },
    async getDestination(name: string) {
      return name === "named-two" ? [{ num: 2 }] : null;
    },
    async getPageIndex(ref: { num: number }) {
      return ref.num === 1 ? 5 : 20; // 0-based → pages 6 and 21
    },
  } as unknown as PDFDocumentProxy;

  const secs = await sectionsFromOutline(mockDoc, 100);
  assert.ok(secs, "expected sections from the outline");
  assert.equal(secs!.length, 2);
  assert.equal(secs![0]!.startPage, 6);
  assert.equal(secs![0]!.endPage, 20); // up to next start - 1
  assert.equal(secs![0]!.source, "outline");
  assert.equal(secs![1]!.startPage, 21);
  assert.equal(secs![1]!.endPage, 100);
});

test("sectionsFromOutline returns null when there is no outline", async () => {
  const mockDoc = { async getOutline() { return null; } } as unknown as PDFDocumentProxy;
  assert.equal(await sectionsFromOutline(mockDoc, 100), null);
});

test("uniquePageCount de-duplicates overlapping ranges", () => {
  const sel = (startPage: number, endPage: number) => ({ title: "x", startPage, endPage, confidence: 1 });
  assert.equal(uniquePageCount([sel(1, 5), sel(4, 8)]), 8); // 1..8
  assert.equal(uniquePageCount([sel(10, 10)]), 1);
});

test("toPixels scales fractional bboxes and passes pixel bboxes through", () => {
  assert.deepEqual(toPixels([0.1, 0.2, 0.5, 0.6], 1000, 2000), [100, 400, 500, 1200]);
  assert.deepEqual(toPixels([100, 400, 500, 1200], 1000, 2000), [100, 400, 500, 1200]);
  // out-of-order coords are normalized
  assert.deepEqual(toPixels([500, 1200, 100, 400], 1000, 2000), [100, 400, 500, 1200]);
});
