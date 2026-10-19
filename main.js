"use strict";
/*
 * Ink Canvas v1.3.0 – Handschrift-Notizen mit S Pen für Obsidian
 * Neu in v1.3.0:
 * - Freie Farbauswahl (Custom Color Picker) für Stift & Textmarker inkl. Speicherung
 * - PDF-Dateien wahlweise als "Ausdruck" (Seiten) ODER als kompakte "Anhang-Karte" (Link) einfügen
 * - Tiefgreifender S-Pen-Barrel-Button-Fix für Android/Samsung One UI:
 *   Fängt PointerEvents, native Android TouchEvents (toolType === "eraser"),
 *   S-Pen Contextmenu-Signale und Bluetooth/Key-Events ab.
 */
const obsidian = require("obsidian");
const {
  Plugin, TextFileView, FuzzySuggestModal, Notice, PluginSettingTab,
  Setting, setIcon, TFile, Platform, Menu, loadPdfJs,
} = obsidian;

const VIEW_TYPE = "ink-canvas-view";
const EXT = "ink";
const PAGE_W = 800;
const PAGE_GAP = 24;
const CARD_W = 320;
const CARD_H = 76;
const HL_MULT = 4;
const ERASER_R = 16;
const HANDLE_R = 24;
const MAX_CACHED_PAGES = 12;
const DEFAULT_PEN_COLORS = ["#111111", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#7048e8"];
const DEFAULT_HL_COLORS = ["#ffe14d", "#ff8fb1", "#7de08a", "#6cc8ff"];
const BGS = ["grid", "lines", "dots", "none"];
const BG_LABELS = { grid: "Karo", lines: "Linien", dots: "Punkte", none: "Blanko" };

const DEFAULT_SETTINGS = {
  fingerDraws: false,
  penButton: "eraser",      // "eraser" | "pan" | "off"
  penEraserEnd: true,
  penButtonDebug: false,
  smoothing: 0.35,
  shapeRecognition: true,
  shapeHoldMs: 550,
  twoFingerUndo: true,
  pdfQuality: Platform.isMobile ? 1.5 : 2,
  background: "grid",
  penWidth: 2.5,
  customPenColors: [],
  customHlColors: [],
};

/* ---------- Hilfsfunktionen ---------- */
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const newDoc = (bg) => ({
  v: 1,
  bg: bg || "grid",
  view: { x: 40, y: 40, z: 1 },
  strokes: [],
  pdfs: [],
  links: [], // Neu in v1.3: Verknüpfte PDF-Anhänge als Karten
});
const widthMult = (s) => (s.tool === "highlighter" ? HL_MULT : 1);

function strokeBounds(s) {
  if (s._b) return s._b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.points) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const pad = s.width * widthMult(s) * 1.1 + 1;
  s._b = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  return s._b;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokeHit(s, x, y, r) {
  const pts = s.points;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= r;
  for (let i = 1; i < pts.length; i++) {
    if (distSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
  }
  return false;
}

function strokeHitSegment(s, x0, y0, x1, y1, r) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(2, r * 0.6)));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (strokeHit(s, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) return true;
  }
  return false;
}

function shiftStrokes(list, dx, dy) {
  for (const s of list) {
    for (const p of s.points) { p[0] += dx; p[1] += dy; }
    s._b = null;
  }
}

function scaleStrokes(list, ox, oy, k) {
  for (const s of list) {
    for (const p of s.points) {
      p[0] = ox + (p[0] - ox) * k;
      p[1] = oy + (p[1] - oy) * k;
    }
    s.width *= k;
    s._b = null;
  }
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/* ----- Formerkennung ----- */
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let idx = 0, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distSeg(pts[i][0], pts[i][1], a[0], a[1], b[0], b[1]);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const l = rdp(pts.slice(0, idx + 1), eps);
    const r = rdp(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [a, b];
}

function recognizeShape(pts) {
  const n = pts.length;
  if (n < 6) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, L = 0, pp = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
    pp += p[2];
    if (i) L += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < 10 || L <= 0) return null;
  const P = pp / n;
  const A = pts[0], B = pts[n - 1];
  const chord = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const out = (arr, kind) => ({ kind, pts: arr.map((q) => [q[0], q[1], P]) });

  if (chord > diag * 0.6) {
    let dev = 0;
    for (const p of pts) dev = Math.max(dev, distSeg(p[0], p[1], A[0], A[1], B[0], B[1]));
    if (dev / chord < 0.085) return out([A, B], "line");
    return null;
  }

  const closed = chord < 0.32 * L && L > diag * 1.45;
  if (!closed) return null;

  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  if (rx < 3 || ry < 3) return null;
  const rs = pts.map((p) => Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry));
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  if (Math.abs(mean - 1) < 0.11 && std < 0.11) {
    const circle = Math.abs(rx - ry) / Math.max(rx, ry) < 0.16;
    const R = (rx + ry) / 2;
    const arr = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      arr.push([cx + (circle ? R : rx) * Math.cos(t), cy + (circle ? R : ry) * Math.sin(t)]);
    }
    return out(arr, "ellipse");
  }

  let v = rdp(pts, 0.07 * diag);
  if (v.length > 2 && Math.hypot(v[v.length - 1][0] - v[0][0], v[v.length - 1][1] - v[0][1]) < 0.22 * diag) {
    v = v.slice(0, -1);
  }
  if (v.length === 3) return out([v[0], v[1], v[2], v[0]], "triangle");
  if (v.length === 4) {
    let ok = true;
    for (let i = 0; i < 4; i++) {
      const a = v[i], b = v[(i + 1) % 4];
      const ang = Math.abs((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI);
      const m = ang % 90;
      if (Math.min(m, 90 - m) > 15) ok = false;
    }
    if (ok) {
      const X0 = Math.min(...v.map((q) => q[0])), X1 = Math.max(...v.map((q) => q[0]));
      const Y0 = Math.min(...v.map((q) => q[1])), Y1 = Math.max(...v.map((q) => q[1]));
      return out([[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]], "rect");
    }
    return out([v[0], v[1], v[2], v[3], v[0]], "quad");
  }
  if (v.length >= 5 && v.length <= 8) return out([...v, v[0]], "polygon");
  return null;
}

/* ----- Strichdarstellung ----- */
function drawStroke(ctx, s, predictedPts) {
  const basePts = s.points;
  const pts = predictedPts && predictedPts.length ? basePts.concat(predictedPts) : basePts;
  const n = pts.length;
  if (!n) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  const isHl = s.tool === "highlighter";

  if (n === 1) {
    const w = s.width * widthMult(s) * (isHl ? 1 : 0.4 + 1.2 * pts[0][2]);
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (s.sharp) {
    ctx.lineWidth = isHl ? s.width * HL_MULT : s.width * (0.4 + 1.2 * pts[0][2]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    return;
  }

  if (s._u === undefined && !predictedPts) {
    s._u = basePts.every((p) => Math.abs(p[2] - basePts[0][2]) < 0.03);
  }

  if (isHl || s._u) {
    ctx.lineWidth = isHl ? s.width * HL_MULT : s.width * (0.4 + 1.2 * pts[0][2]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
    ctx.stroke();
    return;
  }

  let sx = pts[0][0], sy = pts[0][1];
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    ctx.lineWidth = s.width * (0.38 + 1.22 * ((a[2] + b[2]) / 2));
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(a[0], a[1], mx, my);
    ctx.stroke();
    sx = mx; sy = my;
  }
  ctx.lineWidth = s.width * (0.38 + 1.22 * pts[n - 1][2]);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  ctx.stroke();
}

function paintStroke(ctx, s, predictedPts) {
  if (s.tool === "highlighter") {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.45;
    drawStroke(ctx, s, predictedPts);
    ctx.restore();
  } else {
    drawStroke(ctx, s, predictedPts);
  }
}

/* ----- PDF-Anhang-Karte zeichnen (Neu in v1.3) ----- */
function drawPdfLinkCard(ctx, lnk, z) {
  const x = lnk.x, y = lnk.y, w = lnk.w || CARD_W;
  const s = w / CARD_W;
  const h = CARD_H * s;

  ctx.save();
  // Kartenschatten & Hintergrund
  ctx.shadowColor = "rgba(15, 23, 42, 0.10)";
  ctx.shadowBlur = 10 * s;
  ctx.shadowOffsetY = 3 * s;
  roundRectPath(ctx, x, y, w, h, 12 * s);
  ctx.fillStyle = "#f8fafc";
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.lineWidth = Math.max(1 / z, 1.5 * s);
  ctx.strokeStyle = "#cbd5e1";
  ctx.stroke();

  // Rotes PDF-Badge links
  const bx = x + 12 * s, by = y + 12 * s, bw = 52 * s, bh = 52 * s;
  roundRectPath(ctx, bx, by, bw, bh, 10 * s);
  ctx.fillStyle = "#e03131";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(15 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("PDF", bx + bw / 2, by + bh / 2);

  // Dateiname & Untertitel
  const name = (lnk.path.split("/").pop() || lnk.path);
  const tx = bx + bw + 12 * s;
  const maxTextW = w - (tx - x) - 74 * s;

  ctx.textAlign = "left";
  ctx.fillStyle = "#0f172a";
  ctx.font = `600 ${Math.round(14 * s)}px sans-serif`;
  let dispName = name;
  while (dispName.length > 4 && ctx.measureText(dispName).width > maxTextW) {
    dispName = dispName.slice(0, -5) + "….pdf";
  }
  ctx.fillText(dispName, tx, y + 29 * s);

  ctx.fillStyle = "#64748b";
  ctx.font = `${Math.round(11 * s)}px sans-serif`;
  ctx.fillText("Verknüpfter Anhang", tx, y + 49 * s);

  // "Öffnen"-Button rechts auf der Karte
  const btnW = 58 * s, btnH = 30 * s;
  const btnX = x + w - btnW - 12 * s, btnY = y + (h - btnH) / 2;
  roundRectPath(ctx, btnX, btnY, btnW, btnH, 7 * s);
  ctx.fillStyle = "#e2e8f0";
  ctx.fill();
  ctx.fillStyle = "#1e293b";
  ctx.font = `600 ${Math.round(11.5 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("Öffnen ↗", btnX + btnW / 2, btnY + btnH / 2);

  ctx.restore();
}

/* ---------- PDF-Auswahl ---------- */
class PdfSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("PDF aus dem Vault auswählen …");
  }
  getItems() {
    return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf");
  }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onChoose(f); }
}

/* ---------- Die Ansicht ---------- */
class InkView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.doc = newDoc(plugin.settings.background);
    this.tool = "pen";
    this.penColor = DEFAULT_PEN_COLORS[0];
    this.hlColor = DEFAULT_HL_COLORS[0];
    this.width = plugin.settings.penWidth;
    this.undoStack = [];
    this.redoStack = [];
    this.docs = new Map();
    this.pageCache = new Map();
    this.pending = new Set();
    this.loadToken = 0;

    // Eingabe- & Gesten-Status
    this.touches = new Map();
    this.multiTap = null;
    this.gest = null;
    this.active = null;
    this.cur = null;
    this.predicted = [];
    this.sel = null;              // { entry: PDF|null, link: LinkCard|null, strokes: [...] }
    this.lasso = null;
    this.scaling = false;
    this.snapped = null;
    this.sm = null;
    this.rawLast = null;
    this.holdTimer = null;
    this.holdAnchor = null;
    this.eraserPos = null;

    // S-Pen Multi-Layer Seitentasten-Tracking (Pointer + Android Touch + Contextmenu + Key)
    this.lastPen = 0;
    this.lastBarrelTime = 0;
    this.androidTouchEraser = false;
    this.keyBarrelHeld = false;
    this.hoverZeroFrames = 0;
    this.lastTapTime = 0;
    this.lastTapPos = null;

    // Rendering & Offscreen-Cache
    this.cssW = 0; this.cssH = 0; this.dpr = 1;
    this.drawQueued = false;
    this.staticDirty = true;
    this.canvas = null;
    this.staticCanvas = document.createElement("canvas");
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.basename : "Handschrift"; }
  getIcon() { return "pencil"; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("ink-view-content");
    this.buildUI();
    this.invalidateStatic();
  }

  async onClose() {
    clearTimeout(this.holdTimer);
    if (this.ro) this.ro.disconnect();
    if (this._keyDownHandler) window.removeEventListener("keydown", this._keyDownHandler, true);
    if (this._keyUpHandler) window.removeEventListener("keyup", this._keyUpHandler, true);
    this.destroyPdfs();
  }

  /* ----- Datei laden/speichern ----- */
  getViewData() { return this.serialize(); }
  setViewData(data) { this.loadData(data); }
  clear() {
    this.destroyPdfs();
    this.doc = newDoc(this.plugin.settings.background);
    this.undoStack = []; this.redoStack = [];
    this.sel = null;
    this.invalidateStatic();
  }

  serialize() {
    const d = this.doc;
    const out = {
      v: 1,
      bg: d.bg,
      view: { x: r1(d.view.x), y: r1(d.view.y), z: Math.round(d.view.z * 1000) / 1000 },
      strokes: d.strokes.map((s) => {
        const o = {
          t: s.tool, c: s.color, w: r2(s.width),
          p: s.points.map((p) => [r1(p[0]), r1(p[1]), r2(p[2])]),
        };
        if (s.sharp) o.sh = 1;
        return o;
      }),
      pdfs: d.pdfs.map((p) => {
        const o = { id: p.id, path: p.path, x: r1(p.x), y: r1(p.y), w: r1(p.w) };
        if (p.page != null) o.pg = p.page;
        return o;
      }),
    };
    if (d.links && d.links.length) {
      out.links = d.links.map((l) => ({
        id: l.id, path: l.path, x: r1(l.x), y: r1(l.y), w: r1(l.w || CARD_W),
      }));
    }
    return JSON.stringify(out);
  }

  loadData(data) {
    let j = null;
    try { j = data && data.trim() ? JSON.parse(data) : null; }
    catch (e) { new Notice("Ink Canvas: Datei konnte nicht gelesen werden."); }
    const d = newDoc(this.plugin.settings.background);
    if (j) {
      d.bg = BGS.includes(j.bg) ? j.bg : d.bg;
      if (j.view) d.view = { x: j.view.x || 0, y: j.view.y || 0, z: clamp(j.view.z || 1, 0.1, 8) };
      d.strokes = (j.strokes || []).map((s) => ({
        tool: s.t === "highlighter" ? "highlighter" : "pen",
        color: s.c || "#111111",
        width: s.w || 2.5,
        sharp: !!s.sh,
        points: (s.p || []).map((p) => [p[0], p[1], p[2] == null ? 0.5 : p[2]]),
      })).filter((s) => s.points.length);
      d.pdfs = (j.pdfs || []).map((p) => ({
        id: p.id || uid(), path: p.path, x: p.x || 0, y: p.y || 0, w: p.w || PAGE_W,
        page: Number.isInteger(p.pg) ? p.pg : null,
      }));
      d.links = (j.links || []).map((l) => ({
        id: l.id || uid(), path: l.path, x: l.x || 0, y: l.y || 0, w: l.w || CARD_W,
      }));
    }
    this.destroyPdfs();
    this.doc = d;
    this.undoStack = []; this.redoStack = [];
    this.sel = null;
    this.refreshToolbar();
    for (const entry of d.pdfs) this.ensureDoc(entry.path).catch(() => {});
    this.invalidateStatic();
  }

  destroyPdfs() {
    this.loadToken++;
    for (const d of this.docs.values()) {
      try { d.pdf && d.pdf.destroy && d.pdf.destroy(); } catch (e) { /* */ }
    }
    this.docs.clear();
    this.pageCache.clear();
    this.pending.clear();
  }

  /* ----- PDF (Ausdruck & Anhang-Karte) ----- */
  ensureDoc(path) {
    const existing = this.docs.get(path);
    if (existing) return existing.promise;
    const token = this.loadToken;
    const d = { state: "loading", path, asp: [], pdf: null };
    this.docs.set(path, d);
    d.promise = (async () => {
      try {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!(f instanceof TFile)) throw new Error("PDF nicht gefunden: " + path);
        const buf = await this.app.vault.readBinary(f);
        const pdfjs = await loadPdfJs();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        const asp = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const vp = pg.getViewport({ scale: 1 });
          asp.push(vp.height / vp.width);
        }
        if (token !== this.loadToken) { try { pdf.destroy(); } catch (e) { /* */ } return d; }
        d.pdf = pdf;
        d.asp = asp;
        d.state = "ok";
      } catch (e) {
        console.error("Ink Canvas PDF:", e);
        d.state = "error";
        d.error = String(e && e.message ? e.message : e);
        throw e;
      } finally {
        this.invalidateStatic();
      }
      return d;
    })();
    d.promise.catch(() => {});
    return d.promise;
  }

  entryLayout(e) {
    const d = this.docs.get(e.path);
    if (!d || d.state !== "ok") return null;
    if (e._lay && e._lw === e.w && e._ld === d) return e._lay;
    const pages = [];
    let y = 0;
    if (e.page != null) {
      const h = e.w * (d.asp[e.page] || 1.414);
      pages.push({ idx: e.page, y: 0, h });
      y = h;
    } else {
      const gap = (PAGE_GAP * e.w) / PAGE_W;
      for (let i = 0; i < d.asp.length; i++) {
        const h = e.w * d.asp[i];
        pages.push({ idx: i, y, h });
        y += h + gap;
      }
      y -= gap;
    }
    e._lay = { pages, total: y };
    e._lw = e.w;
    e._ld = d;
    return e._lay;
  }

  pdfTotal(e) {
    const lay = this.entryLayout(e);
    return lay ? lay.total : (200 * e.w) / PAGE_W;
  }

  linkHeight(l) {
    return CARD_H * ((l.w || CARD_W) / CARD_W);
  }

  requestPage(e, idx) {
    const d = this.docs.get(e.path);
    if (!d || d.state !== "ok") return null;
    const bucket = clamp(Math.round((e.w / PAGE_W) * 4) / 4, 0.25, 4);
    const key = e.path + "|" + idx + "|" + bucket;
    const c = this.pageCache.get(key);
    if (c) {
      this.pageCache.delete(key);
      this.pageCache.set(key, c);
      return c;
    }
    let fallback = null;
    const prefix = e.path + "|" + idx + "|";
    for (const [k, v] of this.pageCache) if (k.startsWith(prefix)) fallback = v;
    if (this.scaling || this.pending.has(key)) return fallback;

    this.pending.add(key);
    const token = this.loadToken;
    (async () => {
      try {
        const pg = await d.pdf.getPage(idx + 1);
        const vp0 = pg.getViewport({ scale: 1 });
        const pxW = Math.min(3600, PAGE_W * bucket * this.plugin.settings.pdfQuality);
        const vp = pg.getViewport({ scale: pxW / vp0.width });
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.floor(vp.width));
        cv.height = Math.max(1, Math.floor(vp.height));
        await pg.render({ canvasContext: cv.getContext("2d"), canvas: cv, viewport: vp }).promise;
        if (token !== this.loadToken) return;
        this.pageCache.set(key, cv);
        while (this.pageCache.size > MAX_CACHED_PAGES) {
          this.pageCache.delete(this.pageCache.keys().next().value);
        }
      } catch (err) {
        console.error("Ink Canvas Seite:", err);
      } finally {
        this.pending.delete(key);
        this.invalidateStatic();
      }
    })();
    return fallback;
  }

  /** Fügt ein PDF als Seiten-Ausdruck ein. */
  async addPdf(file) {
    const d = this.doc;
    let x = 0;
    if (d.pdfs.length) x = Math.max(...d.pdfs.map((p) => p.x + p.w)) + 100;
    const entry = { id: uid(), path: file.path, x, y: 0, w: PAGE_W, page: null };
    try {
      await this.ensureDoc(file.path);
    } catch (e) {
      this.docs.delete(file.path);
      new Notice("PDF konnte nicht geladen werden: " + file.name);
      return;
    }
    d.pdfs.push(entry);
    this.pushUndo({ t: "pdfadd", entry });
    this.sel = null;
    await new Promise((r) => requestAnimationFrame(r));
    this.fitPdfWidth(entry);
    this.changed();
  }

  /** Neu in v1.3: Fügt ein PDF als kompakte, anklickbare Anhang-Karte ein. */
  addPdfLink(file) {
    const d = this.doc;
    const v = d.view;
    // Karte mittig im aktuellen Sichtfeld platzieren
    const cx = (this.cssW / 2 - v.x) / v.z - CARD_W / 2;
    const cy = (this.cssH / 2 - v.y) / v.z - CARD_H / 2;
    const link = { id: uid(), path: file.path, x: Math.round(cx), y: Math.round(cy), w: CARD_W };
    d.links.push(link);
    this.pushUndo({ t: "linkadd", link });
    this.sel = { entry: null, link, strokes: [] };
    new Notice(`PDF-Anhang verknüpft: ${file.name}`);
    this.changed();
  }

  /** Öffnet ein verknüpftes PDF in einem neuen Obsidian-Tab. */
  async openPdfLink(link) {
    const f = this.app.vault.getAbstractFileByPath(link.path);
    if (!(f instanceof TFile)) {
      new Notice("Verknüpfte PDF nicht gefunden: " + link.path);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(f);
  }

  hitPdf(d) {
    for (let i = this.doc.pdfs.length - 1; i >= 0; i--) {
      const p = this.doc.pdfs[i];
      if (d.x >= p.x && d.x <= p.x + p.w && d.y >= p.y && d.y <= p.y + this.pdfTotal(p)) return p;
    }
    return null;
  }

  hitLink(d) {
    const links = this.doc.links || [];
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      const w = l.w || CARD_W;
      const h = this.linkHeight(l);
      if (d.x >= l.x && d.x <= l.x + w && d.y >= l.y && d.y <= l.y + h) return l;
    }
    return null;
  }

  /** Prüft, ob direkt auf den "Öffnen"-Button rechts auf einer PDF-Anhang-Karte geklickt wurde. */
  hitLinkOpenButton(d) {
    const l = this.hitLink(d);
    if (!l) return null;
    const w = l.w || CARD_W;
    const s = w / CARD_W;
    const h = CARD_H * s;
    const btnW = 64 * s, btnH = 36 * s;
    const btnX = l.x + w - btnW - 10 * s, btnY = l.y + (h - btnH) / 2;
    if (d.x >= btnX && d.x <= btnX + btnW && d.y >= btnY && d.y <= btnY + btnH) return l;
    return null;
  }

  hitSingleStroke(d) {
    const r = 10 / this.doc.view.z;
    for (let i = this.doc.strokes.length - 1; i >= 0; i--) {
      const s = this.doc.strokes[i];
      const b = strokeBounds(s);
      if (d.x < b.x0 - r || d.x > b.x1 + r || d.y < b.y0 - r || d.y > b.y1 + r) continue;
      if (strokeHit(s, d.x, d.y, r + (s.width * widthMult(s)) / 2)) return s;
    }
    return null;
  }

  strokesInEntry(e) {
    const total = this.pdfTotal(e);
    return this.doc.strokes.filter((s) => {
      const q = s.points[0];
      return q[0] >= e.x && q[0] <= e.x + e.w && q[1] >= e.y && q[1] <= e.y + total;
    });
  }

  /* ----- Auswahl ----- */
  selBounds() {
    const s = this.sel;
    if (!s) return null;
    if (s.entry) {
      const e = s.entry;
      return { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + this.pdfTotal(e) };
    }
    if (s.link) {
      const l = s.link;
      return { x0: l.x, y0: l.y, x1: l.x + (l.w || CARD_W), y1: l.y + this.linkHeight(l) };
    }
    if (!s.strokes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const st of s.strokes) {
      const b = strokeBounds(st);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    return { x0, y0, x1, y1 };
  }

  hitHandle(p) {
    const b = this.selBounds();
    if (!b) return null;
    const v = this.doc.view;
    const corners = [
      { hx: b.x1, hy: b.y1, ox: b.x0, oy: b.y0 },
      { hx: b.x0, hy: b.y1, ox: b.x1, oy: b.y0 },
      { hx: b.x1, hy: b.y0, ox: b.x0, oy: b.y1 },
      { hx: b.x0, hy: b.y0, ox: b.x1, oy: b.y1 },
    ];
    if (this.sel && (this.sel.entry || this.sel.link)) {
      const sx = b.x1 * v.z + v.x, sy = b.y1 * v.z + v.y;
      return Math.hypot(p.x - sx, p.y - sy) <= HANDLE_R ? corners[0] : null;
    }
    for (const c of corners) {
      const sx = c.hx * v.z + v.x, sy = c.hy * v.z + v.y;
      if (Math.hypot(p.x - sx, p.y - sy) <= HANDLE_R) return c;
    }
    return null;
  }

  deleteSelection() {
    const s = this.sel;
    if (!s) return;
    const d = this.doc;
    if (s.entry) {
      const i = d.pdfs.indexOf(s.entry);
      if (i >= 0) {
        d.pdfs.splice(i, 1);
        this.pushUndo({ t: "pdfdel", entry: s.entry, i });
      }
    } else if (s.link) {
      const i = d.links.indexOf(s.link);
      if (i >= 0) {
        d.links.splice(i, 1);
        this.pushUndo({ t: "linkdel", link: s.link, i });
      }
    } else if (s.strokes.length) {
      const set = new Set(s.strokes);
      const items = [];
      for (let i = d.strokes.length - 1; i >= 0; i--) {
        if (set.has(d.strokes[i])) {
          items.push({ s: d.strokes[i], i });
          d.strokes.splice(i, 1);
        }
      }
      if (items.length) this.pushUndo({ t: "del", items });
    }
    this.sel = null;
    this.changed();
  }

  duplicateSelection() {
    const s = this.sel;
    if (!s || s.entry || s.link || !s.strokes.length) return;
    const copies = s.strokes.map((o) => ({
      tool: o.tool, color: o.color, width: o.width, sharp: o.sharp,
      points: o.points.map((p) => [p[0] + 30, p[1] + 30, p[2]]),
    }));
    this.doc.strokes.push(...copies);
    this.pushUndo({ t: "addmany", list: copies });
    this.sel = { entry: null, link: null, strokes: copies };
    this.changed();
  }

  scaleSelection(k) {
    const s = this.sel;
    const b = this.selBounds();
    if (!s || !b) return;
    if (s.entry) k = clamp(k, 100 / s.entry.w, 6000 / s.entry.w);
    if (s.link) k = clamp(k, 160 / s.link.w, 1200 / s.link.w);
    const ox = s.entry ? s.entry.x : s.link ? s.link.x : b.x0;
    const oy = s.entry ? s.entry.y : s.link ? s.link.y : b.y0;
    scaleStrokes(s.strokes, ox, oy, k);
    if (s.entry) s.entry.w *= k;
    if (s.link) s.link.w *= k;
    this.pushUndo({ t: "scale", entry: s.entry, link: s.link, strokes: s.strokes, ox, oy, k });
    this.changed();
  }

  ungroupSelection() {
    const s = this.sel;
    if (!s || !s.entry || s.entry.page != null) return;
    const e = s.entry;
    const lay = this.entryLayout(e);
    if (!lay || lay.pages.length < 2) return;
    const list = lay.pages.map((p) => ({
      id: uid(), path: e.path, x: e.x, y: e.y + p.y, w: e.w, page: p.idx,
    }));
    const i = this.doc.pdfs.indexOf(e);
    if (i < 0) return;
    this.doc.pdfs.splice(i, 1, ...list);
    this.pushUndo({ t: "ungroup", old: e, list });
    this.sel = null;
    new Notice("PDF in " + list.length + " Einzelseiten aufgeteilt.");
    this.changed();
  }

  /* ----- Ansicht / Navigation ----- */
  fitPdfWidth(entry) {
    const v = this.doc.view;
    const z = clamp((this.cssW - 40) / entry.w, 0.2, 4);
    v.z = z;
    v.x = (this.cssW - entry.w * z) / 2 - entry.x * z;
    v.y = 20 - entry.y * z;
    this.invalidateStatic();
  }

  resetZoom100() {
    const v = this.doc.view;
    const cx = this.cssW / 2, cy = this.cssH / 2;
    const k = 1 / v.z;
    v.x = cx - (cx - v.x) * k;
    v.y = cy - (cy - v.y) * k;
    v.z = 1;
    this.invalidateStatic();
  }

  contentBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of this.doc.pdfs) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + this.pdfTotal(p));
    }
    for (const l of (this.doc.links || [])) {
      x0 = Math.min(x0, l.x); y0 = Math.min(y0, l.y);
      x1 = Math.max(x1, l.x + (l.w || CARD_W)); y1 = Math.max(y1, l.y + this.linkHeight(l));
    }
    for (const s of this.doc.strokes) {
      const b = strokeBounds(s);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    }
    if (x0 === Infinity) return null;
    return { x0, y0, x1, y1 };
  }

  fitAll() {
    const b = this.contentBounds();
    const v = this.doc.view;
    if (!b) { v.x = 40; v.y = 40; v.z = 1; this.invalidateStatic(); return; }
    const w = Math.max(1, b.x1 - b.x0), h = Math.max(1, b.y1 - b.y0);
    const z = clamp(Math.min((this.cssW - 40) / w, (this.cssH - 40) / h), 0.1, 2);
    v.z = z;
    v.x = (this.cssW - w * z) / 2 - b.x0 * z;
    v.y = (this.cssH - h * z) / 2 - b.y0 * z;
    this.invalidateStatic();
  }

  /* ----- Undo/Redo ----- */
  pushUndo(a) {
    this.undoStack.push(a);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    this.applyAction(a, true);
    this.redoStack.push(a);
    this.sel = null;
    this.changed();
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    this.applyAction(a, false);
    this.undoStack.push(a);
    this.sel = null;
    this.changed();
  }

  applyAction(a, reverse) {
    const d = this.doc;
    switch (a.t) {
      case "add":
        if (reverse) {
          const i = d.strokes.lastIndexOf(a.s);
          if (i >= 0) d.strokes.splice(i, 1);
        } else d.strokes.push(a.s);
        break;
      case "addmany":
        if (reverse) d.strokes = d.strokes.filter((x) => !a.list.includes(x));
        else d.strokes.push(...a.list);
        break;
      case "del":
        if (reverse) {
          for (let k = a.items.length - 1; k >= 0; k--) d.strokes.splice(a.items[k].i, 0, a.items[k].s);
        } else {
          for (let k = 0; k < a.items.length; k++) d.strokes.splice(a.items[k].i, 1);
        }
        break;
      case "pdfadd":
        if (reverse) d.pdfs = d.pdfs.filter((p) => p !== a.entry);
        else d.pdfs.push(a.entry);
        break;
      case "pdfdel":
        if (reverse) d.pdfs.splice(a.i, 0, a.entry);
        else d.pdfs = d.pdfs.filter((p) => p !== a.entry);
        break;
      case "linkadd":
        if (reverse) d.links = d.links.filter((l) => l !== a.link);
        else d.links.push(a.link);
        break;
      case "linkdel":
        if (reverse) d.links.splice(a.i, 0, a.link);
        else d.links = d.links.filter((l) => l !== a.link);
        break;
      case "ungroup":
        if (reverse) {
          const i = d.pdfs.indexOf(a.list[0]);
          if (i >= 0) d.pdfs.splice(i, a.list.length, a.old);
        } else {
          const i = d.pdfs.indexOf(a.old);
          if (i >= 0) d.pdfs.splice(i, 1, ...a.list);
        }
        break;
      case "move": {
        const sg = reverse ? -1 : 1;
        if (a.entry) { a.entry.x += sg * a.dx; a.entry.y += sg * a.dy; }
        if (a.link) { a.link.x += sg * a.dx; a.link.y += sg * a.dy; }
        shiftStrokes(a.strokes, sg * a.dx, sg * a.dy);
        break;
      }
      case "scale": {
        const k = reverse ? 1 / a.k : a.k;
        scaleStrokes(a.strokes, a.ox, a.oy, k);
        if (a.entry) a.entry.w *= k;
        if (a.link) a.link.w *= k;
        break;
      }
    }
  }

  changed() {
    this.requestSave();
    this.invalidateStatic();
    this.refreshToolbar();
  }

  /* ----- UI (PC-Optik + Custom Color Picker + PDF-Menü) ----- */
  buildUI() {
    const root = this.contentEl;
    this.toolbar = root.createDiv({ cls: "ink-toolbar" });
    this.wrap = root.createDiv({ cls: "ink-canvas-wrap" });
    this.canvas = this.wrap.createEl("canvas", { cls: "ink-canvas" });

    this.zoomBadge = this.wrap.createEl("button", {
      cls: "ink-hud-zoom",
      text: "100%",
      attr: { title: "Auf 100% Zoom zurücksetzen" },
    });
    this.zoomBadge.addEventListener("click", () => this.resetZoom100());

    this.debugHud = this.wrap.createDiv({ cls: "ink-hud-debug" });

    this.uncollapseBtn = this.wrap.createEl("button", {
      cls: "ink-hud-uncollapse",
      attr: { title: "Werkzeugleiste einblenden" },
    });
    setIcon(this.uncollapseBtn, "chevron-down");
    this.uncollapseBtn.addEventListener("click", () => this.toggleToolbar(false));

    const mk = (icon, label, fn) => {
      const b = this.toolbar.createEl("button", { cls: "ink-btn", attr: { "aria-label": label, title: label } });
      setIcon(b, icon);
      b.addEventListener("click", (ev) => fn(ev));
      return b;
    };
    const sep = () => this.toolbar.createDiv({ cls: "ink-sep" });
    const slider = (icon, label, min, max, step, value, fmt, onInput) => {
      const grp = this.toolbar.createDiv({ cls: "ink-slider-group", attr: { title: label } });
      const ic = grp.createDiv({ cls: "ink-ico" });
      setIcon(ic, icon);
      const inp = grp.createEl("input", {
        cls: "ink-width",
        attr: { type: "range", min: String(min), max: String(max), step: String(step), title: label },
      });
      inp.value = String(value);
      const valEl = grp.createSpan({ cls: "ink-val-label", text: fmt(value) });
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        valEl.textContent = fmt(v);
        onInput(v);
      });
      return inp;
    };

    this.btnPen = mk("pencil", "Stift", () => this.setTool("pen"));
    this.btnHl = mk("highlighter", "Textmarker", () => this.setTool("highlighter"));
    this.btnEr = mk("eraser", "Radierer (Strich löschen)", () => this.setTool("eraser"));
    this.btnLasso = mk("lasso-select", "Lasso: Antippen oder einkreisen, verschieben, skalieren", () => this.setTool("lasso"));
    this.btnMove = mk("move", "Verschieben: PDF/Anhang wählen & ziehen, Fläche schieben", () => this.setTool("move"));
    sep();
    this.colorBox = this.toolbar.createDiv({ cls: "ink-colors" });
    slider("minus", "Strichstärke", 1, 14, 0.5, this.width, (v) => v.toFixed(1), (v) => {
      this.width = v;
      this.plugin.settings.penWidth = v;
      this.plugin.saveSettings();
    });
    slider("waves", "Glättung der Handschrift", 0, 1, 0.05, this.plugin.settings.smoothing, (v) => Math.round(v * 100) + "%", (v) => {
      this.plugin.settings.smoothing = v;
      this.plugin.saveSettings();
    });
    sep();
    this.btnUndo = mk("undo-2", "Rückgängig (2-Finger-Tippen)", () => this.undo());
    this.btnRedo = mk("redo-2", "Wiederholen (3-Finger-Tippen)", () => this.redo());
    sep();

    // PDF-Menü: Auswahl zwischen "Als Ausdruck" und "Als Anhang-Karte verknüpfen"
    mk("file-plus", "PDF einfügen (als Ausdruck oder als verknüpfter Anhang)", (ev) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("PDF als Ausdruck einfügen (Seiten zum Beschriften)")
          .setIcon("file-text")
          .onClick(() => this.plugin.pickPdf((f) => this.addPdf(f)))
      );
      menu.addItem((item) =>
        item
          .setTitle("PDF als Anhang-Karte verknüpfen (Kompakter Link)")
          .setIcon("paperclip")
          .onClick(() => this.plugin.pickPdf((f) => this.addPdfLink(f)))
      );
      menu.showAtMouseEvent(ev);
    });

    this.btnOpenLink = mk("external-link", "Verknüpftes PDF öffnen", () => {
      if (this.sel && this.sel.link) this.openPdfLink(this.sel.link);
      else if (this.sel && this.sel.entry) this.openPdfLink(this.sel.entry);
    });
    this.btnUngroup = mk("ungroup", "PDF in Einzelseiten aufteilen (entgruppieren)", () => this.ungroupSelection());
    this.btnGrow = mk("expand", "Auswahl vergrößern", () => this.scaleSelection(1.1));
    this.btnShrink = mk("shrink", "Auswahl verkleinern", () => this.scaleSelection(1 / 1.1));
    this.btnDup = mk("copy", "Auswahl duplizieren", () => this.duplicateSelection());
    this.btnDel = mk("trash-2", "Auswahl löschen", () => this.deleteSelection());
    sep();
    this.btnShape = mk("shapes", "Formerkennung beim Halten (an/aus)", () => {
      this.plugin.settings.shapeRecognition = !this.plugin.settings.shapeRecognition;
      this.plugin.saveSettings();
      this.refreshToolbar();
    });
    this.btnFinger = mk("hand", "Mit Finger zeichnen (an/aus)", () => {
      this.plugin.settings.fingerDraws = !this.plugin.settings.fingerDraws;
      this.plugin.saveSettings();
      this.refreshToolbar();
    });
    this.btnBg = mk("grid-3x3", "Hintergrund wechseln", () => {
      const i = BGS.indexOf(this.doc.bg);
      this.doc.bg = BGS[(i + 1) % BGS.length];
      new Notice("Hintergrund: " + BG_LABELS[this.doc.bg]);
      this.changed();
    });
    mk("maximize", "Alles anzeigen", () => this.fitAll());
    mk("image-down", "Als PNG exportieren", () => this.exportPng());
    mk("chevron-up", "Werkzeugleiste ausblenden (Vollbild)", () => this.toggleToolbar(true));

    this.bindEvents();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);
    this.resize();
    this.refreshToolbar();
  }

  toggleToolbar(collapse) {
    this.toolbar.classList.toggle("is-collapsed", collapse);
    this.uncollapseBtn.classList.toggle("is-visible", collapse);
    setTimeout(() => this.resize(), 20);
  }

  setTool(t) {
    if (t !== this.tool) { this.sel = null; this.lasso = null; }
    this.tool = t;
    this.refreshToolbar();
    this.requestDraw();
  }

  refreshToolbar() {
    if (!this.btnPen) return;
    const act = (b, on) => b.classList.toggle("is-active", !!on);
    act(this.btnPen, this.tool === "pen");
    act(this.btnHl, this.tool === "highlighter");
    act(this.btnEr, this.tool === "eraser");
    act(this.btnLasso, this.tool === "lasso");
    act(this.btnMove, this.tool === "move");
    act(this.btnFinger, this.plugin.settings.fingerDraws);
    act(this.btnShape, this.plugin.settings.shapeRecognition);
    this.btnUndo.disabled = !this.undoStack.length;
    this.btnRedo.disabled = !this.redoStack.length;

    const s = this.sel;
    this.btnDel.disabled = !s;
    this.btnGrow.disabled = !s;
    this.btnShrink.disabled = !s;
    this.btnDup.disabled = !(s && !s.entry && !s.link && s.strokes.length);
    this.btnOpenLink.disabled = !(s && (s.link || s.entry));
    const lay = s && s.entry ? this.entryLayout(s.entry) : null;
    this.btnUngroup.disabled = !(s && s.entry && s.entry.page == null && lay && lay.pages.length > 1);

    this.colorBox.empty();
    if (this.tool === "pen" || this.tool === "highlighter") {
      const isPen = this.tool === "pen";
      const defaults = isPen ? DEFAULT_PEN_COLORS : DEFAULT_HL_COLORS;
      const customs = (isPen ? this.plugin.settings.customPenColors : this.plugin.settings.customHlColors) || [];
      const allColors = [...defaults, ...customs.filter((c) => !defaults.includes(c))];
      const cur = isPen ? this.penColor : this.hlColor;

      for (const c of allColors) {
        const isCustom = customs.includes(c) && !defaults.includes(c);
        const sw = this.colorBox.createEl("button", {
          cls: "ink-swatch",
          attr: {
            "aria-label": c,
            title: isCustom ? `${c} (Rechtsklick / lang drücken zum Entfernen)` : c,
          },
        });
        sw.style.background = c;
        if (c.toLowerCase() === cur.toLowerCase()) sw.classList.add("is-active");
        sw.addEventListener("click", () => {
          if (isPen) this.penColor = c; else this.hlColor = c;
          this.refreshToolbar();
        });
        if (isCustom) {
          const removeCustomColor = (ev) => {
            ev.preventDefault();
            if (isPen) {
              this.plugin.settings.customPenColors = customs.filter((x) => x !== c);
              if (this.penColor === c) this.penColor = DEFAULT_PEN_COLORS[0];
            } else {
              this.plugin.settings.customHlColors = customs.filter((x) => x !== c);
              if (this.hlColor === c) this.hlColor = DEFAULT_HL_COLORS[0];
            }
            this.plugin.saveSettings();
            this.refreshToolbar();
            new Notice(`Eigene Farbe ${c} entfernt.`);
          };
          sw.addEventListener("contextmenu", removeCustomColor);
        }
      }

      // Custom Color Picker (+) für eigene Stift- & Textmarker-Farben
      const pickerWrap = this.colorBox.createDiv({
        cls: "ink-color-picker-wrap",
        attr: { title: "Eigene Farbe auswählen & speichern" },
      });
      pickerWrap.createDiv({ cls: "ink-color-picker-btn", text: "+" });
      const colorInp = pickerWrap.createEl("input", {
        cls: "ink-color-input",
        attr: { type: "color", value: cur },
      });
      // Live-Farbwechsel beim Ziehen im Farbwähler
      colorInp.addEventListener("input", () => {
        const val = colorInp.value;
        if (isPen) this.penColor = val; else this.hlColor = val;
      });
      // Beim Schließen des Wählers in den eigenen Farben speichern
      colorInp.addEventListener("change", () => {
        const val = colorInp.value.toLowerCase();
        if (isPen) {
          this.penColor = val;
          if (!DEFAULT_PEN_COLORS.includes(val) && !this.plugin.settings.customPenColors.includes(val)) {
            this.plugin.settings.customPenColors.push(val);
            this.plugin.saveSettings();
          }
        } else {
          this.hlColor = val;
          if (!DEFAULT_HL_COLORS.includes(val) && !this.plugin.settings.customHlColors.includes(val)) {
            this.plugin.settings.customHlColors.push(val);
            this.plugin.saveSettings();
          }
        }
        this.refreshToolbar();
      });
    }
  }

  resize() {
    if (!this.canvas) return;
    const r = this.wrap.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    const pw = Math.round(this.cssW * this.dpr);
    const ph = Math.round(this.cssH * this.dpr);
    this.canvas.style.width = this.cssW + "px";
    this.canvas.style.height = this.cssH + "px";
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.staticCanvas.width = pw;
    this.staticCanvas.height = ph;
    this.invalidateStatic();
  }

  /* ----- Rendering mit 120Hz Offscreen-Layer-Cache ----- */
  invalidateStatic() {
    this.staticDirty = true;
    this.requestDraw();
  }

  requestDraw() {
    if (this.drawQueued || !this.canvas) return;
    this.drawQueued = true;
    requestAnimationFrame(() => this.draw());
  }

  drawBackground(ctx) {
    const v = this.doc.view;
    const bg = this.doc.bg;
    if (bg === "none") return;
    let s = 40 * v.z;
    while (s < 12) s *= 2;
    while ((this.cssW / s) * (this.cssH / s) > 6000) s *= 2;
    const ox = ((v.x % s) + s) % s;
    const oy = ((v.y % s) + s) % s;
    if (bg === "dots") {
      ctx.fillStyle = "#b8bfcc";
      for (let x = ox; x < this.cssW; x += s) {
        for (let y = oy; y < this.cssH; y += s) {
          ctx.beginPath();
          ctx.arc(x, y, 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }
    ctx.strokeStyle = "#e4e7ee";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = oy; y < this.cssH; y += s) { ctx.moveTo(0, y); ctx.lineTo(this.cssW, y); }
    if (bg === "grid") {
      for (let x = ox; x < this.cssW; x += s) { ctx.moveTo(x, 0); ctx.lineTo(x, this.cssH); }
    }
    ctx.stroke();
  }

  renderStaticLayer() {
    this.staticDirty = false;
    const sc = this.staticCanvas;
    if (!sc.width || !sc.height) return;
    const ctx = sc.getContext("2d");
    const dpr = this.dpr;
    const v = this.doc.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sc.width, sc.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawBackground(ctx);

    ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * v.x, dpr * v.y);
    const vx0 = -v.x / v.z, vy0 = -v.y / v.z;
    const vx1 = (this.cssW - v.x) / v.z, vy1 = (this.cssH - v.y) / v.z;

    // 1. PDF-Ausdrucke
    for (const e of this.doc.pdfs) {
      const lay = this.entryLayout(e);
      if (!lay) {
        const d = this.docs.get(e.path);
        const k = e.w / PAGE_W;
        ctx.fillStyle = "#f4f5f8";
        ctx.fillRect(e.x, e.y, e.w, 200 * k);
        ctx.fillStyle = "#6b7280";
        ctx.font = 18 * k + "px sans-serif";
        const msg = !d || d.state === "loading" ? "PDF wird geladen …" : "PDF fehlt: " + e.path;
        ctx.fillText(msg, e.x + 20 * k, e.y + 100 * k);
        continue;
      }
      if (e.x > vx1 || e.x + e.w < vx0) continue;
      for (const p of lay.pages) {
        const py = e.y + p.y;
        if (py > vy1 || py + p.h < vy0) continue;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(e.x, py, e.w, p.h);
        let img = null;
        if (p.h * v.z >= 150) img = this.requestPage(e, p.idx);
        if (img) ctx.drawImage(img, e.x, py, e.w, p.h);
        ctx.strokeStyle = "#cfd4dc";
        ctx.lineWidth = 1 / v.z;
        ctx.strokeRect(e.x, py, e.w, p.h);
        if (!img) {
          ctx.fillStyle = "#9aa1ad";
          ctx.font = 20 * (e.w / PAGE_W) + "px sans-serif";
          ctx.fillText("Seite " + (p.idx + 1), e.x + 20, py + 34 * (e.w / PAGE_W));
        }
      }
    }

    // 2. Verknüpfte PDF-Anhang-Karten (v1.3)
    for (const lnk of (this.doc.links || [])) {
      const w = lnk.w || CARD_W;
      const h = this.linkHeight(lnk);
      if (lnk.x > vx1 || lnk.x + w < vx0 || lnk.y > vy1 || lnk.y + h < vy0) continue;
      drawPdfLinkCard(ctx, lnk, v.z);
    }

    // 3. Striche
    for (const s of this.doc.strokes) {
      const b = strokeBounds(s);
      if (b.x1 < vx0 || b.x0 > vx1 || b.y1 < vy0 || b.y0 > vy1) continue;
      paintStroke(ctx, s);
    }

    if (this.zoomBadge) {
      this.zoomBadge.textContent = Math.round(v.z * 100) + "%";
    }
  }

  appendStrokeToStatic(s) {
    const sc = this.staticCanvas;
    if (!sc.width || !sc.height) return;
    const ctx = sc.getContext("2d");
    const dpr = this.dpr;
    const v = this.doc.view;
    ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * v.x, dpr * v.y);
    paintStroke(ctx, s);
  }

  draw() {
    this.drawQueued = false;
    const cv = this.canvas;
    if (!cv) return;
    if (this.staticDirty) this.renderStaticLayer();

    const ctx = cv.getContext("2d");
    const dpr = this.dpr;
    const v = this.doc.view;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticCanvas, 0, 0);

    ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * v.x, dpr * v.y);
    if (this.cur) paintStroke(ctx, this.cur, this.predicted);

    const sb = this.selBounds();
    if (sb) {
      ctx.save();
      ctx.strokeStyle = "#4c8dff";
      ctx.lineWidth = 2 / v.z;
      ctx.setLineDash([8 / v.z, 5 / v.z]);
      ctx.strokeRect(sb.x0, sb.y0, sb.x1 - sb.x0, sb.y1 - sb.y0);
      ctx.restore();
    }

    if (this.lasso && this.lasso.pts.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(this.lasso.pts[0][0], this.lasso.pts[0][1]);
      for (let i = 1; i < this.lasso.pts.length; i++) ctx.lineTo(this.lasso.pts[i][0], this.lasso.pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = "rgba(76,141,255,0.08)";
      ctx.fill();
      ctx.strokeStyle = "rgba(76,141,255,0.95)";
      ctx.lineWidth = 1.5 / v.z;
      ctx.setLineDash([6 / v.z, 4 / v.z]);
      ctx.stroke();
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sb) {
      const pts = this.sel && (this.sel.entry || this.sel.link)
        ? [[sb.x1, sb.y1]]
        : [[sb.x0, sb.y0], [sb.x1, sb.y0], [sb.x0, sb.y1], [sb.x1, sb.y1]];
      for (const [cx, cy] of pts) {
        const hx = cx * v.z + v.x, hy = cy * v.z + v.y;
        ctx.beginPath();
        ctx.arc(hx, hy, 8, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.strokeStyle = "#4c8dff";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
    if (this.eraserPos) {
      ctx.save();
      ctx.fillStyle = "rgba(224, 49, 49, 0.14)";
      ctx.strokeStyle = "rgba(224, 49, 49, 0.88)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(this.eraserPos.x, this.eraserPos.y, ERASER_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ----- Eingabe & Multi-Layer S-Pen-Erkennung ----- */
  bindEvents() {
    const c = this.canvas;

    // 1. Native Android TouchEvent-Prüfung (Samsung S-Pen meldet Barrel-Button oft über touch.toolType === "eraser")
    const checkAndroidTouchEraser = (te) => {
      let foundEraser = false;
      const list = te.touches && te.touches.length ? te.touches : te.changedTouches || [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const tt = t.toolType || t.touchType || "";
        if (tt === "eraser" || tt === 2 || tt === 3) {
          foundEraser = true;
          break;
        }
      }
      this.androidTouchEraser = foundEraser;
      if (foundEraser) {
        this.lastBarrelTime = performance.now();
        this.switchActiveDrawToBarrel();
      }
    };
    c.addEventListener("touchstart", checkAndroidTouchEraser, { passive: true });
    c.addEventListener("touchmove", checkAndroidTouchEraser, { passive: true });
    c.addEventListener("touchend", () => { this.androidTouchEraser = false; }, { passive: true });

    // 2. Contextmenu-Abfang (Samsung S-Pen mit gedrückter Taste feuert oft contextmenu beim Aufsetzen)
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Wenn ein Stift aktiv oder in der Nähe ist, bedeutet contextmenu = S-Pen-Taste gedrückt!
      if (e.pointerType === "pen" || performance.now() - this.lastPen < 600) {
        this.lastBarrelTime = performance.now();
        this.switchActiveDrawToBarrel(this.local(e));
      }
    });

    // 3. Bluetooth / Air-Action KeyEvent-Detektor (für S-Pen Pro / Air Actions)
    this._keyDownHandler = (ke) => {
      if (ke.key === "F20" || ke.key === "F21" || ke.code === "Eraser") {
        this.keyBarrelHeld = true;
        this.lastBarrelTime = performance.now();
        this.switchActiveDrawToBarrel();
      }
    };
    this._keyUpHandler = (ke) => {
      if (ke.key === "F20" || ke.key === "F21" || ke.code === "Eraser") {
        this.keyBarrelHeld = false;
      }
    };
    window.addEventListener("keydown", this._keyDownHandler, true);
    window.addEventListener("keyup", this._keyUpHandler, true);

    // 4. Reguläre PointerEvents
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e, false));
    c.addEventListener("pointercancel", (e) => this.onUp(e, true));
    c.addEventListener("pointerleave", () => {
      if (this.eraserPos && !this.active) { this.eraserPos = null; this.requestDraw(); }
    });
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("auxclick", (e) => e.preventDefault());
    c.addEventListener("selectstart", (e) => e.preventDefault());
  }

  /** Falls gerade ein Strich gezeichnet wird und Android nachträglich die S-Pen-Taste meldet, sofort umschalten! */
  switchActiveDrawToBarrel(fallbackPos) {
    const st = this.plugin.settings;
    if (st.penButton === "off") return;
    if (!this.active || this.active.kind !== "draw") return;

    clearTimeout(this.holdTimer);
    const p = fallbackPos || this.holdAnchor || { x: 0, y: 0 };
    const d = this.toDoc(p);
    const isTinyStart = (performance.now() - this.active.t0 < 240) ||
      (this.cur && this.cur.points.length < 18);

    if (!isTinyStart && this.cur && this.cur.points.length > 1) {
      this.doc.strokes.push(this.cur);
      this.pushUndo({ t: "add", s: this.cur });
      this.appendStrokeToStatic(this.cur);
      this.requestSave();
    }
    this.cur = null;
    this.predicted = [];
    this.snapped = null;

    if (st.penButton === "eraser") {
      this.active = { id: this.active.id, kind: "erase", pen: true, removed: [], lastDoc: d };
      this.eraseAtSegment(d, d, p);
    } else if (st.penButton === "pan") {
      this.active = { id: this.active.id, kind: "pan", pen: true, last: p };
    }
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  toDoc(p) {
    const v = this.doc.view;
    return { x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z };
  }

  pressure(e) {
    if (e.pointerType === "pen") return e.pressure > 0 ? e.pressure : 0.5;
    return 0.5;
  }

  /** Kombinierte S-Pen-Tasten-Erkennung aus PointerEvent, TouchEvent, Contextmenu & Hover-Gedächtnis. */
  detectPenButtons(e) {
    const isPen = e.pointerType === "pen" || this.androidTouchEraser;
    if (!isPen) return { barrel: false, eraserEnd: false };

    const b = e.buttons || 0;
    const btn = e.button;
    // Prüft Bitmasken 2 (Secondary/Barrel), 4 (Middle), 32 (Eraser) sowie button-Codes 1, 2, 5
    const directBarrel = Boolean(
      (b & 2) || (b & 4) || btn === 2 || btn === 1 ||
      this.androidTouchEraser || this.keyBarrelHeld
    );
    const directEraser = Boolean((b & 32) || btn === 5 || this.androidTouchEraser);

    if (directBarrel || directEraser) {
      this.lastBarrelTime = performance.now();
      this.hoverZeroFrames = 0;
    }
    // 320ms Zeitfenster überbrückt den kurzen Moment zwischen Hover-Ende und Spitzenkontakt auf Samsung-Displays
    const recentHoverBarrel = (performance.now() - this.lastBarrelTime) < 320;
    return {
      barrel: directBarrel || recentHoverBarrel,
      eraserEnd: directEraser,
    };
  }

  resolvePenAction(e) {
    const st = this.plugin.settings;
    const { barrel, eraserEnd } = this.detectPenButtons(e);
    if (eraserEnd && st.penEraserEnd) return "eraser";
    if ((barrel || eraserEnd) && st.penButton === "eraser") return "eraser";
    if ((barrel || eraserEnd) && st.penButton === "pan") return "pan";
    return null;
  }

  updateDebugHud(e, action) {
    if (!this.debugHud) return;
    if (!this.plugin.settings.penButtonDebug) {
      this.debugHud.classList.remove("is-visible");
      return;
    }
    this.debugHud.classList.add("is-visible");
    this.debugHud.textContent =
      `type=${e.pointerType} | buttons=${e.buttons} | button=${e.button} | ` +
      `touchEraser=${this.androidTouchEraser ? "JA" : "nein"} | aktion=${action || "stift"}`;
  }

  penBusy() {
    return (this.active && this.active.pen) || performance.now() - this.lastPen < 450;
  }

  cancelActive() {
    clearTimeout(this.holdTimer);
    if (this.active && this.active.kind === "draw") {
      this.cur = null;
      this.predicted = [];
    }
    if (this.active && this.active.kind === "scale") this.finishScale(this.active);
    this.active = null;
    this.snapped = null;
    this.lasso = null;
    this.eraserPos = null;
    this.requestDraw();
  }

  gestureState() {
    const pts = [...this.touches.values()];
    if (!pts.length) return null;
    const a = pts[0], b = pts[1];
    if (b) {
      return { n: 2, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    return { n: 1, mx: a.x, my: a.y, dist: 0 };
  }

  applyGesture() {
    const g = this.gestureState();
    const o = this.gest;
    if (!g || !o || o.n !== g.n) { this.gest = g; return; }
    const v = this.doc.view;
    let z = v.z;
    if (g.n === 2 && o.dist > 0) z = clamp(v.z * (g.dist / o.dist), 0.1, 8);
    const k = z / v.z;
    v.x = o.mx - (o.mx - v.x) * k + (g.mx - o.mx);
    v.y = o.my - (o.my - v.y) * k + (g.my - o.my);
    v.z = z;
    this.gest = g;
    this.invalidateStatic();
  }

  /* --- Formerkennung durch langes Halten --- */
  armHold() {
    clearTimeout(this.holdTimer);
    if (!this.plugin.settings.shapeRecognition) return;
    this.holdTimer = setTimeout(() => this.onHold(), this.plugin.settings.shapeHoldMs);
  }

  catchUp() {
    const r = this.rawLast;
    if (!r || !this.cur) return;
    const pts = this.cur.points;
    const last = pts[pts.length - 1];
    const v = this.doc.view;
    if (Math.hypot(r.x - last[0], r.y - last[1]) * v.z > 0.5) pts.push([r.x, r.y, r.p]);
  }

  onHold() {
    const a = this.active;
    if (!a || a.kind !== "draw" || !this.cur || this.snapped) return;
    this.catchUp();
    const res = recognizeShape(this.cur.points);
    if (!res) return;
    this.cur.points = res.pts;
    this.cur.sharp = true;
    this.cur._b = null;
    this.cur._u = undefined;
    this.predicted = [];
    this.snapped = { kind: res.kind, start: res.pts[0] };
    try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) { /* */ }
    this.requestDraw();
  }

  onDown(e) {
    e.preventDefault();
    const p = this.local(e);
    const d = this.toDoc(p);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* */ }
    const isPen = e.pointerType === "pen" || this.androidTouchEraser;

    // Klick auf den "Öffnen ↗"-Button einer PDF-Anhang-Karte öffnet die PDF sofort (in jedem Modus außer Radierer)
    const openBtnHit = this.hitLinkOpenButton(d);
    if (openBtnHit && this.tool !== "eraser") {
      this.openPdfLink(openBtnHit);
      return;
    }

    if (isPen) {
      this.lastPen = performance.now();
      if (this.active && !this.active.pen) {
        this.cancelActive();
      }
      this.touches.clear();
      this.multiTap = null;
    }

    if (e.pointerType === "touch" && !this.androidTouchEraser) {
      if (this.penBusy()) return;
      this.touches.set(e.pointerId, p);
      const count = this.touches.size;

      if (count === 1) {
        this.multiTap = { maxTouches: 1, t0: performance.now(), moved: false, startPts: new Map([[e.pointerId, p]]) };
      } else if (this.multiTap) {
        this.multiTap.maxTouches = Math.max(this.multiTap.maxTouches, count);
        this.multiTap.startPts.set(e.pointerId, p);
      }

      if (count >= 2 || !this.plugin.settings.fingerDraws) {
        this.cancelActive();
        this.gest = this.gestureState();
        return;
      }
    }

    if (this.active) return;

    if (e.pointerType === "mouse" && e.button !== 0) {
      this.active = { id: e.pointerId, kind: "pan", last: p };
      return;
    }

    let tool = this.tool;
    const penOverride = isPen ? this.resolvePenAction(e) : null;
    if (isPen) this.updateDebugHud(e, penOverride);

    if (penOverride === "pan") {
      this.active = { id: e.pointerId, kind: "pan", pen: true, last: p };
      return;
    }
    if (penOverride === "eraser") {
      tool = "eraser";
    }

    if (tool === "move" || tool === "lasso") {
      // Doppelklick auf eine PDF-Anhang-Karte im Move/Lasso-Modus öffnet sie ebenfalls direkt
      const now = performance.now();
      const hitLnk = this.hitLink(d);
      if (hitLnk && now - this.lastTapTime < 350 && this.lastTapPos && Math.hypot(p.x - this.lastTapPos.x, p.y - this.lastTapPos.y) < 20) {
        this.openPdfLink(hitLnk);
        this.lastTapTime = 0;
        return;
      }
      this.lastTapTime = now;
      this.lastTapPos = p;

      const h = this.sel ? this.hitHandle(p) : null;
      if (h) {
        const ox = this.sel.entry ? this.sel.entry.x : this.sel.link ? this.sel.link.x : h.ox;
        const oy = this.sel.entry ? this.sel.entry.y : this.sel.link ? this.sel.link.y : h.oy;
        this.active = {
          id: e.pointerId, kind: "scale", pen: isPen, sel: this.sel,
          ox, oy, hx: h.hx, hy: h.hy, k: 1,
        };
        this.scaling = true;
        return;
      }
      if (tool === "move") {
        if (hitLnk) {
          this.sel = { entry: null, link: hitLnk, strokes: [] };
          this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: null, link: hitLnk, strokes: [], dx: 0, dy: 0 };
        } else {
          const hit = this.hitPdf(d);
          if (hit) {
            this.sel = { entry: hit, link: null, strokes: this.strokesInEntry(hit) };
            this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: hit, link: null, strokes: this.sel.strokes, dx: 0, dy: 0 };
          } else {
            const hitS = this.hitSingleStroke(d);
            if (hitS) {
              this.sel = { entry: null, link: null, strokes: [hitS] };
              this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: null, link: null, strokes: [hitS], dx: 0, dy: 0 };
            } else {
              this.sel = null;
              this.active = { id: e.pointerId, kind: "pan", pen: isPen, last: p };
            }
          }
        }
      } else {
        const b = this.selBounds();
        if (b && d.x >= b.x0 && d.x <= b.x1 && d.y >= b.y0 && d.y <= b.y1) {
          this.active = {
            id: e.pointerId, kind: "drag", pen: isPen, last: d,
            entry: this.sel.entry, link: this.sel.link, strokes: this.sel.strokes, dx: 0, dy: 0,
          };
        } else {
          this.sel = null;
          this.lasso = { pts: [[d.x, d.y]], startScreen: p };
          this.active = { id: e.pointerId, kind: "lasso", pen: isPen, last: p };
        }
      }
      this.refreshToolbar();
      this.requestDraw();
      return;
    }

    if (tool === "eraser") {
      this.active = { id: e.pointerId, kind: "erase", pen: isPen, removed: [], lastDoc: d };
      this.eraseAtSegment(d, d, p);
      return;
    }

    const pr = this.pressure(e);
    this.cur = {
      tool,
      color: tool === "pen" ? this.penColor : this.hlColor,
      width: this.width,
      points: [[d.x, d.y, pr]],
    };
    this.predicted = [];
    this.sm = { x: d.x, y: d.y, p: pr };
    this.rawLast = { x: d.x, y: d.y, p: pr };
    this.snapped = null;
    this.holdAnchor = p;
    this.active = { id: e.pointerId, kind: "draw", pen: isPen, t0: performance.now(), startScreen: p };
    this.armHold();
    this.requestDraw();
  }

  onMove(e) {
    const isPen = e.pointerType === "pen" || this.androidTouchEraser;
    if (isPen) this.lastPen = performance.now();
    const p = this.local(e);
    const d = this.toDoc(p);

    if (isPen) {
      const hasBarrelBit = Boolean(
        (e.buttons & 2) || (e.buttons & 4) || (e.buttons & 32) ||
        e.button === 2 || e.button === 5 || this.androidTouchEraser || this.keyBarrelHeld
      );
      if (hasBarrelBit) {
        this.lastBarrelTime = performance.now();
        this.hoverZeroFrames = 0;
      } else if (e.pressure === 0 && e.buttons === 0) {
        this.hoverZeroFrames++;
        if (this.hoverZeroFrames > 5) this.lastBarrelTime = 0;
      }

      const penOverride = this.resolvePenAction(e);
      this.updateDebugHud(e, penOverride);

      if (!this.active) {
        if (penOverride === "eraser" || this.tool === "eraser") {
          this.eraserPos = p;
          this.requestDraw();
        } else if (this.eraserPos) {
          this.eraserPos = null;
          this.requestDraw();
        }
        if (e.pressure > 0 && penOverride === "eraser") {
          this.active = { id: e.pointerId, kind: "erase", pen: true, removed: [], lastDoc: d };
          this.eraseAtSegment(d, d, p);
          return;
        }
        if (e.pressure > 0 && penOverride === "pan") {
          this.active = { id: e.pointerId, kind: "pan", pen: true, last: p };
          return;
        }
      }

      // Live-Umschaltung während der Stift zieht
      if (this.active && this.active.id === e.pointerId && this.active.kind === "draw" && penOverride) {
        this.switchActiveDrawToBarrel(p);
        return;
      }
    }

    if (e.pointerType === "touch" && !this.androidTouchEraser && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p);
      if (this.multiTap && !this.multiTap.moved) {
        const s0 = this.multiTap.startPts.get(e.pointerId);
        if (s0 && Math.hypot(p.x - s0.x, p.y - s0.y) > 14) this.multiTap.moved = true;
      }
      if (this.touches.size >= 2 || !this.plugin.settings.fingerDraws) {
        e.preventDefault();
        if (!this.multiTap || this.multiTap.moved || performance.now() - this.multiTap.t0 > 180) {
          this.applyGesture();
        }
        return;
      }
    }

    const a = this.active;
    if (!a || a.id !== e.pointerId) return;
    e.preventDefault();
    const v = this.doc.view;

    if (a.kind === "draw") {
      if (this.snapped) {
        if (this.snapped.kind === "line") {
          const s0 = this.snapped.start;
          let ex = d.x, ey = d.y;
          const ang = Math.atan2(ey - s0[1], ex - s0[0]);
          const step = Math.PI / 12;
          const rr = Math.round(ang / step) * step;
          if (Math.abs(ang - rr) < 0.06) {
            const len = Math.hypot(ex - s0[0], ey - s0[1]);
            ex = s0[0] + Math.cos(rr) * len;
            ey = s0[1] + Math.sin(rr) * len;
          }
          this.cur.points = [[s0[0], s0[1], s0[2]], [ex, ey, s0[2]]];
          this.cur._b = null;
          this.requestDraw();
        }
        return;
      }
      const al = 1 - clamp(this.plugin.settings.smoothing, 0, 1) * 0.88;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const list = evs.length ? evs : [e];
      const pts = this.cur.points;
      const sm = this.sm;
      for (const ev of list) {
        const cd = this.toDoc(this.local(ev));
        const pr = this.pressure(ev);
        this.rawLast = { x: cd.x, y: cd.y, p: pr };
        sm.x += (cd.x - sm.x) * al;
        sm.y += (cd.y - sm.y) * al;
        sm.p += (pr - sm.p) * Math.min(1, al * 1.5);
        const last = pts[pts.length - 1];
        if (Math.hypot(sm.x - last[0], sm.y - last[1]) * v.z < 0.7) continue;
        pts.push([sm.x, sm.y, sm.p]);
      }

      this.predicted = [];
      if (isPen && e.getPredictedEvents) {
        const preds = e.getPredictedEvents();
        let px = sm.x, py = sm.y;
        for (let i = 0; i < Math.min(2, preds.length); i++) {
          const pd = this.toDoc(this.local(preds[i]));
          px += (pd.x - px) * 0.6;
          py += (pd.y - py) * 0.6;
          this.predicted.push([px, py, sm.p]);
        }
      }

      if (Math.hypot(p.x - this.holdAnchor.x, p.y - this.holdAnchor.y) > 5) {
        this.holdAnchor = p;
        this.armHold();
      }
      this.requestDraw();
    } else if (a.kind === "erase") {
      if (isPen && e.pressure === 0 && e.buttons === 0 && !this.androidTouchEraser) {
        this.onUp(e, false);
        return;
      }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const list = evs.length ? evs : [e];
      for (const ev of list) {
        const lp = this.local(ev);
        const ld = this.toDoc(lp);
        this.eraseAtSegment(a.lastDoc || ld, ld, lp);
        a.lastDoc = ld;
      }
    } else if (a.kind === "pan") {
      v.x += p.x - a.last.x;
      v.y += p.y - a.last.y;
      a.last = p;
      this.invalidateStatic();
    } else if (a.kind === "drag") {
      const dx = d.x - a.last.x, dy = d.y - a.last.y;
      if (a.entry) { a.entry.x += dx; a.entry.y += dy; }
      if (a.link) { a.link.x += dx; a.link.y += dy; }
      shiftStrokes(a.strokes, dx, dy);
      a.dx += dx; a.dy += dy;
      a.last = d;
      this.invalidateStatic();
    } else if (a.kind === "lasso") {
      if (Math.hypot(p.x - a.last.x, p.y - a.last.y) >= 2) {
        this.lasso.pts.push([d.x, d.y]);
        a.last = p;
        this.requestDraw();
      }
    } else if (a.kind === "scale") {
      const wx = a.hx - a.ox, wy = a.hy - a.oy;
      const rx = Math.abs(wx) > 1e-3 ? (d.x - a.ox) / wx : 1;
      const ry = Math.abs(wy) > 1e-3 ? (d.y - a.oy) / wy : 1;
      let target = clamp((rx + ry) / 2, 0.1, 10);
      const e0 = a.sel.entry;
      const l0 = a.sel.link;
      if (e0) {
        const baseW = e0.w / a.k;
        target = clamp(target, 100 / baseW, 6000 / baseW);
      }
      if (l0) {
        const baseW = l0.w / a.k;
        target = clamp(target, 160 / baseW, 1200 / baseW);
      }
      const inc = target / a.k;
      scaleStrokes(a.sel.strokes, a.ox, a.oy, inc);
      if (e0) e0.w *= inc;
      if (l0) l0.w *= inc;
      a.k = target;
      this.invalidateStatic();
    }
  }

  finishScale(a) {
    this.scaling = false;
    if (Math.abs(a.k - 1) > 1e-3) {
      this.pushUndo({ t: "scale", entry: a.sel.entry, link: a.sel.link, strokes: a.sel.strokes, ox: a.ox, oy: a.oy, k: a.k });
      this.changed();
    }
  }

  onUp(e, cancelled) {
    if (e.pointerType === "pen") this.lastPen = performance.now();
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      this.gest = this.gestureState();

      if (this.touches.size === 0 && this.multiTap && !cancelled && this.plugin.settings.twoFingerUndo) {
        const dt = performance.now() - this.multiTap.t0;
        if (!this.multiTap.moved && dt < 260) {
          if (this.multiTap.maxTouches === 2) {
            this.undo();
            this.multiTap = null;
            return;
          } else if (this.multiTap.maxTouches === 3) {
            this.redo();
            this.multiTap = null;
            return;
          }
        }
        this.multiTap = null;
      }
    }

    const a = this.active;
    if (!a || a.id !== e.pointerId) return;
    clearTimeout(this.holdTimer);
    this.active = null;
    this.eraserPos = null;
    this.predicted = [];

    if (a.kind === "draw") {
      if (!this.snapped) this.catchUp();
      const s = this.cur;
      this.cur = null;
      this.snapped = null;
      if (s && s.points.length && !(cancelled && e.pointerType === "touch")) {
        this.doc.strokes.push(s);
        this.pushUndo({ t: "add", s });
        this.appendStrokeToStatic(s);
        this.requestSave();
        this.refreshToolbar();
      }
    } else if (a.kind === "erase") {
      if (a.removed.length) {
        this.pushUndo({ t: "del", items: a.removed });
        this.changed();
      }
    } else if (a.kind === "drag") {
      if (a.dx || a.dy) {
        this.pushUndo({ t: "move", entry: a.entry, link: a.link, strokes: a.strokes, dx: a.dx, dy: a.dy });
        this.changed();
      }
    } else if (a.kind === "scale") {
      this.finishScale(a);
    } else if (a.kind === "lasso") {
      this.finishLasso(this.local(e));
    }
    this.requestDraw();
  }

  finishLasso(endScreen) {
    const poly = this.lasso ? this.lasso.pts : [];
    const startScreen = this.lasso ? this.lasso.startScreen : endScreen;
    this.lasso = null;
    this.sel = null;

    if (poly.length < 5 && Math.hypot(endScreen.x - startScreen.x, endScreen.y - startScreen.y) < 10) {
      const d = this.toDoc(endScreen);
      const hitL = this.hitLink(d);
      if (hitL) {
        this.sel = { entry: null, link: hitL, strokes: [] };
      } else {
        const hitS = this.hitSingleStroke(d);
        if (hitS) {
          this.sel = { entry: null, link: null, strokes: [hitS] };
        } else {
          const hitP = this.hitPdf(d);
          if (hitP) this.sel = { entry: hitP, link: null, strokes: this.strokesInEntry(hitP) };
        }
      }
      this.refreshToolbar();
      return;
    }

    if (poly.length >= 3) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of poly) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
      const picked = [];
      for (const s of this.doc.strokes) {
        const b = strokeBounds(s);
        if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
        let inside = 0;
        for (const q of s.points) if (pointInPoly(q[0], q[1], poly)) inside++;
        if (inside / s.points.length >= 0.5) picked.push(s);
      }
      if (picked.length) this.sel = { entry: null, link: null, strokes: picked };
    }
    this.refreshToolbar();
  }

  eraseAtSegment(d0, d1, p) {
    const z = this.doc.view.z;
    const r = ERASER_R / z;
    const minX = Math.min(d0.x, d1.x) - r, maxX = Math.max(d0.x, d1.x) + r;
    const minY = Math.min(d0.y, d1.y) - r, maxY = Math.max(d0.y, d1.y) + r;
    const strokes = this.doc.strokes;
    let hitAny = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      const b = strokeBounds(s);
      if (b.x1 < minX || b.x0 > maxX || b.y1 < minY || b.y0 > maxY) continue;
      const hitRadius = r + (s.width * widthMult(s)) / 2;
      if (strokeHitSegment(s, d0.x, d0.y, d1.x, d1.y, hitRadius)) {
        strokes.splice(i, 1);
        this.active.removed.push({ s, i });
        hitAny = true;
      }
    }
    this.eraserPos = p;
    if (hitAny) this.invalidateStatic();
    else this.requestDraw();
  }

  onWheel(e) {
    e.preventDefault();
    const v = this.doc.view;
    if (e.ctrlKey || e.metaKey) {
      const p = this.local(e);
      const z = clamp(v.z * Math.exp(-e.deltaY * 0.01), 0.1, 8);
      const k = z / v.z;
      v.x = p.x - (p.x - v.x) * k;
      v.y = p.y - (p.y - v.y) * k;
      v.z = z;
    } else {
      v.x -= e.shiftKey ? e.deltaY : e.deltaX;
      v.y -= e.shiftKey ? 0 : e.deltaY;
    }
    this.invalidateStatic();
  }

  /* ----- Export ----- */
  async exportPng() {
    const b = this.contentBounds();
    if (!b || !this.file) { new Notice("Nichts zu exportieren."); return; }
    const pad = 40;
    const x0 = b.x0 - pad, y0 = b.y0 - pad;
    const w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
    const s = clamp(Math.min(2, 6000 / Math.max(w, h)), 0.15, 2);
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(w * s);
    cv.height = Math.ceil(h * s);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
    new Notice("Exportiere …");

    for (const e of this.doc.pdfs) {
      const d = this.docs.get(e.path);
      const lay = this.entryLayout(e);
      if (!d || !lay) continue;
      for (const p of lay.pages) {
        const pg = await d.pdf.getPage(p.idx + 1);
        const vp0 = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: (e.w * s) / vp0.width });
        const tmp = document.createElement("canvas");
        tmp.width = Math.max(1, Math.ceil(vp.width));
        tmp.height = Math.max(1, Math.ceil(vp.height));
        await pg.render({ canvasContext: tmp.getContext("2d"), canvas: tmp, viewport: vp }).promise;
        ctx.drawImage(tmp, e.x, e.y + p.y, e.w, p.h);
      }
    }
    for (const lnk of (this.doc.links || [])) {
      drawPdfLinkCard(ctx, lnk, s);
    }
    for (const st of this.doc.strokes) paintStroke(ctx, st);

    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) { new Notice("Export fehlgeschlagen."); return; }
    const buf = await blob.arrayBuffer();
    const dir = this.file.parent && this.file.parent.path !== "/" ? this.file.parent.path + "/" : "";
    const name = this.file.basename + ".png";
    const path = dir + name;
    const ex = this.app.vault.getAbstractFileByPath(path);
    if (ex instanceof TFile) await this.app.vault.modifyBinary(ex, buf);
    else await this.app.vault.createBinary(path, buf);
    const link = "![[" + name + "]]";
    try { await navigator.clipboard.writeText(link); } catch (err) { /* */ }
    new Notice("Exportiert: " + name + "\nEinbett-Link in der Zwischenablage:\n" + link);
  }
}

/* ---------- Einstellungen ---------- */
class InkSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    const st = this.plugin.settings;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Glättung der Handschrift")
      .setDesc("0 = rohe Eingabe, höher = ruhigere, glattere Linien.")
      .addSlider((s) => s.setLimits(0, 1, 0.05).setValue(st.smoothing).setDynamicTooltip().onChange(async (v) => {
        st.smoothing = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Formerkennung beim Halten")
      .setDesc("Am Ende eines Strichs den Stift ruhig halten: Linie, Kreis/Ellipse, Dreieck, Rechteck und Vielecke werden begradigt.")
      .addToggle((t) => t.setValue(st.shapeRecognition).onChange(async (v) => {
        st.shapeRecognition = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Haltezeit für Formerkennung")
      .setDesc("Wie lange der Stift stillhalten muss (in Millisekunden).")
      .addSlider((s) => s.setLimits(300, 1500, 50).setValue(st.shapeHoldMs).setDynamicTooltip().onChange(async (v) => {
        st.shapeHoldMs = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("2-Finger-Tippen für Rückgängig")
      .setDesc("Kurzes Tippen mit 2 Fingern = Rückgängig (Undo), mit 3 Fingern = Wiederholen (Redo).")
      .addToggle((t) => t.setValue(st.twoFingerUndo).onChange(async (v) => {
        st.twoFingerUndo = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Mit Finger zeichnen")
      .setDesc("Aus: Finger verschiebt/zoomt die Leinwand, nur der S Pen schreibt (empfohlen auf dem Tablet).")
      .addToggle((t) => t.setValue(st.fingerDraws).onChange(async (v) => {
        st.fingerDraws = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("S-Pen-Taste (gedrückt halten)")
      .setDesc("WICHTIG für Samsung-Tablets: Deaktiviere in den Android-Einstellungen unter 'Erweiterte Funktionen -> S Pen -> S-Pen-Befehle' die Option 'S-Pen-Befehle mit Stifttaste öffnen', damit Android die Taste nicht blockiert.")
      .addDropdown((d) => {
        d.addOption("eraser", "Radierer");
        d.addOption("pan", "Leinwand verschieben");
        d.addOption("off", "Keine Aktion");
        d.setValue(st.penButton).onChange(async (v) => {
          st.penButton = v; await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("Radierende des Stifts")
      .setDesc("Falls dein Stift ein Radierende hat, radiert dieses automatisch.")
      .addToggle((t) => t.setValue(st.penEraserEnd).onChange(async (v) => {
        st.penEraserEnd = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Live-Tasten-Diagnose (unten links)")
      .setDesc("Zeigt unten links auf der Leinwand live alle Signale des S Pen an (Pointer, Touch-Eraser, Buttons).")
      .addToggle((t) => t.setValue(st.penButtonDebug).onChange(async (v) => {
        st.penButtonDebug = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName("Eigene Farben zurücksetzen")
      .setDesc("Löscht alle benutzerdefinierten Stift- und Textmarker-Farben aus der Werkzeugleiste.")
      .addButton((b) => b.setButtonText("Zurücksetzen").onClick(async () => {
        st.customPenColors = [];
        st.customHlColors = [];
        await this.plugin.saveSettings();
        new Notice("Eigene Farben zurückgesetzt.");
      }));
    new Setting(containerEl)
      .setName("Standard-Hintergrund")
      .setDesc("Für neue Handschrift-Notizen.")
      .addDropdown((d) => {
        for (const b of BGS) d.addOption(b, BG_LABELS[b]);
        d.setValue(st.background).onChange(async (v) => {
          st.background = v; await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("PDF-Qualität")
      .setDesc("Höher = schärfer beim Hineinzoomen, aber mehr Speicher.")
      .addSlider((s) => s.setLimits(1, 3, 0.25).setValue(st.pdfQuality).setDynamicTooltip().onChange(async (v) => {
        st.pdfQuality = v; await this.plugin.saveSettings();
      }));
  }
}

/* ---------- Plugin ---------- */
class InkPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, (leaf) => new InkView(leaf, this));
    this.registerExtensions([EXT], VIEW_TYPE);

    this.addRibbonIcon("pencil", "Neue Handschrift-Notiz", () => this.createNote());

    this.addCommand({ id: "new-note", name: "Neue Handschrift-Notiz erstellen", callback: () => this.createNote() });
    this.addCommand({
      id: "new-note-from-pdf",
      name: "Neue Handschrift-Notiz aus PDF erstellen",
      callback: () => this.pickPdf((f) => this.createNote(f)),
    });
    this.addCommand({
      id: "insert-pdf",
      name: "PDF als Ausdruck in Handschrift-Notiz einfügen",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) this.pickPdf((f) => v.addPdf(f));
        return true;
      },
    });
    this.addCommand({
      id: "insert-pdf-link",
      name: "PDF als Anhang-Karte (Link) in Handschrift-Notiz verknüpfen",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) this.pickPdf((f) => v.addPdfLink(f));
        return true;
      },
    });
    this.addCommand({
      id: "export-png",
      name: "Handschrift-Notiz als PNG exportieren",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) v.exportPng();
        return true;
      },
    });
    this.addCommand({
      id: "ink-undo",
      name: "Handschrift: Rückgängig",
      checkCallback: (checking) => { const v = this.getActiveInk(); if (!v) return false; if (!checking) v.undo(); return true; },
    });
    this.addCommand({
      id: "ink-redo",
      name: "Handschrift: Wiederholen",
      checkCallback: (checking) => { const v = this.getActiveInk(); if (!v) return false; if (!checking) v.redo(); return true; },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
        menu.addItem((i) => i.setTitle("Mit Handschrift beschriften (Ausdruck)").setIcon("pencil").onClick(() => this.createNote(file, false)));
        menu.addItem((i) => i.setTitle("In neuer Handschrift-Notiz als Anhang verknüpfen").setIcon("paperclip").onClick(() => this.createNote(file, true)));
      }
    }));

    this.addSettingTab(new InkSettingTab(this.app, this));
  }

  getActiveInk() {
    const v = this.app.workspace.getActiveViewOfType(TextFileView);
    return v instanceof InkView ? v : null;
  }

  pickPdf(cb) {
    const pdfs = this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf");
    if (!pdfs.length) { new Notice("Keine PDF-Dateien im Vault gefunden."); return; }
    new PdfSuggestModal(this.app, cb).open();
  }

  async createNote(pdfFile, asLink = false) {
    const active = this.app.workspace.getActiveFile();
    const folder = this.app.fileManager.getNewFileParent(active ? active.path : "");
    const dir = folder && folder.path && folder.path !== "/" ? folder.path + "/" : "";
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
    const base = pdfFile ? `${pdfFile.basename} (Handschrift)` : `Handschrift ${stamp}`;
    let path = `${dir}${base}.${EXT}`;
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = `${dir}${base} ${i}.${EXT}`;
    const file = await this.app.vault.create(path, JSON.stringify(newDoc(this.settings.background)));
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    if (pdfFile && leaf.view instanceof InkView) {
      if (asLink) leaf.view.addPdfLink(pdfFile);
      else await leaf.view.addPdf(pdfFile);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.customPenColors)) this.settings.customPenColors = [];
    if (!Array.isArray(this.settings.customHlColors)) this.settings.customHlColors = [];
  }
  async saveSettings() { await this.saveData(this.settings); }
}

InkPlugin._test = { recognizeShape, rdp, scaleStrokes, pointInPoly, shiftStrokes };
module.exports = InkPlugin;