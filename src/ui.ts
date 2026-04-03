import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PdfReviewBootData } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");
const pdfiumDir = join(__dirname, "..", "node_modules", "@embedpdf", "pdfium", "dist");

function escapeForInlineScript(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\\u2028/g, "\\\\u2028")
    .replace(/\\u2029/g, "\\\\u2029");
}

export function buildPdfReviewHtml(data: PdfReviewBootData): string {
  const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
  const appJs = readFileSync(join(webDir, "app.js"), "utf8");
  const pdfiumJs = readFileSync(join(pdfiumDir, "index.browser.js"), "utf8");
  const pdfiumWasm = readFileSync(join(pdfiumDir, "pdfium.wasm"));
  const pdfiumWasmBase64 = pdfiumWasm.toString("base64");

  const payload = escapeForInlineScript(JSON.stringify(data));

  return templateHtml
    .replace("__INLINE_DATA__", payload)
    .replace("__PDFIUM_JS__", pdfiumJs)
    .replace("__PDFIUM_WASM_BASE64__", pdfiumWasmBase64)
    .replace("__INLINE_JS__", appJs);
}
