import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PdfReviewBootData } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");
const pdfiumDir = join(__dirname, "..", "node_modules", "@embedpdf", "pdfium", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function escapeForInlineScript(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export interface PdfReviewServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function startPdfReviewServer(data: PdfReviewBootData): Promise<PdfReviewServer> {
  return new Promise((resolve, reject) => {
    const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
    const appJs = readFileSync(join(webDir, "app.js"), "utf8");
    const pdfiumJs = readFileSync(join(pdfiumDir, "index.browser.js"));
    const pdfiumWasm = readFileSync(join(pdfiumDir, "pdfium.wasm"));

    const bootPayload = escapeForInlineScript(JSON.stringify(data));

    const indexHtml = templateHtml
      .replace("__INLINE_DATA__", bootPayload)
      .replace("__INLINE_JS__", "/* loaded via /app.js */");

    const routes: Record<string, { body: Buffer | string; mime: string }> = {
      "/": { body: indexHtml, mime: MIME[".html"] },
      "/app.js": { body: appJs, mime: MIME[".js"] },
      "/pdfium.js": { body: pdfiumJs, mime: MIME[".js"] },
      "/pdfium.wasm": { body: pdfiumWasm, mime: MIME[".wasm"] },
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const route = routes[url];

      if (!route) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": route.mime,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(route.body);
    });

    server.on("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = addr.port;
      const url = `http://127.0.0.1:${port}`;

      resolve({
        url,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // Force close after 2s
            setTimeout(() => res(), 2000);
          }),
      });
    });
  });
}
