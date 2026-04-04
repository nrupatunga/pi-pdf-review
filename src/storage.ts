import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PdfAnnotationComment } from "./types.js";

const STORAGE_DIR = join(process.env.HOME ?? "/tmp", ".pi", "agent", "pdf-reviews");

function ensureDir(): void {
  mkdirSync(STORAGE_DIR, { recursive: true });
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function filePath(source: string): string {
  return join(STORAGE_DIR, `${hashSource(source)}.json`);
}

export interface StoredPdfReview {
  source: string;
  title: string;
  lastOpened: number;
  comments: PdfAnnotationComment[];
}

export function loadReview(source: string): StoredPdfReview | null {
  ensureDir();
  const path = filePath(source);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredPdfReview;
  } catch {
    return null;
  }
}

export function saveReview(data: StoredPdfReview): void {
  ensureDir();
  const path = filePath(data.source);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

export function listReviews(): StoredPdfReview[] {
  ensureDir();
  const files = readdirSync(STORAGE_DIR).filter((f) => f.endsWith(".json"));
  const reviews: StoredPdfReview[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(STORAGE_DIR, file), "utf8")) as StoredPdfReview;
      reviews.push(data);
    } catch { /* skip corrupt files */ }
  }
  return reviews.sort((a, b) => b.lastOpened - a.lastOpened);
}
