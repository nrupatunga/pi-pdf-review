import { init } from "/pdfium.js";

const boot = window.__PDF_REVIEW_BOOT__;

const docTitleEl = document.getElementById("doc-title");
const docSubtitleEl = document.getElementById("doc-subtitle");
const statusPillEl = document.getElementById("status-pill");
const commentCountEl = document.getElementById("comment-count");
const commentSelectionButton = document.getElementById("comment-selection");
const toggleCommentsButton = document.getElementById("toggle-comments");
const askPiButton = document.getElementById("submit-review");
const cancelButton = document.getElementById("cancel-review");
const drawerEl = document.getElementById("comments-drawer");
const closeDrawerButton = document.getElementById("close-drawer");
const commentListEl = document.getElementById("comment-list");
const inlineCommentEl = document.getElementById("inline-comment");
const inlineQuoteEl = document.getElementById("inline-quote");
const inlineInputEl = document.getElementById("inline-input");
const viewerEl = document.getElementById("pdf-viewer");
const helpOverlay = document.getElementById("help-overlay");

const state = {
  pdfium: null,
  docPtr: null,
  pageCount: 0,
  scale: 1.5,
  renderVersion: 0,
  comments: [],       // { id, kind, pageNumber, quote, comment, rects, createdAt, sent, startIdx, endIdx }
  pendingSelection: null,
  focusedCommentId: null,
  commentsDrawerOpen: false,
  dragState: null,
  inlineKind: "question", // "question" or "note"
  pageRefs: new Map(),
  saving: false,
};

// ─── Utilities ───

function setStatus(text) { statusPillEl.textContent = text; }
function setCommentCount() {
  const highlights = state.comments.filter(c => c.kind === "highlight").length;
  const questions = state.comments.filter(c => c.kind === "question");
  const notes = state.comments.filter(c => c.kind === "note").length;
  const unsent = questions.filter(c => !c.sent).length;
  const parts = [];
  if (highlights > 0) parts.push(`${highlights}h`);
  if (questions.length > 0) parts.push(`${unsent > 0 ? unsent + "/" : ""}${questions.length}q`);
  if (notes > 0) parts.push(`${notes}n`);
  commentCountEl.textContent = parts.join(" ") || "0";
}
function setCommentsDrawerOpen(open) {
  state.commentsDrawerOpen = open;
  drawerEl.classList.toggle("open", open);
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function decodeBase64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function clampText(value, maxLength = 280) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function sendToExtension(payload) {
  if (window.glimpse?.send) { window.glimpse.send(payload); return; }
  console.warn("glimpse bridge unavailable", payload);
}

let saveDebounce = null;
function autoSave() {
  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => {
    fetch("/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.comments),
    }).catch(() => {});
  }, 500);
}

let toastTimer = null;
function showToast(text, duration = 2000) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}
function closeWindow(payload) {
  if (window.glimpse?.send) { window.glimpse.send(payload); window.glimpse.close(); return; }
}
function isInlineOpen() { return inlineCommentEl.classList.contains("open"); }
function isHelpOpen() { return helpOverlay.classList.contains("open"); }

// ─── PDFium helpers ───

function renderPageToCanvas(pdfium, docPtr, pageIndex, canvas, scale) {
  const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!pagePtr) return;
  try {
    const widthPts = pdfium.pdfium._FPDF_GetPageWidthF(pagePtr);
    const heightPts = pdfium.pdfium._FPDF_GetPageHeightF(pagePtr);
    const dpr = window.devicePixelRatio || 1;
    const renderWidth = Math.floor(widthPts * scale * dpr);
    const renderHeight = Math.floor(heightPts * scale * dpr);
    const cssWidth = Math.floor(widthPts * scale);
    const cssHeight = Math.floor(heightPts * scale);
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const bitmapPtr = pdfium.pdfium._FPDFBitmap_Create(renderWidth, renderHeight, 0);
    pdfium.pdfium._FPDFBitmap_FillRect(bitmapPtr, 0, 0, renderWidth, renderHeight, 0xFFFFFFFF);
    pdfium.pdfium._FPDF_RenderPageBitmap(bitmapPtr, pagePtr, 0, 0, renderWidth, renderHeight, 0, 0x01 | 0x10);
    const bufferPtr = pdfium.pdfium._FPDFBitmap_GetBuffer(bitmapPtr);
    const src = new Uint8ClampedArray(pdfium.pdfium.HEAPU8.buffer, bufferPtr, renderWidth * renderHeight * 4).slice();
    pdfium.pdfium._FPDFBitmap_Destroy(bitmapPtr);
    for (let i = 0; i < src.length; i += 4) { const b = src[i]; src[i] = src[i + 2]; src[i + 2] = b; }
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(src, renderWidth, renderHeight), 0, 0);
    return { cssWidth, cssHeight };
  } finally { pdfium.FPDF_ClosePage(pagePtr); }
}

function getPageDimsPts(pdfium, docPtr, pageIndex) {
  const p = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!p) return { w: 0, h: 0 };
  const w = pdfium.pdfium._FPDF_GetPageWidthF(p);
  const h = pdfium.pdfium._FPDF_GetPageHeightF(p);
  pdfium.FPDF_ClosePage(p);
  return { w, h };
}

function cssToPageCoords(cssX, cssY, cssWidth, cssHeight, pageWidthPts, pageHeightPts) {
  return { pdfX: (cssX / cssWidth) * pageWidthPts, pdfY: (1 - cssY / cssHeight) * pageHeightPts };
}

function getTextAtPoint(pdfium, docPtr, pageIndex, pdfX, pdfY) {
  const p = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!p) return -1;
  try {
    const tp = pdfium.FPDFText_LoadPage(p);
    if (!tp) return -1;
    try { return pdfium.FPDFText_GetCharIndexAtPos(tp, pdfX, pdfY, 10, 10); }
    finally { pdfium.FPDFText_ClosePage(tp); }
  } finally { pdfium.FPDF_ClosePage(p); }
}

function getTextBetween(pdfium, docPtr, pageIndex, startIdx, endIdx) {
  const lo = Math.min(startIdx, endIdx), hi = Math.max(startIdx, endIdx);
  const count = hi - lo + 1;
  if (count <= 0) return "";
  const p = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!p) return "";
  try {
    const tp = pdfium.FPDFText_LoadPage(p);
    if (!tp) return "";
    try {
      const bufPtr = pdfium.pdfium._malloc((count + 1) * 2);
      try {
        pdfium.FPDFText_GetText(tp, lo, count, bufPtr);
        return String.fromCharCode(...new Uint16Array(pdfium.pdfium.HEAPU8.buffer, bufPtr, count));
      } finally { pdfium.pdfium._free(bufPtr); }
    } finally { pdfium.FPDFText_ClosePage(tp); }
  } finally { pdfium.FPDF_ClosePage(p); }
}

function getCharRects(pdfium, docPtr, pageIndex, startIdx, endIdx, cssWidth, cssHeight) {
  const lo = Math.min(startIdx, endIdx), hi = Math.max(startIdx, endIdx);
  const p = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!p) return [];
  const pageW = pdfium.pdfium._FPDF_GetPageWidthF(p);
  const pageH = pdfium.pdfium._FPDF_GetPageHeightF(p);
  const tp = pdfium.FPDFText_LoadPage(p);
  if (!tp) { pdfium.FPDF_ClosePage(p); return []; }
  const lp = pdfium.pdfium._malloc(8), rp = pdfium.pdfium._malloc(8);
  const bp = pdfium.pdfium._malloc(8), tp2 = pdfium.pdfium._malloc(8);
  const sx = cssWidth / pageW, sy = cssHeight / pageH;
  const lines = [];
  let line = null;
  for (let i = lo; i <= hi; i++) {
    const ok = pdfium.FPDFText_GetCharBox(tp, i, lp, rp, bp, tp2);
    if (!ok) continue;
    const l = pdfium.pdfium.HEAPF64[lp >> 3], r = pdfium.pdfium.HEAPF64[rp >> 3];
    const b = pdfium.pdfium.HEAPF64[bp >> 3], t = pdfium.pdfium.HEAPF64[tp2 >> 3];
    if (!line) { line = { l, r, t, b }; }
    else {
      const lineH = line.t - line.b;
      const overlap = Math.min(t, line.t) - Math.max(b, line.b);
      if (lineH > 0 && overlap / lineH > 0.4) {
        line.l = Math.min(line.l, l); line.r = Math.max(line.r, r);
        line.t = Math.max(line.t, t); line.b = Math.min(line.b, b);
      } else { lines.push(line); line = { l, r, t, b }; }
    }
  }
  if (line) lines.push(line);
  pdfium.pdfium._free(lp); pdfium.pdfium._free(rp);
  pdfium.pdfium._free(bp); pdfium.pdfium._free(tp2);
  pdfium.FPDFText_ClosePage(tp); pdfium.FPDF_ClosePage(p);
  return lines.map(ln => ({
    left: ln.l * sx, top: (pageH - ln.t) * sy,
    width: (ln.r - ln.l) * sx, height: (ln.t - ln.b) * sy,
  }));
}

// ─── Link hover tooltip ───

const tooltipEl = document.createElement("div");
tooltipEl.className = "link-tooltip";
tooltipEl.style.display = "none";
document.body.appendChild(tooltipEl);

function getLinkAtPoint(pdfium, docPtr, pageIndex, pdfX, pdfY) {
  const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!pagePtr) return null;
  try {
    const linkPtr = pdfium.FPDFLink_GetLinkAtPoint(pagePtr, pdfX, pdfY);
    if (!linkPtr) return null;

    // Check for URL action first
    const actionPtr = pdfium.FPDFLink_GetAction(linkPtr);
    if (actionPtr) {
      const actionType = pdfium.FPDFAction_GetType(actionPtr);
      // PDFACTION_URI = 3
      if (actionType === 3) {
        const bufLen = pdfium.FPDFAction_GetURIPath(docPtr, actionPtr, 0, 0);
        if (bufLen > 0) {
          const buf = pdfium.pdfium._malloc(bufLen);
          pdfium.FPDFAction_GetURIPath(docPtr, actionPtr, buf, bufLen);
          const uri = new TextDecoder().decode(new Uint8Array(pdfium.pdfium.HEAPU8.buffer, buf, bufLen - 1));
          pdfium.pdfium._free(buf);
          return { kind: "url", url: uri };
        }
      }
      // PDFACTION_GOTO = 1 (internal navigation)
      if (actionType === 1) {
        const destPtr = pdfium.FPDFAction_GetDest(docPtr, actionPtr);
        if (destPtr) {
          const destPage = pdfium.FPDFDest_GetDestPageIndex(docPtr, destPtr);
          if (destPage >= 0) {
            const text = extractTextAtDestination(pdfium, docPtr, destPtr, destPage);
            return { kind: "ref", page: destPage + 1, text };
          }
        }
      }
    }

    // Check direct destination
    const destPtr = pdfium.FPDFLink_GetDest(docPtr, linkPtr);
    if (destPtr) {
      const destPage = pdfium.FPDFDest_GetDestPageIndex(docPtr, destPtr);
      if (destPage >= 0) {
        const text = extractTextAtDestination(pdfium, docPtr, destPtr, destPage);
        return { kind: "ref", page: destPage + 1, text };
      }
    }

    return null;
  } finally {
    pdfium.FPDF_ClosePage(pagePtr);
  }
}

function extractTextAtDestination(pdfium, docPtr, destPtr, pageIndex) {
  const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
  if (!pagePtr) return "";
  try {
    const tp = pdfium.FPDFText_LoadPage(pagePtr);
    if (!tp) return "";
    try {
      const charCount = pdfium.FPDFText_CountChars(tp);
      if (charCount <= 0) return "";

      // Get the exact Y location the link points to
      const hasXPtr = pdfium.pdfium._malloc(4);
      const hasYPtr = pdfium.pdfium._malloc(4);
      const hasZoomPtr = pdfium.pdfium._malloc(4);
      const xPtr = pdfium.pdfium._malloc(4);
      const yPtr = pdfium.pdfium._malloc(4);
      const zoomPtr = pdfium.pdfium._malloc(4);

      let startCharIdx = 0;

      const ok = pdfium.FPDFDest_GetLocationInPage(destPtr, hasXPtr, hasYPtr, hasZoomPtr, xPtr, yPtr, zoomPtr);
      if (ok) {
        const hasY = pdfium.pdfium.HEAP32[hasYPtr >> 2];
        if (hasY) {
          const destY = pdfium.pdfium.HEAPF32[yPtr >> 2];
          // Find the character nearest to this Y position
          // PDF Y=0 is bottom, destY is from top in page coords
          const lp = pdfium.pdfium._malloc(8);
          const rp = pdfium.pdfium._malloc(8);
          const bp = pdfium.pdfium._malloc(8);
          const tp2 = pdfium.pdfium._malloc(8);

          let bestIdx = 0;
          let bestDist = Infinity;

          // Sample characters to find the one closest to destY
          const step = Math.max(1, Math.floor(charCount / 200));
          for (let i = 0; i < charCount; i += step) {
            const cok = pdfium.FPDFText_GetCharBox(tp, i, lp, rp, bp, tp2);
            if (!cok) continue;
            const charTop = pdfium.pdfium.HEAPF64[tp2 >> 3];
            const dist = Math.abs(charTop - destY);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
          }
          // Refine around best
          const lo = Math.max(0, bestIdx - step);
          const hi = Math.min(charCount - 1, bestIdx + step);
          for (let i = lo; i <= hi; i++) {
            const cok = pdfium.FPDFText_GetCharBox(tp, i, lp, rp, bp, tp2);
            if (!cok) continue;
            const charTop = pdfium.pdfium.HEAPF64[tp2 >> 3];
            const dist = Math.abs(charTop - destY);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
          }

          startCharIdx = bestIdx;
          pdfium.pdfium._free(lp);
          pdfium.pdfium._free(rp);
          pdfium.pdfium._free(bp);
          pdfium.pdfium._free(tp2);
        }
      }

      pdfium.pdfium._free(hasXPtr);
      pdfium.pdfium._free(hasYPtr);
      pdfium.pdfium._free(hasZoomPtr);
      pdfium.pdfium._free(xPtr);
      pdfium.pdfium._free(yPtr);
      pdfium.pdfium._free(zoomPtr);

      const extract = Math.min(charCount - startCharIdx, 300);
      if (extract <= 0) return "";
      const bufPtr = pdfium.pdfium._malloc((extract + 1) * 2);
      try {
        pdfium.FPDFText_GetText(tp, startCharIdx, extract, bufPtr);
        return String.fromCharCode(...new Uint16Array(pdfium.pdfium.HEAPU8.buffer, bufPtr, extract))
          .replace(/\s+/g, " ").trim();
      } finally { pdfium.pdfium._free(bufPtr); }
    } finally { pdfium.FPDFText_ClosePage(tp); }
  } finally { pdfium.FPDF_ClosePage(pagePtr); }
}

let tooltipTimeout = null;
let lastTooltipKey = "";

function showLinkTooltip(info, mouseX, mouseY) {
  let content;
  if (info.kind === "url") {
    content = info.url;
  } else {
    content = info.text ? clampText(info.text, 300) : `Page ${info.page}`;
  }

  const key = content;
  if (key === lastTooltipKey && tooltipEl.style.display === "block") return;
  lastTooltipKey = key;

  tooltipEl.textContent = content;
  tooltipEl.style.display = "block";
  tooltipEl.style.left = `${mouseX + 12}px`;
  tooltipEl.style.top = `${mouseY + 12}px`;

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = tooltipEl.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) {
      tooltipEl.style.left = `${mouseX - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      tooltipEl.style.top = `${mouseY - rect.height - 8}px`;
    }
  });
}

function hideTooltip() {
  tooltipEl.style.display = "none";
  lastTooltipKey = "";
}

// ─── Selection highlight ───

function renderSelectionHighlight(pageNumber) {
  const refs = state.pageRefs.get(pageNumber);
  if (!refs) return;
  refs.highlightLayer.innerHTML = "";
  if (!state.dragState || state.dragState.pageNumber !== pageNumber) return;
  if (state.dragState.startIdx < 0 || state.dragState.endIdx < 0) return;
  const rects = getCharRects(state.pdfium, state.docPtr, pageNumber - 1,
    state.dragState.startIdx, state.dragState.endIdx,
    refs.stage.offsetWidth, refs.stage.offsetHeight);
  for (const r of rects) {
    const div = document.createElement("div");
    div.className = "sel-rect";
    div.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    refs.highlightLayer.appendChild(div);
  }
}

function clearSelectionHighlight() {
  for (const refs of state.pageRefs.values()) refs.highlightLayer.innerHTML = "";
}

function renderPageSavedHighlights(pageNumber) {
  const refs = state.pageRefs.get(pageNumber);
  if (!refs || !state.pdfium || !state.docPtr) return;

  // Remove old saved highlights (keep sel-rect for active selection)
  refs.highlightLayer.querySelectorAll(".saved-highlight").forEach(el => el.remove());

  const items = state.comments.filter(c =>
    c.pageNumber === pageNumber && c.startIdx != null && c.endIdx != null
  );

  for (const item of items) {
    const rects = getCharRects(state.pdfium, state.docPtr, pageNumber - 1,
      item.startIdx, item.endIdx, refs.stage.offsetWidth, refs.stage.offsetHeight);
    const isHighlightOnly = item.kind === "highlight";
    const isFocused = state.focusedCommentId === item.id;
    for (const r of rects) {
      const div = document.createElement("div");
      div.className = "saved-highlight";
      div.dataset.commentId = item.id;
      const color = isHighlightOnly
        ? (isFocused ? "rgba(250, 204, 21, 0.28)" : "rgba(250, 204, 21, 0.16)")
        : item.kind === "question"
          ? (isFocused ? "rgba(34, 197, 94, 0.25)" : "rgba(34, 197, 94, 0.12)")
          : (isFocused ? "rgba(245, 158, 11, 0.25)" : "rgba(245, 158, 11, 0.12)");
      div.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:${color};border-radius:2px;pointer-events:none;`;
      refs.highlightLayer.appendChild(div);
    }
  }
}

function renderAllSavedHighlights() {
  for (const pn of state.pageRefs.keys()) renderPageSavedHighlights(pn);
}

function syncSelectionState() {
  if (isInlineOpen()) return;
  if (state.dragState && state.dragState.startIdx >= 0 && state.dragState.endIdx >= 0 &&
      state.dragState.startIdx !== state.dragState.endIdx) {
    const quote = getTextBetween(state.pdfium, state.docPtr, state.dragState.pageNumber - 1,
      state.dragState.startIdx, state.dragState.endIdx).replace(/\s+/g, " ").trim();
    if (quote && quote.length > 1) {
      state.pendingSelection = {
        kind: "ready", pageNumber: state.dragState.pageNumber, quote,
        startIdx: state.dragState.startIdx, endIdx: state.dragState.endIdx,
      };
      commentSelectionButton.disabled = false;

      // Auto-save as highlight
      const highlight = {
        id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: "highlight",
        pageNumber: state.dragState.pageNumber,
        quote,
        comment: "",
        rects: [],
        startIdx: Math.min(state.dragState.startIdx, state.dragState.endIdx),
        endIdx: Math.max(state.dragState.startIdx, state.dragState.endIdx),
        createdAt: Date.now(),
        sent: false,
      };
      state.comments.push(highlight);
      state.focusedCommentId = highlight.id;
      renderCommentList();
      renderAllMarkers();
      renderAllSavedHighlights();
      autoSave();
      setStatus(`Highlighted · page ${state.dragState.pageNumber}`);
      return;
    }
  }
  state.pendingSelection = null;
  commentSelectionButton.disabled = true;
  if (state.docPtr) setStatus("Ready");
}

// ─── Comment management ───

function focusComment(commentId) {
  state.focusedCommentId = commentId;
  renderCommentList();
  renderAllMarkers();
  renderAllSavedHighlights();
}

function focusNextComment(direction) {
  if (state.comments.length === 0) return;
  const idx = state.comments.findIndex(c => c.id === state.focusedCommentId);
  let next;
  if (idx < 0) next = 0;
  else next = (idx + direction + state.comments.length) % state.comments.length;
  scrollToComment(state.comments[next]);
}

function scrollToComment(comment) {
  const refs = state.pageRefs.get(comment.pageNumber);
  if (refs) refs.shell.scrollIntoView({ behavior: "smooth", block: "center" });
  focusComment(comment.id);
}

function deleteFocusedComment() {
  if (!state.focusedCommentId) return;
  if (editingCommentId === state.focusedCommentId) closeInlineComment();
  const idx = state.comments.findIndex(c => c.id === state.focusedCommentId);
  state.comments = state.comments.filter(c => c.id !== state.focusedCommentId);
  state.focusedCommentId = state.comments[Math.min(idx, state.comments.length - 1)]?.id ?? null;
  renderCommentList();
  renderAllMarkers();
  renderAllSavedHighlights();
  autoSave();
  setStatus("Deleted");
}

function renderPageMarkers(pageNumber) {
  const refs = state.pageRefs.get(pageNumber);
  if (!refs) return;
  refs.gutter.innerHTML = "";
  refs.gutter.style.top = `${refs.stage.offsetTop}px`;
  refs.gutter.style.height = `${refs.stage.offsetHeight}px`;
  const comments = state.comments.map((c, i) => ({ c, i })).filter(({ c }) => c.pageNumber === pageNumber);
  for (const { c, i } of comments) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `annotation-marker${state.focusedCommentId === c.id ? " active" : ""}${c.sent ? " sent" : ""}`;
    marker.style.top = "4px";
    marker.style.height = "16px";
    marker.title = `Note ${i + 1}`;
    const badge = document.createElement("span");
    badge.className = "annotation-badge";
    badge.textContent = String(i + 1);
    marker.appendChild(badge);
    marker.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); scrollToComment(c); });
    refs.gutter.appendChild(marker);
  }
}

function renderAllMarkers() {
  for (const pn of state.pageRefs.keys()) renderPageMarkers(pn);
}

function renderCommentList() {
  setCommentCount();
  if (state.comments.length === 0) {
    commentListEl.innerHTML = '<div class="comment-list-empty">No notes yet.<br>Select text, then press <strong>C</strong>.</div>';
    return;
  }
  commentListEl.innerHTML = "";
  for (const comment of state.comments) {
    const card = document.createElement("div");
    card.className = `comment-card${state.focusedCommentId === comment.id ? " active" : ""}${comment.sent ? " sent" : ""}`;
    const kindLabel = comment.kind === "note" ? "note" : "question";
    card.innerHTML = `
      <div class="comment-page">Page ${comment.pageNumber}<span class="comment-kind ${kindLabel}">${kindLabel}</span>${comment.sent ? " · sent" : ""}</div>
      <div class="comment-quote">"${escapeHtml(clampText(comment.quote, 200))}"</div>
      <div class="comment-body">${escapeHtml(comment.comment)}</div>
      <div class="comment-card-actions">
        <button data-action="edit">Edit</button>
        <button data-action="delete" class="danger">Delete</button>
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      scrollToComment(comment);
    });
    card.querySelector('[data-action="edit"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      focusComment(comment.id);
      openEditComment(comment);
    });
    card.querySelector('[data-action="delete"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      state.focusedCommentId = comment.id;
      deleteFocusedComment();
    });
    commentListEl.appendChild(card);
  }
}

// ─── Inline comment ───

// editingCommentId: when set, we're editing an existing comment instead of creating new
let editingCommentId = null;
const inlineModeEl = document.getElementById("inline-mode");

function updateInlineMode() {
  const isNote = state.inlineKind === "note";
  inlineModeEl.textContent = isNote ? "Note" : "Question";
  inlineModeEl.className = `inline-comment-mode${isNote ? " note" : ""}`;
  inlineInputEl.placeholder = isNote ? "Your understanding…" : "Ask Pi about this…";
}

function toggleInlineKind() {
  state.inlineKind = state.inlineKind === "question" ? "note" : "question";
  updateInlineMode();
}

function positionInlineOnPage(pageNumber, fallbackTop, fallbackLeft) {
  const refs = state.pageRefs.get(pageNumber);
  if (!refs) return;
  refs.stage.appendChild(inlineCommentEl);
  let top = fallbackTop ?? refs.stage.offsetHeight / 3;
  let left = fallbackLeft ?? 40;
  left = Math.max(4, Math.min(left, refs.stage.offsetWidth - 348));
  top = Math.min(top, refs.stage.offsetHeight - 80);
  inlineCommentEl.style.top = `${top}px`;
  inlineCommentEl.style.left = `${left}px`;
}

function openInlineComment(kind) {
  if (!state.pendingSelection || !state.dragState) return;
  editingCommentId = null;
  state.inlineKind = kind || "question";
  updateInlineMode();
  const refs = state.pageRefs.get(state.dragState.pageNumber);
  if (!refs) return;
  const rects = getCharRects(state.pdfium, state.docPtr, state.dragState.pageNumber - 1,
    state.dragState.startIdx, state.dragState.endIdx,
    refs.stage.offsetWidth, refs.stage.offsetHeight);
  const lastRect = rects[rects.length - 1];
  const top = lastRect ? lastRect.top + lastRect.height + 4 : undefined;
  const left = lastRect ? lastRect.left : undefined;
  positionInlineOnPage(state.dragState.pageNumber, top, left);
  inlineQuoteEl.textContent = `"${clampText(state.pendingSelection.quote, 120)}" — page ${state.pendingSelection.pageNumber}`;
  inlineInputEl.value = "";
  inlineCommentEl.classList.add("open");
  inlineInputEl.focus();
}

function openEditComment(comment) {
  editingCommentId = comment.id;
  state.inlineKind = comment.kind || "question";
  updateInlineMode();
  positionInlineOnPage(comment.pageNumber);
  inlineQuoteEl.textContent = `"${clampText(comment.quote, 120)}" — page ${comment.pageNumber}`;
  inlineInputEl.value = comment.comment;
  inlineCommentEl.classList.add("open");
  inlineInputEl.focus();
  inlineInputEl.select();
}

function closeInlineComment() {
  inlineCommentEl.classList.remove("open");
  inlineInputEl.value = "";
  editingCommentId = null;
}

function saveInlineComment() {
  const body = inlineInputEl.value.trim();
  if (!body) { inlineInputEl.focus(); return; }

  if (editingCommentId) {
    const comment = state.comments.find(c => c.id === editingCommentId);
    if (comment) {
      comment.comment = body;
      comment.kind = state.inlineKind;
      if (comment.kind === "question") comment.sent = false;
      state.focusedCommentId = comment.id;
      renderCommentList(); renderAllMarkers(); renderAllSavedHighlights();
      autoSave();
      setStatus(`Edited ${state.inlineKind} · page ${comment.pageNumber}`);
    }
    closeInlineComment();
    return;
  }

  if (!state.pendingSelection) return;

  // If the focused item is a highlight we just made, upgrade it
  const existingHighlight = state.comments.find(c =>
    c.id === state.focusedCommentId && c.kind === "highlight" &&
    c.pageNumber === state.pendingSelection.pageNumber &&
    c.quote === state.pendingSelection.quote
  );

  if (existingHighlight) {
    existingHighlight.kind = state.inlineKind;
    existingHighlight.comment = body;
    if (state.inlineKind === "question") existingHighlight.sent = false;
    renderCommentList(); renderAllMarkers(); renderAllSavedHighlights();
    autoSave();
    closeInlineComment();
    setStatus(`Saved ${state.inlineKind} · page ${existingHighlight.pageNumber}`);
    return;
  }

  const comment = {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: state.inlineKind,
    pageNumber: state.pendingSelection.pageNumber,
    quote: state.pendingSelection.quote,
    comment: body, rects: [],
    startIdx: state.pendingSelection.startIdx,
    endIdx: state.pendingSelection.endIdx,
    createdAt: Date.now(), sent: false,
  };
  state.comments.push(comment);
  state.focusedCommentId = comment.id;
  renderCommentList(); renderAllMarkers(); renderAllSavedHighlights();
  autoSave();
  closeInlineComment();
  state.dragState = null; clearSelectionHighlight();
  state.pendingSelection = null;
  commentSelectionButton.disabled = true;
  setStatus(`Saved ${state.inlineKind} · page ${comment.pageNumber}`);
}

function editFocusedComment() {
  const comment = state.comments.find(c => c.id === state.focusedCommentId);
  if (!comment) return;
  openEditComment(comment);
}

// ─── Ask Pi ───

function askPi() {
  const unsent = state.comments.filter(c => c.kind === "question" && !c.sent);
  if (unsent.length === 0) {
    setStatus("No new questions to send");
    return;
  }
  const totalSent = state.comments.filter(c => c.kind === "question" && c.sent).length;

  sendToExtension({
    type: "ask",
    comments: unsent,
    totalSent,
  });

  // Mark as sent
  for (const c of unsent) c.sent = true;
  renderCommentList();
  renderAllMarkers();
  autoSave();
  showToast(`Sent ${unsent.length} question${unsent.length > 1 ? "s" : ""} to Pi`);
  setStatus("Ready");
}

function closeReview() {
  closeWindow({ type: "cancel" });
}

// ─── Help overlay ───

function toggleHelp() {
  helpOverlay.classList.toggle("open");
}

// ─── Page rendering ───

function createPageShell(pageNumber) {
  const shell = document.createElement("div");
  shell.className = "page-shell";
  shell.dataset.pageNumber = String(pageNumber);
  const label = document.createElement("div");
  label.className = "page-label";
  label.textContent = `Page ${pageNumber}`;
  const gutter = document.createElement("div");
  gutter.className = "annotation-gutter";
  const stage = document.createElement("div");
  stage.className = "page-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "page-canvas";
  const highlightLayer = document.createElement("div");
  highlightLayer.className = "highlight-layer";
  const interactionLayer = document.createElement("div");
  interactionLayer.className = "interaction-layer";

  interactionLayer.addEventListener("mousedown", (e) => {
    if (!state.pdfium || !state.docPtr) return;
    if (isInlineOpen()) { closeInlineComment(); return; }
    const rect = stage.getBoundingClientRect();
    const dims = getPageDimsPts(state.pdfium, state.docPtr, pageNumber - 1);
    const { pdfX, pdfY } = cssToPageCoords(e.clientX - rect.left, e.clientY - rect.top, stage.offsetWidth, stage.offsetHeight, dims.w, dims.h);
    const idx = getTextAtPoint(state.pdfium, state.docPtr, pageNumber - 1, pdfX, pdfY);
    state.dragState = { pageNumber, startIdx: idx, endIdx: idx, pageDims: dims };
    clearSelectionHighlight(); renderSelectionHighlight(pageNumber);
    state.pendingSelection = null; commentSelectionButton.disabled = true;
    setStatus("Selecting…");
  });

  interactionLayer.addEventListener("mousemove", (e) => {
    // Drag selection
    if (state.dragState && state.dragState.pageNumber === pageNumber && (e.buttons & 1)) {
      const rect = stage.getBoundingClientRect();
      const dims = state.dragState.pageDims;
      const { pdfX, pdfY } = cssToPageCoords(e.clientX - rect.left, e.clientY - rect.top, stage.offsetWidth, stage.offsetHeight, dims.w, dims.h);
      const idx = getTextAtPoint(state.pdfium, state.docPtr, pageNumber - 1, pdfX, pdfY);
      if (idx >= 0) { state.dragState.endIdx = idx; renderSelectionHighlight(pageNumber); }
      hideTooltip();
      return;
    }

    // Link hover tooltip (not dragging)
    if (!state.pdfium || !state.docPtr || isInlineOpen()) return;
    const rect = stage.getBoundingClientRect();
    const dims = getPageDimsPts(state.pdfium, state.docPtr, pageNumber - 1);
    const { pdfX, pdfY } = cssToPageCoords(e.clientX - rect.left, e.clientY - rect.top, stage.offsetWidth, stage.offsetHeight, dims.w, dims.h);

    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      const info = getLinkAtPoint(state.pdfium, state.docPtr, pageNumber - 1, pdfX, pdfY);
      if (info) {
        showLinkTooltip(info, e.clientX, e.clientY);
        interactionLayer.style.cursor = "pointer";
      } else {
        hideTooltip();
        interactionLayer.style.cursor = "text";
      }
    }, 80);
  });

  interactionLayer.addEventListener("mouseleave", () => {
    clearTimeout(tooltipTimeout);
    hideTooltip();
    interactionLayer.style.cursor = "text";
  });

  interactionLayer.addEventListener("mouseup", () => {
    if (!state.dragState || state.dragState.pageNumber !== pageNumber) return;
    syncSelectionState();
  });

  stage.append(canvas, highlightLayer, interactionLayer);
  shell.append(label, gutter, stage);
  return { shell, stage, gutter, canvas, highlightLayer, interactionLayer };
}

async function renderDocument() {
  if (!state.pdfium || !state.docPtr) return;
  const version = ++state.renderVersion;
  setStatus("Rendering…");
  viewerEl.innerHTML = "";
  state.pageRefs = new Map();
  for (let p = 1; p <= state.pageCount; p++) {
    const refs = createPageShell(p);
    state.pageRefs.set(p, refs);
    viewerEl.appendChild(refs.shell);
  }
  for (let p = 1; p <= state.pageCount; p++) {
    if (version !== state.renderVersion) return;
    setStatus(`Rendering page ${p}/${state.pageCount}…`);
    const dims = renderPageToCanvas(state.pdfium, state.docPtr, p - 1, state.pageRefs.get(p).canvas, state.scale);
    if (dims) {
      const refs = state.pageRefs.get(p);
      refs.stage.style.width = `${dims.cssWidth}px`;
      refs.stage.style.height = `${dims.cssHeight}px`;
    }
    await new Promise(r => setTimeout(r, 0));
  }
  if (version !== state.renderVersion) return;
  setStatus("Ready");
  renderCommentList(); renderAllMarkers(); renderAllSavedHighlights();
}

// ─── Boot ───

async function bootPdfReview() {
  try {
    docTitleEl.textContent = boot.source.title;
    docSubtitleEl.textContent = boot.source.displayName;
    // Load saved comments
    try {
      const saved = await (await fetch("/saved-comments")).json();
      if (Array.isArray(saved) && saved.length > 0) {
        state.comments = saved;
        showToast(`Restored ${saved.length} saved annotation${saved.length > 1 ? "s" : ""}`);
      }
    } catch {}
    setCommentCount(); renderCommentList();
    setStatus("Loading PDFium…");
    const wasmBinary = await (await fetch("/pdfium.wasm")).arrayBuffer();
    const pdfium = await init({ wasmBinary });
    pdfium.PDFiumExt_Init();
    state.pdfium = pdfium;
    setStatus("Loading PDF…");
    const pdfData = decodeBase64ToArrayBuffer(boot.source.bytesBase64);
    const pdfBytes = new Uint8Array(pdfData);
    const bufPtr = pdfium.pdfium._malloc(pdfBytes.length);
    pdfium.pdfium.HEAPU8.set(pdfBytes, bufPtr);
    const docPtr = pdfium.FPDF_LoadMemDocument(bufPtr, pdfBytes.length, null);
    if (!docPtr) throw new Error(`PDFium load failed (error ${pdfium.FPDF_GetLastError()})`);
    state.docPtr = docPtr;
    state.pageCount = pdfium.FPDF_GetPageCount(docPtr);
    docSubtitleEl.textContent = `${boot.source.displayName} · ${state.pageCount} pages · ${formatBytes(boot.source.byteLength)}`;
    await renderDocument();
  } catch (error) {
    console.error(error);
    setStatus("Failed");
    viewerEl.innerHTML = `<div style="padding:20px;color:#f2b8b8">${escapeHtml(error?.message || String(error))}</div>`;
  }
}

// ─── Event listeners ───

commentSelectionButton.addEventListener("click", () => { if (state.pendingSelection) openInlineComment(); });
toggleCommentsButton.addEventListener("click", () => setCommentsDrawerOpen(!state.commentsDrawerOpen));
closeDrawerButton.addEventListener("click", () => setCommentsDrawerOpen(false));
askPiButton.addEventListener("click", askPi);
cancelButton.addEventListener("click", closeReview);
document.getElementById("help-btn").addEventListener("click", toggleHelp);
helpOverlay.addEventListener("click", (e) => { if (e.target === helpOverlay) toggleHelp(); });

inlineInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveInlineComment(); }
  if (e.key === "Escape") { e.preventDefault(); closeInlineComment(); }
  if (e.key === "Tab") { e.preventDefault(); toggleInlineKind(); }
});

// Click mode label to toggle
inlineModeEl.addEventListener("click", toggleInlineKind);

document.addEventListener("keydown", (event) => {
  if (isInlineOpen()) return;
  if (isHelpOpen()) { if (event.key === "Escape" || event.key === "?") { event.preventDefault(); toggleHelp(); } return; }
  const isInput = event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); askPi(); return; }

  // Ctrl+D / Ctrl+U: page down / page up
  if ((event.ctrlKey || event.metaKey) && (event.key === "d" || event.key === "D")) {
    event.preventDefault();
    viewerEl.scrollBy({ top: viewerEl.offsetHeight * 0.85, behavior: "smooth" });
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "u" || event.key === "U")) {
    event.preventDefault();
    viewerEl.scrollBy({ top: -viewerEl.offsetHeight * 0.85, behavior: "smooth" });
    return;
  }

  if (event.key === "Escape") {
    if (state.commentsDrawerOpen) { event.preventDefault(); setCommentsDrawerOpen(false); }
    return;
  }
  if (isInput) return;

  switch (event.key) {
    case "a": case "A":
      if (state.pendingSelection) { event.preventDefault(); openInlineComment(); }
      break;
    case "Enter":
      event.preventDefault(); askPi(); break;
    case "b": case "B":
      event.preventDefault(); setCommentsDrawerOpen(!state.commentsDrawerOpen); break;
    case "e": case "E":
      event.preventDefault(); editFocusedComment(); break;
    case "d": case "D":
      event.preventDefault(); deleteFocusedComment(); break;
    case "n":
      event.preventDefault(); focusNextComment(1); break;
    case "p":
      event.preventDefault(); focusNextComment(-1); break;
    case "j":
      event.preventDefault(); viewerEl.scrollBy({ top: 80, behavior: "smooth" }); break;
    case "k":
      event.preventDefault(); viewerEl.scrollBy({ top: -80, behavior: "smooth" }); break;
    case "?":
      event.preventDefault(); toggleHelp(); break;
  }
});

document.addEventListener("mouseup", () => { if (state.dragState) syncSelectionState(); });

// Ctrl+wheel zooms PDF content only
let zoomDebounce = null;
viewerEl.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  state.scale = Math.max(0.5, Math.min(4, Number((state.scale + delta).toFixed(2))));
  setStatus(`Zoom ${Math.round(state.scale * 100)}%`);
  clearTimeout(zoomDebounce);
  zoomDebounce = setTimeout(() => renderDocument(), 150);
}, { passive: false });

setCommentsDrawerOpen(false);
bootPdfReview();
