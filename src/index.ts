import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { open, type GlimpseWindow } from "glimpseui";
import { startPdfReviewServer, type PdfReviewServer } from "./server.js";
import type {
  PdfAnnotationComment,
  PdfReviewAskPayload,
  PdfReviewSource,
  PdfReviewWindowMessage,
} from "./types.js";

const MAX_PDF_BYTES = 25 * 1024 * 1024;

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function expandHome(value: string): string {
  if (!value.startsWith("~")) return value;
  const home = process.env.HOME;
  if (!home) return value;
  return value === "~" ? home : value.replace(/^~\//, `${home}/`);
}

function clampText(value: string, maxLength = 320): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function withSanitizedGlimpseEnv<T>(fn: () => T): T {
  const previousLd = process.env.LD_LIBRARY_PATH;
  const previousDbusSystem = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  try {
    if (process.platform === "linux") {
      const ld = process.env.LD_LIBRARY_PATH ?? "";
      process.env.LD_LIBRARY_PATH = ld
        .split(":")
        .filter((p) => p.length > 0 && !/\/anaconda3\/lib\/?$/.test(p))
        .join(":");
      if ((process.env.DBUS_SYSTEM_BUS_ADDRESS ?? "").includes("anaconda3")) {
        delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
      }
    }
    return fn();
  } finally {
    if (previousLd == null) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previousLd;
    if (previousDbusSystem == null) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    else process.env.DBUS_SYSTEM_BUS_ADDRESS = previousDbusSystem;
  }
}

async function loadPdfSource(input: string, cwd: string): Promise<PdfReviewSource> {
  if (isUrl(input)) {
    const response = await fetch(input);
    if (!response.ok) throw new Error(`Failed to fetch PDF: HTTP ${response.status}`);
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : 0;
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      throw new Error(`PDF too large (${Math.round(contentLength / 1024 / 1024)}MB). Limit: ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > MAX_PDF_BYTES) {
      throw new Error(`PDF too large (${Math.round(buffer.byteLength / 1024 / 1024)}MB). Limit: ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB.`);
    }
    const url = new URL(input);
    const fileName = decodeURIComponent(url.pathname.split("/").pop() || "document.pdf");
    return {
      kind: "url", input, displayName: input, title: fileName || "document.pdf",
      bytesBase64: buffer.toString("base64"), byteLength: buffer.byteLength,
    };
  }

  const expanded = expandHome(input);
  const absolutePath = resolve(cwd, expanded);
  await access(absolutePath, constants.R_OK);
  const buffer = await readFile(absolutePath);
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF too large (${Math.round(buffer.byteLength / 1024 / 1024)}MB). Limit: ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB.`);
  }
  return {
    kind: "file", input: absolutePath, displayName: absolutePath,
    title: basename(absolutePath) || "document.pdf",
    bytesBase64: buffer.toString("base64"), byteLength: buffer.byteLength,
  };
}

function buildPrompt(
  source: PdfReviewSource,
  newComments: PdfAnnotationComment[],
  totalSent: number,
): string {
  const lines: string[] = [
    `## PDF review: ${source.title}`,
    `- Source: ${source.displayName}`,
    "",
  ];

  if (totalSent > 0) {
    lines.push(`_${totalSent} earlier note(s) already discussed._`, "");
  }

  lines.push("New notes:", "");

  for (let i = 0; i < newComments.length; i++) {
    const c = newComments[i];
    lines.push(
      `${i + 1}. Page ${c.pageNumber}`,
      `   - Quote: "${clampText(c.quote, 500)}"`,
      `   - Note: ${c.comment.trim()}`,
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

export default function pdfReviewExtension(pi: ExtensionAPI) {
  let activeWindow: GlimpseWindow | null = null;
  let activeServer: PdfReviewServer | null = null;
  let activeSource: PdfReviewSource | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const w = activeWindow;
    activeWindow = null;
    activeSource = null;
    try { w.close(); } catch {}
    if (activeServer) {
      const s = activeServer;
      activeServer = null;
      s.close().catch(() => {});
    }
  }

  function handleAskMessage(payload: PdfReviewAskPayload): void {
    if (!activeSource) return;
    const newComments = payload.comments;
    if (newComments.length === 0) {
      return;
    }
    const prompt = buildPrompt(activeSource, newComments, payload.totalSent);
    pi.sendUserMessage(prompt);
  }

  async function reviewPdf(ctx: ExtensionCommandContext, rawInput?: string): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("PDF review window already open.", "warning");
      return;
    }

    let sourceInput = rawInput?.trim();
    if (!sourceInput) {
      sourceInput = await ctx.ui.input("PDF path or URL", "./file.pdf or https://example.com/file.pdf");
    }
    if (!sourceInput) {
      ctx.ui.notify("PDF review cancelled.", "info");
      return;
    }

    ctx.ui.notify("Loading PDF…", "info");
    const source = await loadPdfSource(sourceInput, ctx.cwd);
    activeSource = source;

    ctx.ui.notify("Starting viewer…", "info");
    const server = await startPdfReviewServer({ source, maxComments: 200 });
    activeServer = server;

    const loaderHtml = `<html><body style="background:#111315;color:#ececec;font-family:monospace;padding:20px">Loading viewer…<script>window.location.href="${server.url}";</script></body></html>`;
    const window = withSanitizedGlimpseEnv(() =>
      open(loaderHtml, {
        width: 1500, height: 980,
        title: `pi pdf review — ${source.title}`,
      }),
    );
    activeWindow = window;

    // Persistent message listener — window stays open
    window.on("message", (data: unknown) => {
      const msg = data as PdfReviewWindowMessage;
      if (msg == null || typeof msg !== "object" || !("type" in msg)) return;

      if (msg.type === "ask") {
        handleAskMessage(msg as PdfReviewAskPayload);
      } else if (msg.type === "cancel") {
        closeActiveWindow();
        ctx.ui.notify("PDF review closed.", "info");
      }
    });

    window.on("closed", () => {
      if (activeWindow === window) {
        activeWindow = null;
        activeSource = null;
      }
      if (activeServer) {
        const s = activeServer;
        activeServer = null;
        s.close().catch(() => {});
      }
    });

    window.on("error", (error: Error) => {
      ctx.ui.notify(`PDF review error: ${error.message}`, "error");
      closeActiveWindow();
    });

    ctx.ui.notify("PDF review window opened. Add notes and press A or click Ask Pi.", "info");
  }

  pi.registerCommand("pdf-review", {
    description: "Open a native PDF review window for a local file or URL.",
    handler: async (args, ctx) => {
      try {
        await reviewPdf(ctx, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`PDF review failed: ${message}`, "error");
      }
    },
  });
}
