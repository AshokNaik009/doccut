// PDF hashing + .cache I/O. See SPEC §7, §3.1.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SectionMap } from "./types.ts";

/** sha256 of the PDF file contents, streamed so large files don't blow memory. */
export async function hashPdf(pdfPath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(pdfPath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Layout of cache artifacts for one PDF, keyed by its content hash. */
export class Cache {
  constructor(
    readonly cacheDir: string,
    readonly hash: string,
  ) {}

  static async open(pdfPath: string, cacheDir: string): Promise<Cache> {
    const hash = await hashPdf(pdfPath);
    return new Cache(path.resolve(cacheDir), hash);
  }

  get sectionsPath(): string {
    return path.join(this.cacheDir, `${this.hash}.sections.json`);
  }

  /** Directory holding per-page reading-ordered text dumps. */
  get pagesDir(): string {
    return path.join(this.cacheDir, this.hash, "pages");
  }

  pageTextPath(pageNumber: number): string {
    return path.join(this.pagesDir, `${String(pageNumber).padStart(4, "0")}.txt`);
  }

  async ensureDirs(): Promise<void> {
    await fs.mkdir(this.pagesDir, { recursive: true });
  }

  async hasSections(): Promise<boolean> {
    return await exists(this.sectionsPath);
  }

  async readSections(): Promise<SectionMap> {
    const raw = await fs.readFile(this.sectionsPath, "utf8");
    return JSON.parse(raw) as SectionMap;
  }

  async writeSections(map: SectionMap): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(this.sectionsPath, JSON.stringify(map, null, 2), "utf8");
  }

  async writePageText(pageNumber: number, text: string): Promise<void> {
    await fs.writeFile(this.pageTextPath(pageNumber), text, "utf8");
  }

  async readPageText(pageNumber: number): Promise<string> {
    return await fs.readFile(this.pageTextPath(pageNumber), "utf8");
  }

  /** True once at least the first page dump exists (cheap freshness probe). */
  async hasPageDumps(): Promise<boolean> {
    return await exists(this.pageTextPath(1));
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
