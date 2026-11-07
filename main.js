"use strict";
/*
 * Ink Canvas v2.2.0 – Handschrift-Notizen mit S Pen für Obsidian
 * Neu in v2.2.0:
 * 1. Textblock- & Tabellen-Funktion (Tippen auf der Leinwand):
 *    - Neues Werkzeug „Textblock“ (T-Icon in der Toolbar) zum Einfügen und Bearbeiten von Textfeldern
 *      direkt auf der unendlichen Leinwand (per Tastatur auf Tablet & PC).
 *    - Integrierte Tabellen-Funktion in jedem Textblock (Button „⊞ Tabelle“): Zeilen & Spalten direkt
 *      im Textfeld einfügen und per Tastatur (inkl. Tab-Sprung von Zelle zu Zelle) ausfüllen.
 *    - Anpassbare Schriftgröße (A- / A+), Fettdruck (B), Textfarbe (über die Farbpalette),
 *      Hintergrund-Stil (Karte / Notizzettel / Transparent), freie Skalierung, Verschieben, Duplizieren,
 *      PNG-Export sowie vollständiges Undo/Redo.
 * 2. Ultra-flüssiger Radierer & S-Pen-Seitentaste (Performance- & Verbindungs-Upgrade):
 *    - Kontinuierliche Segment-zu-Segment-Kollisionserkennung in Quadratdistanz (ohne teure Wurzel-Schleifen):
 *      selbst schnelle Wischbewegungen erfassen jeden Strich lückenlos ohne Ruckler.
 *    - Entkopplung des Statik-Canvas-Neuzeichnens von DOM-Transformationen (`invalidateStrokes`)
 *      und Vermeidung dreifacher Event-Verarbeitung (`pointermove` vs. `pointerrawupdate` vs. `touchmove`).
 *    - Nahtlose S-Pen-Verbindung beim schnellen Hin-und-Her-Radieren (Scrubbing-Haltefenster beim kurzen
 *      Anheben der Stiftspitze, sofortige 1-Frame-Hover-Erkennung und rückwirkendes Pfad-Radieren).
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
const VIEWER_W = 520;
const VIEWER_H = 680;
const TEXT_W = 280;
const TEXT_H = 84;
const HL_MULT = 4;
const ERASER_R = 20;
const HANDLE_R = 24;
const MAX_CACHED_PAGES = 14;
const MAX_CUSTOM_COLORS = 5;
const DEFAULT_PEN_COLORS = ["#111111", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#7048e8"];
const DEFAULT_HL_COLORS = ["#ffe14d", "#ff8fb1", "#7de08a", "#6cc8ff"];
const BGS = ["grid", "lines", "dots", "none"];
const BG_LABELS = { grid: "Karo", lines: "Linien", dots: "Punkte", none: "Blanko" };
const TEXT_BG_STYLES = ["card", "note", "transparent"];
const TEXT_BG_LABELS = { card: "Karte", note: "Notiz", transparent: "Transparent" };

const DEFAULT_SETTINGS = {
  fingerDraws: false,
  penButton: "eraser",      // "eraser" | "pan" | "off"
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
const cloneTable = (tbl) => (Array.isArray(tbl) ? tbl.map((row) => (Array.isArray(row) ? row.map((c) => String(c || "")) : [])) : null);
const newDoc = (bg) => ({
  v: 1,
  bg: bg || "grid",
  view: { x: 40, y: 40, z: 1 },
  strokes: [],
  pdfs: [],
  links: [],
  viewers: [],
  texts: [],
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

function distSegSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const rx = px - (ax + t * dx), ry = py - (ay + t * dy);
  return rx * rx + ry * ry;
}

function distSeg(px, py, ax, ay, bx, by) {
  return Math.sqrt(distSegSq(px, py, ax, ay, bx, by));
}

function orient2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = orient2d(ax, ay, bx, by, cx, cy);
  const o2 = orient2d(ax, ay, bx, by, dx, dy);
  const o3 = orient2d(cx, cy, dx, dy, ax, ay);
  const o4 = orient2d(cx, cy, dx, dy, bx, by);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
         ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

function segSegDistSq(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distSegSq(ax, ay, cx, cy, dx, dy),
    distSegSq(bx, by, cx, cy, dx, dy),
    distSegSq(cx, cy, ax, ay, bx, by),
    distSegSq(dx, dy, ax, ay, bx, by)
  );
}

function strokeHit(s, x, y, r) {
  const pts = s.points;
  const r2Val = r * r;
  if (pts.length === 1) {
    const dx = x - pts[0][0], dy = y - pts[0][1];
    return dx * dx + dy * dy <= r2Val;
  }
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (x + r < Math.min(p0[0], p1[0]) || x - r > Math.max(p0[0], p1[0]) ||
        y + r < Math.min(p0[1], p1[1]) || y - r > Math.max(p0[1], p1[1])) continue;
    if (distSegSq(x, y, p0[0], p0[1], p1[0], p1[1]) <= r2Val) return true;
  }
  return false;
}

/**
 * v2.2.0: Exakte, kontinuierliche Segment-zu-Segment-Kollisionserkennung ohne Math.sqrt-Schleifen.
 * Erfasst selbst sehr schnelle S-Pen-Radierbewegungen lückenlos und in einem Bruchteil der CPU-Zeit.
 */
function strokeHitSegment(s, x0, y0, x1, y1, r) {
  if (x0 === x1 && y0 === y1) return strokeHit(s, x0, y0, r);
  const pts = s.points;
  const r2Val = r * r;
  if (pts.length === 1) {
    return distSegSq(pts[0][0], pts[0][1], x0, y0, x1, y1) <= r2Val;
  }
  const ex0 = Math.min(x0, x1) - r, ex1 = Math.max(x0, x1) + r;
  const ey0 = Math.min(y0, y1) - r, ey1 = Math.max(y0, y1) + r;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (Math.max(p0[0], p1[0]) < ex0 || Math.min(p0[0], p1[0]) > ex1 ||
        Math.max(p0[1], p1[1]) < ey0 || Math.min(p0[1], p1[1]) > ey1) continue;
    if (segSegDistSq(x0, y0, x1, y1, p0[0], p0[1], p1[0], p1[1]) <= r2Val) return true;
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

/* ----- PDF-Anhang-Karte zeichnen (inkl. "⇄" Datei-Ändern-Button & "Öffnen ↗") ----- */
function drawPdfLinkCard(ctx, lnk, z) {
  const x = lnk.x, y = lnk.y, w = lnk.w || CARD_W;
  const s = w / CARD_W;
  const h = CARD_H * s;

  ctx.save();
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

  const bx = x + 12 * s, by = y + 12 * s, bw = 52 * s, bh = 52 * s;
  roundRectPath(ctx, bx, by, bw, bh, 10 * s);
  ctx.fillStyle = "#e03131";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(15 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("PDF", bx + bw / 2, by + bh / 2);

  const name = (lnk.path.split("/").pop() || lnk.path);
  const tx = bx + bw + 12 * s;
  const maxTextW = w - (tx - x) - 108 * s;

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

  // "⇄" Button zum direkten Ändern der PDF-Datei auf der Karte
  const chgW = 30 * s, chgH = 30 * s;
  const btnW = 58 * s, btnH = 30 * s;
  const btnX = x + w - btnW - 10 * s, btnY = y + (h - btnH) / 2;
  const chgX = btnX - chgW - 6 * s, chgY = btnY;

  roundRectPath(ctx, chgX, chgY, chgW, chgH, 7 * s);
  ctx.fillStyle = "#e2e8f0";
  ctx.fill();
  ctx.fillStyle = "#1e293b";
  ctx.font = `700 ${Math.round(13 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("⇄", chgX + chgW / 2, chgY + chgH / 2);

  // "Öffnen ↗" Button
  roundRectPath(ctx, btnX, btnY, btnW, btnH, 7 * s);
  ctx.fillStyle = "#e2e8f0";
  ctx.fill();
  ctx.fillStyle = "#1e293b";
  ctx.font = `600 ${Math.round(11.5 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("Öffnen ↗", btnX + btnW / 2, btnY + btnH / 2);

  ctx.restore();
}

/* ----- Textblock für PNG-Export auf Canvas zeichnen (inkl. Tabelle) ----- */
function drawTextBlockOnCanvas(ctx, tb) {
  const x = tb.x, y = tb.y;
  const w = tb.w || TEXT_W;
  const h = tb.h || TEXT_H;
  const fs = tb.fontSize || 18;
  const lineH = fs * 1.4;
  const bgStyle = tb.bgStyle || "card";

  ctx.save();
  if (bgStyle !== "transparent") {
    roundRectPath(ctx, x, y, w, h, 10);
    ctx.fillStyle = bgStyle === "note" ? "#fef9c3" : "#ffffff";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = bgStyle === "note" ? "#eab308" : "#cbd5e1";
    ctx.stroke();
  }

  let curY = y + 12 + fs;
  const padX = 10;
  const maxW = Math.max(40, w - padX * 2);

  if (tb.text && tb.text.trim().length > 0) {
    ctx.fillStyle = tb.color || "#111111";
    ctx.font = `${tb.bold ? "700" : "400"} ${fs}px sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const paragraphs = String(tb.text).split("\n");
    for (const para of paragraphs) {
      const words = para.split(" ");
      let line = "";
      for (let i = 0; i < words.length; i++) {
        const testLine = line ? line + " " + words[i] : words[i];
        if (ctx.measureText(testLine).width > maxW && line) {
          ctx.fillText(line, x + padX, curY);
          line = words[i];
          curY += lineH;
        } else {
          line = testLine;
        }
      }
      ctx.fillText(line, x + padX, curY);
      curY += lineH;
    }
  }

  if (Array.isArray(tb.table) && tb.table.length > 0) {
    const rows = tb.table.length;
    const cols = Math.max(1, tb.table[0] ? tb.table[0].length : 1);
    const cellW = maxW / cols;
    const cellFs = Math.max(11, Math.round(fs * 0.85));
    const rowH = Math.max(28, cellFs * 1.8);
    let ty = (tb.text && tb.text.trim().length > 0) ? curY - fs + 8 : y + 12;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = x + padX + c * cellW;
        const cy = ty + r * rowH;
        ctx.fillStyle = r === 0 ? "#e2e8f0" : "#ffffff";
        ctx.fillRect(cx, cy, cellW, rowH);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1;
        ctx.strokeRect(cx, cy, cellW, rowH);

        const cellText = (tb.table[r] && tb.table[r][c]) ? String(tb.table[r][c]) : "";
        if (cellText) {
          ctx.fillStyle = tb.color || "#111111";
          ctx.font = `${r === 0 || tb.bold ? "600" : "400"} ${cellFs}px sans-serif`;
          ctx.textBaseline = "middle";
          ctx.fillText(cellText, cx + 6, cy + rowH / 2, Math.max(10, cellW - 12));
        }
      }
    }
  }

  ctx.restore();
}

/* ---------- Reines Vault-PDF-Auswahlfenster ---------- */
class PdfSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose, placeholder) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder || "PDF aus dem Vault suchen und auswählen …");
  }
  getItems() {
    return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf");
  }
  getItemText(item) {
    return item.path;
  }
  onChooseItem(item) {
    this.onChoose(item);
  }
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
    this.sel = null;
    this.lasso = null;
    this.scaling = false;
    this.snapped = null;
    this.sm = null;
    this.rawLast = null;
    this.holdTimer = null;
    this.holdAnchor = null;
    this.eraserPos = null;

    // S-Pen Seitentasten-Zustandsautomat (v2.2.0: Ultra-flüssiger Radierer ohne Aussetzer)
    this.lastPen = 0;
    this.lastPenDownTime = 0;
    this.lastPointerMoveTime = 0;
    this.pointerCancelledBarrel = false;
    this.barrelHeld = false;
    this.lastBarrelSignalTime = 0;
    this.lastBarrelLiftTime = 0;
    this.barrelReleaseTimer = null;
    this.hoverClearFrames = 0;
    this.hoverBtn1Frames = 0;
    this.contactHasBarrelBit = false;
    this.contextMenuBarrel = false;
    this.androidTouchEraser = false;
    this.touchContactActive = false;
    this.keyBarrelHeld = false;
    this.lastTapTime = 0;
    this.lastTapPos = null;

    // Eingebettete PDF-Viewer & Textblöcke DOM-Instanzen
    this.viewerDom = new Map();
    this.textDom = new Map();

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
    clearTimeout(this.barrelReleaseTimer);
    if (this.ro) this.ro.disconnect();
    if (this._keyDownHandler) window.removeEventListener("keydown", this._keyDownHandler, true);
    if (this._keyUpHandler) window.removeEventListener("keyup", this._keyUpHandler, true);
    if (this._outsideClickHandler) window.removeEventListener("pointerdown", this._outsideClickHandler, true);
    this.destroyTextDoms();
    this.destroyViewerDoms();
    this.destroyPdfs();
  }

  /* ----- Datei laden/speichern ----- */
  getViewData() { return this.serialize(); }
  setViewData(data) { this.loadData(data); }
  clear() {
    this.destroyTextDoms();
    this.destroyViewerDoms();
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
    if (d.viewers && d.viewers.length) {
      out.viewers = d.viewers.map((vw) => ({
        id: vw.id,
        path: vw.path,
        x: r1(vw.x),
        y: r1(vw.y),
        w: r1(vw.w || VIEWER_W),
        h: r1(vw.h || VIEWER_H),
        page: vw.page || 0,
      }));
    }
    if (d.texts && d.texts.length) {
      out.texts = d.texts.map((tb) => {
        const o = {
          id: tb.id,
          x: r1(tb.x),
          y: r1(tb.y),
          w: r1(tb.w || TEXT_W),
          h: r1(tb.h || TEXT_H),
          text: tb.text || "",
          color: tb.color || "#111111",
          fontSize: r1(tb.fontSize || 18),
          bgStyle: tb.bgStyle || "card",
        };
        if (tb.bold) o.bold = true;
        if (Array.isArray(tb.table) && tb.table.length) o.table = cloneTable(tb.table);
        return o;
      });
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
      d.viewers = (j.viewers || []).map((vw) => ({
        id: vw.id || uid(),
        path: vw.path,
        x: vw.x || 0,
        y: vw.y || 0,
        w: vw.w || VIEWER_W,
        h: vw.h || VIEWER_H,
        page: Number.isInteger(vw.page) ? vw.page : 0,
      }));
      d.texts = (j.texts || []).map((tb) => ({
        id: tb.id || uid(),
        x: tb.x || 0,
        y: tb.y || 0,
        w: tb.w || TEXT_W,
        h: tb.h || TEXT_H,
        text: typeof tb.text === "string" ? tb.text : "",
        color: tb.color || "#111111",
        fontSize: tb.fontSize || 18,
        bgStyle: TEXT_BG_STYLES.includes(tb.bgStyle) ? tb.bgStyle : "card",
        bold: !!tb.bold,
        table: Array.isArray(tb.table) && tb.table.length ? cloneTable(tb.table) : null,
      }));
    }
    this.destroyTextDoms();
    this.destroyViewerDoms();
    this.destroyPdfs();
    this.doc = d;
    this.undoStack = []; this.redoStack = [];
    this.sel = null;
    this.refreshToolbar();
    for (const entry of d.pdfs) this.ensureDoc(entry.path).catch(() => {});
    for (const vw of d.viewers) {
      this.ensureDoc(vw.path).then(() => this.syncViewerDoms()).catch(() => {});
    }
    this.syncViewerDoms();
    this.syncTextDoms();
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

  destroyViewerDoms() {
    for (const item of this.viewerDom.values()) {
      try { if (item.io) item.io.disconnect(); } catch (e) { /* */ }
      try { item.el.remove(); } catch (e) { /* */ }
    }
    this.viewerDom.clear();
  }

  destroyTextDoms() {
    for (const item of this.textDom.values()) {
      try { item.el.remove(); } catch (e) { /* */ }
    }
    this.textDom.clear();
  }

  /* ----- Textblöcke & Tabellen auf der Leinwand (v2.2.0) ----- */
  addTextBlock(docX, docY, withTable = false) {
    const d = this.doc;
    const v = d.view;
    const x = docX != null ? Math.round(docX) : Math.round((this.cssW / 2 - v.x) / v.z - TEXT_W / 2);
    const y = docY != null ? Math.round(docY) : Math.round((this.cssH / 2 - v.y) / v.z - TEXT_H / 2);
    const tb = {
      id: uid(),
      x,
      y,
      w: withTable ? 340 : TEXT_W,
      h: withTable ? 130 : TEXT_H,
      text: "",
      color: this.penColor || "#111111",
      fontSize: 18,
      bgStyle: "card",
      bold: false,
      table: withTable ? [["Spalte 1", "Spalte 2"], ["", ""]] : null,
    };
    if (!d.texts) d.texts = [];
    d.texts.push(tb);
    this.pushUndo({ t: "textadd", textBlock: tb });
    this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
    this.syncTextDoms();
    this.changed();
    setTimeout(() => this.focusTextDom(tb.id, withTable), 20);
    return tb;
  }

  focusTextDom(id, focusTableFirst = false) {
    const item = this.textDom.get(id);
    if (!item) return;
    if (focusTableFirst && item.firstCellInput) {
      item.firstCellInput.focus();
      return;
    }
    if (item.inputEl) {
      item.inputEl.focus();
      const len = item.inputEl.value.length;
      try { item.inputEl.setSelectionRange(len, len); } catch (e) { /* */ }
    }
  }

  blurAllTexts() {
    for (const item of this.textDom.values()) {
      if (item.el.classList.contains("is-focused")) {
        const activeEl = document.activeElement;
        if (activeEl && item.el.contains(activeEl) && typeof activeEl.blur === "function") {
          activeEl.blur();
        }
        item.el.classList.remove("is-focused");
      }
    }
  }

  syncTextDoms() {
    if (!this.textsLayer) return;
    const texts = this.doc.texts || [];
    const activeIds = new Set(texts.map((t) => t.id));

    for (const [id, item] of this.textDom.entries()) {
      if (!activeIds.has(id)) {
        try { item.el.remove(); } catch (e) { /* */ }
        this.textDom.delete(id);
      }
    }

    for (const tb of texts) {
      let item = this.textDom.get(tb.id);
      if (!item) {
        item = this.createTextDom(tb);
        this.textDom.set(tb.id, item);
      } else {
        this.refreshTextDomContent(tb, item);
      }
    }
    this.updateTextsTransform();
  }

  createTextDom(tb) {
    const el = this.textsLayer.createDiv({ cls: "ink-text-block" });
    const header = el.createDiv({ cls: "ink-text-header" });
    header.createSpan({ cls: "ink-text-drag-label", text: "⋮⋮ Text" });

    const btnFontDec = header.createEl("button", {
      cls: "ink-text-btn",
      text: "A-",
      attr: { title: "Schrift verkleinern" },
    });
    const btnFontInc = header.createEl("button", {
      cls: "ink-text-btn",
      text: "A+",
      attr: { title: "Schrift vergrößern" },
    });
    const btnBold = header.createEl("button", {
      cls: "ink-text-btn" + (tb.bold ? " is-active" : ""),
      text: "B",
      attr: { title: "Fettdruck umschalten" },
    });
    const btnBg = header.createEl("button", {
      cls: "ink-text-btn",
      text: TEXT_BG_LABELS[tb.bgStyle || "card"],
      attr: { title: "Hintergrund wechseln (Karte / Notiz / Transparent)" },
    });
    const btnTable = header.createEl("button", {
      cls: "ink-text-btn" + (tb.table ? " is-active" : ""),
      text: "⊞ Tabelle",
      attr: { title: "Tabelle im Textblock einfügen oder ausblenden" },
    });
    const btnDel = header.createEl("button", {
      cls: "ink-text-btn is-danger",
      text: "✕",
      attr: { title: "Textblock löschen" },
    });

    const inputEl = el.createEl("textarea", {
      cls: "ink-text-input",
      attr: { placeholder: "Tippen …", rows: "1" },
    });
    inputEl.value = tb.text || "";

    const tableWrap = el.createDiv({ cls: "ink-text-table-wrap is-hidden" });
    const resizeEl = el.createDiv({ cls: "ink-text-resize", attr: { title: "Breite anpassen" } });

    const item = {
      el,
      header,
      inputEl,
      tableWrap,
      btnBold,
      btnBg,
      btnTable,
      firstCellInput: null,
      lastCommittedText: tb.text || "",
      lastCommittedTable: cloneTable(tb.table),
    };

    const stopProp = (ev) => ev.stopPropagation();
    for (const b of [btnFontDec, btnFontInc, btnBold, btnBg, btnTable, btnDel]) {
      b.addEventListener("pointerdown", stopProp);
      b.addEventListener("touchstart", stopProp, { passive: true });
    }

    const autoSize = () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.max(40, inputEl.scrollHeight) + "px";
      tb.h = Math.max(TEXT_H, Math.round(el.offsetHeight || TEXT_H));
    };

    btnFontDec.addEventListener("click", () => {
      const oldFs = tb.fontSize || 18;
      tb.fontSize = clamp(oldFs - 2, 10, 72);
      if (tb.fontSize !== oldFs) {
        this.pushUndo({ t: "textstyle", textBlock: tb, prop: "fontSize", oldVal: oldFs, newVal: tb.fontSize });
        this.refreshTextDomContent(tb, item);
        this.changed();
      }
    });

    btnFontInc.addEventListener("click", () => {
      const oldFs = tb.fontSize || 18;
      tb.fontSize = clamp(oldFs + 2, 10, 72);
      if (tb.fontSize !== oldFs) {
        this.pushUndo({ t: "textstyle", textBlock: tb, prop: "fontSize", oldVal: oldFs, newVal: tb.fontSize });
        this.refreshTextDomContent(tb, item);
        this.changed();
      }
    });

    btnBold.addEventListener("click", () => {
      const oldVal = !!tb.bold;
      tb.bold = !oldVal;
      this.pushUndo({ t: "textstyle", textBlock: tb, prop: "bold", oldVal, newVal: tb.bold });
      this.refreshTextDomContent(tb, item);
      this.changed();
    });

    btnBg.addEventListener("click", () => {
      const oldVal = tb.bgStyle || "card";
      const idx = TEXT_BG_STYLES.indexOf(oldVal);
      tb.bgStyle = TEXT_BG_STYLES[(idx + 1) % TEXT_BG_STYLES.length];
      this.pushUndo({ t: "textstyle", textBlock: tb, prop: "bgStyle", oldVal, newVal: tb.bgStyle });
      this.refreshTextDomContent(tb, item);
      this.changed();
    });

    btnTable.addEventListener("click", () => {
      const oldTbl = cloneTable(tb.table);
      if (!tb.table) {
        tb.table = [["Spalte 1", "Spalte 2"], ["", ""]];
        if ((tb.w || TEXT_W) < 320) tb.w = 340;
      } else {
        tb.table = null;
      }
      const newTbl = cloneTable(tb.table);
      item.lastCommittedTable = cloneTable(tb.table);
      this.pushUndo({ t: "texttable", textBlock: tb, oldTable: oldTbl, newTable: newTbl });
      this.refreshTextDomContent(tb, item);
      this.updateTextsTransform();
      this.changed();
      if (tb.table) setTimeout(() => this.focusTextDom(tb.id, true), 20);
    });

    btnDel.addEventListener("click", () => {
      this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
      this.deleteSelection();
    });

    // Eingabefeld-Ereignisse
    inputEl.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
      this.refreshToolbar();
      this.updateTextsTransform();
      this.requestDraw();
    });
    inputEl.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
    inputEl.addEventListener("focus", () => {
      el.classList.add("is-focused");
      this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
      item.lastCommittedText = tb.text || "";
      this.refreshToolbar();
      this.updateTextsTransform();
    });
    inputEl.addEventListener("blur", () => {
      setTimeout(() => {
        if (!el.contains(document.activeElement)) {
          el.classList.remove("is-focused");
        }
      }, 60);
      if (tb.text !== item.lastCommittedText) {
        this.pushUndo({
          t: "textedit",
          textBlock: tb,
          oldText: item.lastCommittedText,
          newText: tb.text,
        });
        item.lastCommittedText = tb.text;
        this.changed();
      }
    });
    inputEl.addEventListener("input", () => {
      tb.text = inputEl.value;
      autoSize();
      this.requestSave();
    });
    inputEl.addEventListener("keydown", (ke) => {
      ke.stopPropagation();
      if (ke.key === "Tab") {
        ke.preventDefault();
        const s = inputEl.selectionStart || 0;
        const e = inputEl.selectionEnd || 0;
        inputEl.value = inputEl.value.slice(0, s) + "  " + inputEl.value.slice(e);
        inputEl.selectionStart = inputEl.selectionEnd = s + 2;
        tb.text = inputEl.value;
        autoSize();
        this.requestSave();
      } else if (ke.key === "Escape") {
        inputEl.blur();
      }
    });

    // Ziehen über die Kopfzeile (oder den gesamten Block im Bewegen-Modus)
    const startDrag = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      try { header.setPointerCapture(ev.pointerId); } catch (err) { /* */ }
      this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
      this.refreshToolbar();
      this.updateTextsTransform();
      let lastDoc = this.toDoc(this.local(ev));
      let totalDx = 0, totalDy = 0;

      const onMove = (me) => {
        if (me.pointerId !== ev.pointerId) return;
        const curDoc = this.toDoc(this.local(me));
        const dx = curDoc.x - lastDoc.x, dy = curDoc.y - lastDoc.y;
        tb.x += dx; tb.y += dy;
        totalDx += dx; totalDy += dy;
        lastDoc = curDoc;
        this.updateTextsTransform();
        this.requestDraw();
      };
      const onUp = (ue) => {
        if (ue.pointerId !== ev.pointerId) return;
        header.removeEventListener("pointermove", onMove);
        header.removeEventListener("pointerup", onUp);
        header.removeEventListener("pointercancel", onUp);
        if (Math.abs(totalDx) > 0.5 || Math.abs(totalDy) > 0.5) {
          this.pushUndo({ t: "move", entry: null, link: null, viewer: null, text: tb, strokes: [], dx: totalDx, dy: totalDy });
          this.changed();
        }
      };
      header.addEventListener("pointermove", onMove);
      header.addEventListener("pointerup", onUp);
      header.addEventListener("pointercancel", onUp);
    };
    header.addEventListener("pointerdown", startDrag);

    // Skalieren/Breite anpassen über die Ecke unten rechts
    resizeEl.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      try { resizeEl.setPointerCapture(ev.pointerId); } catch (err) { /* */ }
      this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
      this.refreshToolbar();
      const startDoc = this.toDoc(this.local(ev));
      const w0 = tb.w || TEXT_W;

      const onMove = (me) => {
        if (me.pointerId !== ev.pointerId) return;
        const curDoc = this.toDoc(this.local(me));
        tb.w = clamp(Math.round(w0 + (curDoc.x - startDoc.x)), 120, 1600);
        autoSize();
        this.updateTextsTransform();
        this.requestDraw();
      };
      const onUp = (ue) => {
        if (ue.pointerId !== ev.pointerId) return;
        resizeEl.removeEventListener("pointermove", onMove);
        resizeEl.removeEventListener("pointerup", onUp);
        resizeEl.removeEventListener("pointercancel", onUp);
        if (tb.w !== w0) {
          this.pushUndo({ t: "textresize", textBlock: tb, w0, w1: tb.w });
          this.changed();
        }
      };
      resizeEl.addEventListener("pointermove", onMove);
      resizeEl.addEventListener("pointerup", onUp);
      resizeEl.addEventListener("pointercancel", onUp);
    });

    this.refreshTextDomContent(tb, item);
    setTimeout(autoSize, 0);
    return item;
  }

  refreshTextDomContent(tb, item) {
    const { el, inputEl, btnBold, btnBg, btnTable } = item;
    const bgStyle = tb.bgStyle || "card";
    el.classList.toggle("bg-transparent", bgStyle === "transparent");
    el.classList.toggle("bg-note", bgStyle === "note");
    btnBold.classList.toggle("is-active", !!tb.bold);
    btnBg.textContent = TEXT_BG_LABELS[bgStyle] || "Karte";
    btnTable.classList.toggle("is-active", Boolean(tb.table && tb.table.length));

    if (document.activeElement !== inputEl && inputEl.value !== (tb.text || "")) {
      inputEl.value = tb.text || "";
      item.lastCommittedText = tb.text || "";
    }
    inputEl.style.color = tb.color || "#111111";
    inputEl.style.fontSize = (tb.fontSize || 18) + "px";
    inputEl.style.fontWeight = tb.bold ? "700" : "400";
    inputEl.style.height = "auto";
    inputEl.style.height = Math.max(40, inputEl.scrollHeight) + "px";

    this.renderTextTableDom(tb, item);
    tb.h = Math.max(TEXT_H, Math.round(el.offsetHeight || TEXT_H));
  }

  renderTextTableDom(tb, item) {
    const { tableWrap, el } = item;
    tableWrap.empty();
    item.firstCellInput = null;

    if (!Array.isArray(tb.table) || !tb.table.length) {
      tableWrap.classList.add("is-hidden");
      return;
    }
    tableWrap.classList.remove("is-hidden");

    const tableEl = tableWrap.createEl("table", { cls: "ink-text-table" });
    tableEl.style.color = tb.color || "#111111";
    tableEl.style.fontSize = Math.max(12, Math.round((tb.fontSize || 18) * 0.86)) + "px";

    const cellInputs = [];
    const rows = tb.table.length;
    const cols = Math.max(1, tb.table[0] ? tb.table[0].length : 1);

    const commitTableUndoIfChanged = () => {
      const prevJson = JSON.stringify(item.lastCommittedTable);
      const curJson = JSON.stringify(tb.table);
      if (prevJson !== curJson) {
        this.pushUndo({
          t: "texttable",
          textBlock: tb,
          oldTable: cloneTable(item.lastCommittedTable),
          newTable: cloneTable(tb.table),
        });
        item.lastCommittedTable = cloneTable(tb.table);
        this.changed();
      }
    };

    for (let r = 0; r < rows; r++) {
      const tr = tableEl.createEl("tr");
      if (!Array.isArray(tb.table[r])) tb.table[r] = [];
      for (let c = 0; c < cols; c++) {
        const td = tr.createEl("td");
        const inp = td.createEl("input", {
          cls: "ink-text-cell-input",
          attr: { type: "text", placeholder: r === 0 ? `Spalte ${c + 1}` : "…" },
        });
        inp.value = tb.table[r][c] || "";
        if (!item.firstCellInput) item.firstCellInput = inp;
        cellInputs.push(inp);

        inp.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
          this.refreshToolbar();
          this.updateTextsTransform();
        });
        inp.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
        inp.addEventListener("focus", () => {
          el.classList.add("is-focused");
          item.lastCommittedTable = cloneTable(tb.table);
          this.sel = { entry: null, link: null, viewer: null, text: tb, strokes: [] };
          this.refreshToolbar();
          this.updateTextsTransform();
        });
        inp.addEventListener("blur", () => {
          setTimeout(() => {
            if (!el.contains(document.activeElement)) el.classList.remove("is-focused");
          }, 60);
          commitTableUndoIfChanged();
        });
        inp.addEventListener("input", () => {
          tb.table[r][c] = inp.value;
          this.requestSave();
        });
        inp.addEventListener("keydown", (ke) => {
          ke.stopPropagation();
          const idx = cellInputs.indexOf(inp);
          if (ke.key === "Tab") {
            ke.preventDefault();
            const nextIdx = ke.shiftKey ? idx - 1 : idx + 1;
            if (nextIdx >= 0 && nextIdx < cellInputs.length) {
              cellInputs[nextIdx].focus();
            } else if (!ke.shiftKey && nextIdx >= cellInputs.length) {
              // Am Tabellenende erzeugt Tab direkt eine neue Zeile
              const oldTbl = cloneTable(tb.table);
              tb.table.push(new Array(cols).fill(""));
              item.lastCommittedTable = cloneTable(tb.table);
              this.pushUndo({ t: "texttable", textBlock: tb, oldTable: oldTbl, newTable: cloneTable(tb.table) });
              this.renderTextTableDom(tb, item);
              this.changed();
              const allNew = tableWrap.querySelectorAll(".ink-text-cell-input");
              if (allNew[idx + 1]) allNew[idx + 1].focus();
            }
          } else if (ke.key === "Enter") {
            ke.preventDefault();
            const downIdx = idx + cols;
            if (downIdx < cellInputs.length) cellInputs[downIdx].focus();
          } else if (ke.key === "Escape") {
            inp.blur();
          }
        });
      }
    }

    const ctrls = tableWrap.createDiv({ cls: "ink-text-table-controls" });
    const mkTblBtn = (label, title, fn) => {
      const b = ctrls.createEl("button", { cls: "ink-text-btn", text: label, attr: { title } });
      b.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      b.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
      b.addEventListener("click", () => {
        const oldTbl = cloneTable(tb.table);
        fn();
        item.lastCommittedTable = cloneTable(tb.table);
        this.pushUndo({ t: "texttable", textBlock: tb, oldTable: oldTbl, newTable: cloneTable(tb.table) });
        this.renderTextTableDom(tb, item);
        tb.h = Math.max(TEXT_H, Math.round(el.offsetHeight || TEXT_H));
        this.changed();
      });
    };

    mkTblBtn("+ Zeile", "Zeile unten anfügen", () => {
      tb.table.push(new Array(cols).fill(""));
    });
    mkTblBtn("+ Spalte", "Spalte rechts anfügen", () => {
      for (const row of tb.table) row.push("");
      tb.w = Math.max(tb.w || TEXT_W, cols * 110 + 90);
      this.updateTextsTransform();
    });
    if (rows > 1) {
      mkTblBtn("- Zeile", "Letzte Zeile entfernen", () => {
        tb.table.pop();
      });
    }
    if (cols > 1) {
      mkTblBtn("- Spalte", "Letzte Spalte entfernen", () => {
        for (const row of tb.table) row.pop();
      });
    }
  }

  updateTextsTransform() {
    if (!this.textsLayer) return;
    const v = this.doc.view;
    const effTool = this.getEffectiveTool();
    const isDrawingTool = effTool === "pen" || effTool === "highlighter" || effTool === "eraser";
    this.textsLayer.classList.toggle("is-drawing-active", isDrawingTool);
    this.textsLayer.classList.toggle("is-text-mode", effTool === "text");

    for (const tb of (this.doc.texts || [])) {
      const item = this.textDom.get(tb.id);
      if (!item) continue;
      const w = tb.w || TEXT_W;
      const sx = tb.x * v.z + v.x;
      const sy = tb.y * v.z + v.y;
      item.el.style.width = `${w}px`;
      item.el.style.transform = `translate3d(${sx}px, ${sy}px, 0) scale(${v.z})`;
      item.el.classList.toggle("is-selected", Boolean(this.sel && this.sel.text === tb));
      tb.h = Math.max(TEXT_H, Math.round(item.el.offsetHeight || tb.h || TEXT_H));
    }
  }

  hitText(d) {
    const texts = this.doc.texts || [];
    for (let i = texts.length - 1; i >= 0; i--) {
      const tb = texts[i];
      const w = tb.w || TEXT_W;
      const h = tb.h || TEXT_H;
      if (d.x >= tb.x && d.x <= tb.x + w && d.y >= tb.y && d.y <= tb.y + h) return tb;
    }
    return null;
  }

  /* ----- PDF (Ausdruck, Anhang-Karte, Eingebetteter Viewer & Dateiaustausch v2.1.0) ----- */
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
        this.syncViewerDoms();
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
    if (e._lay && e._lw === e.w && e._ld === d && e._lp === e.page) return e._lay;
    const pages = [];
    let y = 0;
    if (e.page != null) {
      const safeIdx = clamp(e.page, 0, Math.max(0, d.asp.length - 1));
      const h = e.w * (d.asp[safeIdx] || 1.414);
      pages.push({ idx: safeIdx, y: 0, h });
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
    e._lp = e.page;
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

  addPdfLink(file) {
    const d = this.doc;
    const v = d.view;
    const cx = (this.cssW / 2 - v.x) / v.z - CARD_W / 2;
    const cy = (this.cssH / 2 - v.y) / v.z - CARD_H / 2;
    const link = { id: uid(), path: file.path, x: Math.round(cx), y: Math.round(cy), w: CARD_W };
    d.links.push(link);
    this.pushUndo({ t: "linkadd", link });
    this.sel = { entry: null, link, viewer: null, text: null, strokes: [] };
    new Notice(`PDF-Anhang verknüpft: ${file.name}`);
    this.changed();
  }

  async addPdfViewer(file) {
    const d = this.doc;
    const v = d.view;
    const cx = (this.cssW / 2 - v.x) / v.z - VIEWER_W / 2;
    const cy = (this.cssH / 2 - v.y) / v.z - VIEWER_H / 2;
    const viewer = {
      id: uid(),
      path: file.path,
      x: Math.round(cx),
      y: Math.round(cy),
      w: VIEWER_W,
      h: VIEWER_H,
      page: 0,
    };
    try {
      await this.ensureDoc(file.path);
    } catch (e) {
      this.docs.delete(file.path);
      new Notice("PDF konnte nicht geladen werden: " + file.name);
      return;
    }
    d.viewers.push(viewer);
    this.pushUndo({ t: "vieweradd", viewer });
    this.sel = { entry: null, link: null, viewer, text: null, strokes: [] };
    this.syncViewerDoms();
    new Notice(`PDF-Viewer eingebettet: ${file.name}`);
    this.changed();
  }

  changePdfFile(target, targetType) {
    if (!target || !targetType) return;
    const currentName = target.path ? (target.path.split("/").pop() || target.path) : "PDF";
    new PdfSuggestModal(
      this.app,
      async (newFile) => {
        if (!newFile) return;
        if (newFile.path === target.path) {
          new Notice(`„${newFile.name}“ ist bereits für dieses Element ausgewählt.`);
          return;
        }
        const oldPath = target.path;
        const oldPage = target.page;

        if (targetType === "entry" || targetType === "viewer") {
          try {
            await this.ensureDoc(newFile.path);
          } catch (e) {
            this.docs.delete(newFile.path);
            new Notice("Neue PDF konnte nicht geladen werden: " + newFile.name);
            return;
          }
        }

        target.path = newFile.path;

        if (targetType === "entry") {
          const d = this.docs.get(newFile.path);
          if (target.page != null && d && d.asp && d.asp.length) {
            target.page = clamp(target.page, 0, d.asp.length - 1);
          }
          target._lay = null;
          target._lw = null;
          target._ld = null;
          target._lp = null;
        } else if (targetType === "viewer") {
          target.page = 0;
          this.refreshViewerDom(target);
        }

        this.pushUndo({
          t: "pdfchange",
          targetType,
          target,
          oldPath,
          newPath: newFile.path,
          oldPage,
          newPage: target.page,
        });
        new Notice(`PDF geändert: ${currentName} → ${newFile.name}`);
        this.changed();
      },
      `Ersatz-PDF für „${currentName}“ auswählen …`
    ).open();
  }

  changeSelectedPdf() {
    const s = this.sel;
    if (s) {
      if (s.entry) return this.changePdfFile(s.entry, "entry");
      if (s.link) return this.changePdfFile(s.link, "link");
      if (s.viewer) return this.changePdfFile(s.viewer, "viewer");
    }
    this.promptChangeAnyEmbeddedPdf();
  }

  getAllEmbeddedPdfs() {
    const list = [];
    for (const vw of (this.doc.viewers || [])) {
      const name = vw.path.split("/").pop() || vw.path;
      list.push({ type: "viewer", obj: vw, label: `Viewer-Fenster: ${name}`, icon: "layout-panel-left" });
    }
    for (const p of (this.doc.pdfs || [])) {
      const name = p.path.split("/").pop() || p.path;
      const suffix = p.page != null ? ` (Seite ${p.page + 1})` : " (Ausdruck)";
      list.push({ type: "entry", obj: p, label: `Seiten-Ausdruck: ${name}${suffix}`, icon: "file-text" });
    }
    for (const l of (this.doc.links || [])) {
      const name = l.path.split("/").pop() || l.path;
      list.push({ type: "link", obj: l, label: `Anhang-Karte: ${name}`, icon: "paperclip" });
    }
    return list;
  }

  promptChangeAnyEmbeddedPdf(ev) {
    const all = this.getAllEmbeddedPdfs();
    if (!all.length) {
      new Notice("Keine eingebetteten PDF-Dateien in dieser Notiz vorhanden.");
      return;
    }
    if (all.length === 1) {
      this.changePdfFile(all[0].obj, all[0].type);
      return;
    }
    const menu = new Menu();
    for (const item of all) {
      menu.addItem((mi) =>
        mi
          .setTitle(item.label)
          .setIcon(item.icon)
          .onClick(() => {
            if (item.type === "entry") {
              this.sel = { entry: item.obj, link: null, viewer: null, text: null, strokes: this.strokesInEntry(item.obj) };
            } else if (item.type === "link") {
              this.sel = { entry: null, link: item.obj, viewer: null, text: null, strokes: [] };
            } else if (item.type === "viewer") {
              this.sel = { entry: null, link: null, viewer: item.obj, text: null, strokes: [] };
            }
            this.refreshToolbar();
            this.updateViewersTransform();
            this.requestDraw();
            this.changePdfFile(item.obj, item.type);
          })
      );
    }
    if (ev && typeof ev.clientX === "number") {
      menu.showAtMouseEvent(ev);
    } else {
      menu.showAtPosition({ x: Math.round(this.cssW / 2), y: 60 });
    }
  }

  refreshViewerDom(vw) {
    const item = this.viewerDom.get(vw.id);
    if (!item) {
      this.syncViewerDoms();
      return;
    }
    const fileName = vw.path.split("/").pop() || vw.path;
    if (item.titleEl) {
      item.titleEl.textContent = fileName;
      item.titleEl.setAttribute("title", vw.path);
    }
    try { if (item.io) item.io.disconnect(); } catch (e) { /* */ }
    item.io = null;
    item.builtPages = false;
    item.bodyEl.empty();
    item.pageEls = [];
    item.pageLabelEl.textContent = `${(vw.page || 0) + 1} / ?`;
    const d = this.docs.get(vw.path);
    if (d && d.state === "ok") {
      this.populateViewerPages(vw, item, d);
    } else {
      this.ensureDoc(vw.path).then(() => this.syncViewerDoms()).catch(() => {});
    }
    this.updateViewersTransform();
  }

  insertViewerPageToCanvas(vw) {
    const pageIdx = clamp(vw.page || 0, 0, 9999);
    const entry = {
      id: uid(),
      path: vw.path,
      x: Math.round(vw.x + (vw.w || VIEWER_W) + 40),
      y: Math.round(vw.y),
      w: PAGE_W,
      page: pageIdx,
    };
    this.doc.pdfs.push(entry);
    this.pushUndo({ t: "pdfadd", entry });
    this.sel = { entry, link: null, viewer: null, text: null, strokes: [] };
    new Notice(`Seite ${pageIdx + 1} auf die Leinwand übernommen.`);
    this.changed();
  }

  syncViewerDoms() {
    if (!this.viewersLayer) return;
    const viewers = this.doc.viewers || [];
    const activeIds = new Set(viewers.map((v) => v.id));

    for (const [id, item] of this.viewerDom.entries()) {
      if (!activeIds.has(id)) {
        try { if (item.io) item.io.disconnect(); } catch (e) { /* */ }
        item.el.remove();
        this.viewerDom.delete(id);
      }
    }

    for (const vw of viewers) {
      let item = this.viewerDom.get(vw.id);
      if (!item) {
        item = this.createViewerDom(vw);
        this.viewerDom.set(vw.id, item);
      }
      const d = this.docs.get(vw.path);
      if (d && d.state === "ok" && !item.builtPages) {
        this.populateViewerPages(vw, item, d);
      }
    }
    this.updateViewersTransform();
  }

  createViewerDom(vw) {
    const el = this.viewersLayer.createDiv({ cls: "ink-pdf-viewer" });
    const header = el.createDiv({ cls: "ink-pdf-viewer-header" });
    header.createSpan({ cls: "ink-pdf-viewer-badge", text: "PDF" });

    const fileName = vw.path.split("/").pop() || vw.path;
    const titleEl = header.createSpan({ cls: "ink-pdf-viewer-title", text: fileName, attr: { title: vw.path } });

    const nav = header.createDiv({ cls: "ink-pdf-viewer-nav" });
    const prevBtn = nav.createEl("button", { cls: "ink-viewer-btn", text: "◀", attr: { title: "Vorherige Seite" } });
    const pageLabelEl = nav.createSpan({ text: `${(vw.page || 0) + 1} / ?` });
    const nextBtn = nav.createEl("button", { cls: "ink-viewer-btn", text: "▶", attr: { title: "Nächste Seite" } });

    const extractBtn = header.createEl("button", {
      cls: "ink-viewer-btn is-accent",
      text: "+ Seite",
      attr: { title: "Aktuelle Seite zum Beschriften neben den Viewer auf die Leinwand legen" },
    });

    const changeBtn = header.createEl("button", {
      cls: "ink-viewer-btn",
      text: "⇄",
      attr: { title: "Eingebettete PDF-Datei ändern / austauschen" },
    });

    const openBtn = header.createEl("button", {
      cls: "ink-viewer-btn",
      text: "↗",
      attr: { title: "PDF in neuem Obsidian-Tab öffnen" },
    });

    const closeBtn = header.createEl("button", {
      cls: "ink-viewer-btn is-danger",
      text: "✕",
      attr: { title: "PDF-Viewer von der Leinwand entfernen" },
    });

    const bodyEl = el.createDiv({ cls: "ink-pdf-viewer-body" });
    const resizeEl = el.createDiv({ cls: "ink-pdf-viewer-resize", attr: { title: "Größe ändern" } });

    const item = { el, header, titleEl, bodyEl, pageLabelEl, pageEls: [], builtPages: false, io: null };

    const stopDown = (ev) => ev.stopPropagation();
    for (const b of [prevBtn, nextBtn, extractBtn, changeBtn, openBtn, closeBtn]) {
      b.addEventListener("pointerdown", stopDown);
    }

    prevBtn.addEventListener("click", () => this.scrollViewerToPage(vw, item, (vw.page || 0) - 1));
    nextBtn.addEventListener("click", () => this.scrollViewerToPage(vw, item, (vw.page || 0) + 1));
    extractBtn.addEventListener("click", () => this.insertViewerPageToCanvas(vw));
    changeBtn.addEventListener("click", () => {
      this.sel = { entry: null, link: null, viewer: vw, text: null, strokes: [] };
      this.refreshToolbar();
      this.updateViewersTransform();
      this.changePdfFile(vw, "viewer");
    });
    openBtn.addEventListener("click", () => this.openPdfLink(vw));
    closeBtn.addEventListener("click", () => {
      this.sel = { entry: null, link: null, viewer: vw, text: null, strokes: [] };
      this.deleteSelection();
    });

    bodyEl.addEventListener("scroll", () => {
      if (!item.pageEls.length) return;
      const mid = bodyEl.scrollTop + bodyEl.clientHeight * 0.35;
      let bestIdx = 0;
      for (let i = 0; i < item.pageEls.length; i++) {
        const pe = item.pageEls[i];
        if (pe.offsetTop <= mid) bestIdx = i;
        else break;
      }
      if (vw.page !== bestIdx) {
        vw.page = bestIdx;
        pageLabelEl.textContent = `${bestIdx + 1} / ${item.pageEls.length}`;
        this.requestSave();
      }
    }, { passive: true });

    bodyEl.addEventListener("wheel", (ev) => {
      ev.stopPropagation();
    }, { passive: true });

    header.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      try { header.setPointerCapture(ev.pointerId); } catch (err) { /* */ }
      this.sel = { entry: null, link: null, viewer: vw, text: null, strokes: [] };
      this.refreshToolbar();
      this.updateViewersTransform();
      const startP = this.local(ev);
      let lastDoc = this.toDoc(startP);
      let totalDx = 0, totalDy = 0;

      const onMove = (me) => {
        if (me.pointerId !== ev.pointerId) return;
        const curDoc = this.toDoc(this.local(me));
        const dx = curDoc.x - lastDoc.x, dy = curDoc.y - lastDoc.y;
        vw.x += dx; vw.y += dy;
        totalDx += dx; totalDy += dy;
        lastDoc = curDoc;
        this.updateViewersTransform();
        this.requestDraw();
      };
      const onUp = (ue) => {
        if (ue.pointerId !== ev.pointerId) return;
        header.removeEventListener("pointermove", onMove);
        header.removeEventListener("pointerup", onUp);
        header.removeEventListener("pointercancel", onUp);
        if (Math.abs(totalDx) > 0.5 || Math.abs(totalDy) > 0.5) {
          this.pushUndo({ t: "move", entry: null, link: null, viewer: vw, text: null, strokes: [], dx: totalDx, dy: totalDy });
          this.changed();
        }
      };
      header.addEventListener("pointermove", onMove);
      header.addEventListener("pointerup", onUp);
      header.addEventListener("pointercancel", onUp);
    });

    resizeEl.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      try { resizeEl.setPointerCapture(ev.pointerId); } catch (err) { /* */ }
      this.sel = { entry: null, link: null, viewer: vw, text: null, strokes: [] };
      this.refreshToolbar();
      const startDoc = this.toDoc(this.local(ev));
      const w0 = vw.w || VIEWER_W, h0 = vw.h || VIEWER_H;

      const onMove = (me) => {
        if (me.pointerId !== ev.pointerId) return;
        const curDoc = this.toDoc(this.local(me));
        vw.w = clamp(Math.round(w0 + (curDoc.x - startDoc.x)), 280, 1800);
        vw.h = clamp(Math.round(h0 + (curDoc.y - startDoc.y)), 260, 2200);
        this.updateViewersTransform();
        this.requestDraw();
      };
      const onUp = (ue) => {
        if (ue.pointerId !== ev.pointerId) return;
        resizeEl.removeEventListener("pointermove", onMove);
        resizeEl.removeEventListener("pointerup", onUp);
        resizeEl.removeEventListener("pointercancel", onUp);
        if (vw.w !== w0 || vw.h !== h0) {
          this.pushUndo({ t: "viewerresize", viewer: vw, w0, h0, w1: vw.w, h1: vw.h });
          this.changed();
        }
      };
      resizeEl.addEventListener("pointermove", onMove);
      resizeEl.addEventListener("pointerup", onUp);
      resizeEl.addEventListener("pointercancel", onUp);
    });

    return item;
  }

  populateViewerPages(vw, item, d) {
    item.builtPages = true;
    item.bodyEl.empty();
    item.pageEls = [];
    const total = d.asp.length;
    item.pageLabelEl.textContent = `${clamp((vw.page || 0) + 1, 1, total)} / ${total}`;

    item.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          const idx = parseInt(en.target.dataset.idx, 10);
          this.renderViewerPageCanvas(vw, d, en.target, idx);
        }
      }
    }, { root: item.bodyEl, rootMargin: "250px 0px" });

    for (let i = 0; i < total; i++) {
      const asp = d.asp[i] || 1.414;
      const pageEl = item.bodyEl.createDiv({ cls: "ink-pdf-viewer-page" });
      pageEl.dataset.idx = String(i);
      pageEl.style.aspectRatio = `1 / ${asp}`;
      pageEl.createSpan({ cls: "ink-pdf-viewer-page-num", text: `${i + 1}` });
      item.pageEls.push(pageEl);
      item.io.observe(pageEl);
    }

    if (vw.page > 0 && vw.page < total) {
      setTimeout(() => this.scrollViewerToPage(vw, item, vw.page, false), 40);
    }
  }

  async renderViewerPageCanvas(vw, d, pageEl, idx) {
    if (pageEl.dataset.rendered === "1" || pageEl.dataset.rendering === "1") return;
    pageEl.dataset.rendering = "1";
    try {
      const pg = await d.pdf.getPage(idx + 1);
      const vp0 = pg.getViewport({ scale: 1 });
      const targetW = Math.min(2000, Math.max(700, (vw.w || VIEWER_W) * 1.6));
      const vp = pg.getViewport({ scale: targetW / vp0.width });
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.floor(vp.width));
      cv.height = Math.max(1, Math.floor(vp.height));
      await pg.render({ canvasContext: cv.getContext("2d"), canvas: cv, viewport: vp }).promise;
      pageEl.prepend(cv);
      pageEl.dataset.rendered = "1";
    } catch (e) {
      console.error("Viewer Page Render:", e);
    } finally {
      delete pageEl.dataset.rendering;
    }
  }

  scrollViewerToPage(vw, item, targetIdx, smooth = true) {
    if (!item.pageEls.length) return;
    const idx = clamp(targetIdx, 0, item.pageEls.length - 1);
    const pe = item.pageEls[idx];
    if (!pe) return;
    vw.page = idx;
    item.pageLabelEl.textContent = `${idx + 1} / ${item.pageEls.length}`;
    item.bodyEl.scrollTo({ top: pe.offsetTop - 8, behavior: smooth ? "smooth" : "auto" });
    this.requestSave();
  }

  updateViewersTransform() {
    if (!this.viewersLayer) return;
    const v = this.doc.view;
    for (const vw of (this.doc.viewers || [])) {
      const item = this.viewerDom.get(vw.id);
      if (!item) continue;
      const w = vw.w || VIEWER_W;
      const h = vw.h || VIEWER_H;
      const sx = vw.x * v.z + v.x;
      const sy = vw.y * v.z + v.y;
      item.el.style.width = `${w}px`;
      item.el.style.height = `${h}px`;
      item.el.style.transform = `translate3d(${sx}px, ${sy}px, 0) scale(${v.z})`;
      item.el.classList.toggle("is-selected", Boolean(this.sel && this.sel.viewer === vw));
    }
  }

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

  hitLinkOpenButton(d) {
    const l = this.hitLink(d);
    if (!l) return null;
    const w = l.w || CARD_W;
    const s = w / CARD_W;
    const h = CARD_H * s;
    const btnW = 62 * s, btnH = 36 * s;
    const btnX = l.x + w - btnW - 8 * s, btnY = l.y + (h - btnH) / 2;
    if (d.x >= btnX && d.x <= btnX + btnW && d.y >= btnY && d.y <= btnY + btnH) return l;
    return null;
  }

  hitLinkChangeButton(d) {
    const l = this.hitLink(d);
    if (!l) return null;
    const w = l.w || CARD_W;
    const s = w / CARD_W;
    const h = CARD_H * s;
    const chgW = 34 * s, chgH = 36 * s;
    const btnW = 58 * s;
    const btnX = l.x + w - btnW - 10 * s;
    const chgX = btnX - chgW - 4 * s, chgY = l.y + (h - chgH) / 2;
    if (d.x >= chgX && d.x <= chgX + chgW && d.y >= chgY && d.y <= chgY + chgH) return l;
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
    if (s.viewer) {
      const vw = s.viewer;
      return { x0: vw.x, y0: vw.y, x1: vw.x + (vw.w || VIEWER_W), y1: vw.y + (vw.h || VIEWER_H) };
    }
    if (s.text) {
      const tb = s.text;
      return { x0: tb.x, y0: tb.y, x1: tb.x + (tb.w || TEXT_W), y1: tb.y + (tb.h || TEXT_H) };
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
    if (!b || (this.sel && (this.sel.viewer || this.sel.text))) return null;
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
    } else if (s.viewer) {
      const i = d.viewers.indexOf(s.viewer);
      if (i >= 0) {
        d.viewers.splice(i, 1);
        this.pushUndo({ t: "viewerdel", viewer: s.viewer, i });
        this.syncViewerDoms();
      }
    } else if (s.text) {
      const i = (d.texts || []).indexOf(s.text);
      if (i >= 0) {
        d.texts.splice(i, 1);
        this.pushUndo({ t: "textdel", textBlock: s.text, i });
        this.syncTextDoms();
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
    if (!s) return;
    if (s.text) {
      const o = s.text;
      const copy = {
        id: uid(),
        x: Math.round(o.x + 30),
        y: Math.round(o.y + 30),
        w: o.w || TEXT_W,
        h: o.h || TEXT_H,
        text: o.text || "",
        color: o.color || "#111111",
        fontSize: o.fontSize || 18,
        bgStyle: o.bgStyle || "card",
        bold: !!o.bold,
        table: cloneTable(o.table),
      };
      this.doc.texts.push(copy);
      this.pushUndo({ t: "textadd", textBlock: copy });
      this.sel = { entry: null, link: null, viewer: null, text: copy, strokes: [] };
      this.syncTextDoms();
      this.changed();
      return;
    }
    if (s.entry || s.link || s.viewer || !s.strokes.length) return;
    const copies = s.strokes.map((o) => ({
      tool: o.tool, color: o.color, width: o.width, sharp: o.sharp,
      points: o.points.map((p) => [p[0] + 30, p[1] + 30, p[2]]),
    }));
    this.doc.strokes.push(...copies);
    this.pushUndo({ t: "addmany", list: copies });
    this.sel = { entry: null, link: null, viewer: null, text: null, strokes: copies };
    this.changed();
  }

  scaleSelection(k) {
    const s = this.sel;
    const b = this.selBounds();
    if (!s || !b) return;
    if (s.viewer) {
      const w0 = s.viewer.w || VIEWER_W, h0 = s.viewer.h || VIEWER_H;
      s.viewer.w = clamp(Math.round(w0 * k), 280, 1800);
      s.viewer.h = clamp(Math.round(h0 * k), 260, 2200);
      this.pushUndo({ t: "viewerresize", viewer: s.viewer, w0, h0, w1: s.viewer.w, h1: s.viewer.h });
      this.updateViewersTransform();
      this.changed();
      return;
    }
    if (s.text) {
      const tb = s.text;
      const oldFs = tb.fontSize || 18;
      const oldW = tb.w || TEXT_W;
      tb.fontSize = clamp(Math.round(oldFs * k), 10, 72);
      tb.w = clamp(Math.round(oldW * k), 120, 1600);
      this.pushUndo({ t: "textscale", textBlock: tb, oldFs, newFs: tb.fontSize, oldW, newW: tb.w });
      this.syncTextDoms();
      this.changed();
      return;
    }
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
    for (const vw of (this.doc.viewers || [])) {
      x0 = Math.min(x0, vw.x); y0 = Math.min(y0, vw.y);
      x1 = Math.max(x1, vw.x + (vw.w || VIEWER_W)); y1 = Math.max(y1, vw.y + (vw.h || VIEWER_H));
    }
    for (const tb of (this.doc.texts || [])) {
      x0 = Math.min(x0, tb.x); y0 = Math.min(y0, tb.y);
      x1 = Math.max(x1, tb.x + (tb.w || TEXT_W)); y1 = Math.max(y1, tb.y + (tb.h || TEXT_H));
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
      case "vieweradd":
        if (reverse) d.viewers = d.viewers.filter((v) => v !== a.viewer);
        else d.viewers.push(a.viewer);
        this.syncViewerDoms();
        break;
      case "viewerdel":
        if (reverse) d.viewers.splice(a.i, 0, a.viewer);
        else d.viewers = d.viewers.filter((v) => v !== a.viewer);
        this.syncViewerDoms();
        break;
      case "viewerresize":
        a.viewer.w = reverse ? a.w0 : a.w1;
        a.viewer.h = reverse ? a.h0 : a.h1;
        this.updateViewersTransform();
        break;
      case "textadd":
        if (reverse) d.texts = (d.texts || []).filter((t) => t !== a.textBlock);
        else (d.texts || (d.texts = [])).push(a.textBlock);
        this.syncTextDoms();
        break;
      case "textdel":
        if (reverse) (d.texts || (d.texts = [])).splice(a.i, 0, a.textBlock);
        else d.texts = (d.texts || []).filter((t) => t !== a.textBlock);
        this.syncTextDoms();
        break;
      case "textedit":
        a.textBlock.text = reverse ? a.oldText : a.newText;
        this.syncTextDoms();
        break;
      case "textstyle":
        a.textBlock[a.prop] = reverse ? a.oldVal : a.newVal;
        this.syncTextDoms();
        break;
      case "texttable":
        a.textBlock.table = cloneTable(reverse ? a.oldTable : a.newTable);
        this.syncTextDoms();
        break;
      case "textresize":
        a.textBlock.w = reverse ? a.w0 : a.w1;
        this.syncTextDoms();
        break;
      case "textscale":
        a.textBlock.fontSize = reverse ? a.oldFs : a.newFs;
        a.textBlock.w = reverse ? a.oldW : a.newW;
        this.syncTextDoms();
        break;
      case "pdfchange": {
        const nextPath = reverse ? a.oldPath : a.newPath;
        const nextPage = reverse ? a.oldPage : a.newPage;
        a.target.path = nextPath;
        if (a.targetType === "entry") {
          a.target.page = nextPage;
          a.target._lay = null;
          a.target._lw = null;
          a.target._ld = null;
          a.target._lp = null;
          this.ensureDoc(nextPath).then(() => this.invalidateStatic()).catch(() => {});
        } else if (a.targetType === "viewer") {
          a.target.page = nextPage || 0;
          this.ensureDoc(nextPath).then(() => this.refreshViewerDom(a.target)).catch(() => {});
          this.refreshViewerDom(a.target);
        }
        break;
      }
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
        if (a.viewer) { a.viewer.x += sg * a.dx; a.viewer.y += sg * a.dy; this.updateViewersTransform(); }
        if (a.text) { a.text.x += sg * a.dx; a.text.y += sg * a.dy; this.updateTextsTransform(); }
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

  /* ----- Clean Tablet UI (v2.2.0) ----- */
  buildUI() {
    const root = this.contentEl;
    this.toolbar = root.createDiv({ cls: "ink-toolbar" });
    this.wrap = root.createDiv({ cls: "ink-canvas-wrap" });
    this.canvas = this.wrap.createEl("canvas", { cls: "ink-canvas" });
    this.textsLayer = this.wrap.createDiv({ cls: "ink-texts-layer" });
    this.viewersLayer = this.wrap.createDiv({ cls: "ink-viewers-layer" });

    // Schwebendes Popover für Strichstärke & Glättung
    this.strokePopover = this.wrap.createDiv({ cls: "ink-popover" });
    this.buildStrokePopover();

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

    const mkBtn = (parent, icon, label, fn) => {
      const b = parent.createEl("button", { cls: "ink-btn", attr: { "aria-label": label, title: label } });
      setIcon(b, icon);
      b.addEventListener("click", (ev) => fn(ev));
      return b;
    };

    // 1. Haupt-Werkzeuge (Pille)
    const toolsGroup = this.toolbar.createDiv({ cls: "ink-tool-group" });
    this.btnPen = mkBtn(toolsGroup, "pencil", "Stift", () => this.setTool("pen"));
    this.btnHl = mkBtn(toolsGroup, "highlighter", "Textmarker", () => this.setTool("highlighter"));
    this.btnEr = mkBtn(toolsGroup, "eraser", "Radierer", () => this.setTool("eraser"));
    this.btnText = mkBtn(toolsGroup, "type", "Textblock / Tabelle (auf Leinwand tippen zum Einfügen)", () => this.setTool("text"));
    this.btnLasso = mkBtn(toolsGroup, "lasso-select", "Lasso-Auswahl", () => this.setTool("lasso"));
    this.btnMove = mkBtn(toolsGroup, "hand", "Bewegen / Element auswählen", () => this.setTool("move"));

    // 2. Farben & Strichstärke-Trigger (sichtbar bei Stift, Marker, Textwerkzeug oder ausgewähltem Textblock)
    this.styleGroup = this.toolbar.createDiv({ cls: "ink-tool-group ink-style-group" });
    this.colorBox = this.styleGroup.createDiv({ cls: "ink-colors" });
    this.btnStrokePopover = this.styleGroup.createEl("button", {
      cls: "ink-btn ink-stroke-trigger",
      attr: { title: "Strichstärke & Glättung anpassen" },
    });
    this.strokePreviewDot = this.btnStrokePopover.createDiv({ cls: "ink-stroke-dot" });
    this.btnStrokePopover.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.toggleStrokePopover();
    });

    // 3. Dynamische Kontext-Aktionen (NUR sichtbar, wenn etwas mit Lasso/Hand/Viewer/Text ausgewählt ist!)
    this.contextGroup = this.toolbar.createDiv({ cls: "ink-tool-group ink-context-group is-hidden" });
    this.btnEditText = mkBtn(this.contextGroup, "edit-3", "Text bearbeiten (Tastatur öffnen)", () => {
      if (this.sel && this.sel.text) this.focusTextDom(this.sel.text.id, false);
    });
    this.btnToggleTable = mkBtn(this.contextGroup, "table", "Tabelle im Textblock ein-/ausblenden", () => {
      if (this.sel && this.sel.text) {
        const tb = this.sel.text;
        const item = this.textDom.get(tb.id);
        const oldTbl = cloneTable(tb.table);
        if (!tb.table) {
          tb.table = [["Spalte 1", "Spalte 2"], ["", ""]];
          if ((tb.w || TEXT_W) < 320) tb.w = 340;
        } else {
          tb.table = null;
        }
        if (item) item.lastCommittedTable = cloneTable(tb.table);
        this.pushUndo({ t: "texttable", textBlock: tb, oldTable: oldTbl, newTable: cloneTable(tb.table) });
        this.syncTextDoms();
        this.changed();
        if (tb.table) setTimeout(() => this.focusTextDom(tb.id, true), 20);
      }
    });
    this.btnChangePdf = mkBtn(this.contextGroup, "refresh-cw", "Eingebettete PDF-Datei ändern / austauschen", () => {
      this.changeSelectedPdf();
    });
    this.btnOpenLink = mkBtn(this.contextGroup, "external-link", "PDF in neuem Tab öffnen", () => {
      if (this.sel && this.sel.link) this.openPdfLink(this.sel.link);
      else if (this.sel && this.sel.entry) this.openPdfLink(this.sel.entry);
      else if (this.sel && this.sel.viewer) this.openPdfLink(this.sel.viewer);
    });
    this.btnUngroup = mkBtn(this.contextGroup, "ungroup", "PDF in Einzelseiten aufteilen", () => this.ungroupSelection());
    this.btnShrink = mkBtn(this.contextGroup, "minimize-2", "Verkleinern", () => this.scaleSelection(1 / 1.12));
    this.btnGrow = mkBtn(this.contextGroup, "maximize-2", "Vergrößern", () => this.scaleSelection(1.12));
    this.btnDup = mkBtn(this.contextGroup, "copy", "Duplizieren", () => this.duplicateSelection());
    this.btnDel = mkBtn(this.contextGroup, "trash-2", "Auswahl löschen", () => this.deleteSelection());
    this.btnDel.classList.add("is-danger-icon");

    // 4. Undo / Redo & Einfügen-Menü & Mehr-Menü
    const rightGroup = this.toolbar.createDiv({ cls: "ink-tool-group" });
    this.btnUndo = mkBtn(rightGroup, "undo-2", "Rückgängig (2-Finger-Tippen)", () => this.undo());
    this.btnRedo = mkBtn(rightGroup, "redo-2", "Wiederholen (3-Finger-Tippen)", () => this.redo());

    mkBtn(rightGroup, "file-plus", "Textblock, Tabelle oder PDF einfügen", (ev) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Textblock zum Tippen einfügen")
          .setIcon("type")
          .onClick(() => {
            this.setTool("text");
            this.addTextBlock(null, null, false);
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("Textblock mit Tabelle einfügen")
          .setIcon("table")
          .onClick(() => {
            this.setTool("text");
            this.addTextBlock(null, null, true);
          })
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("PDF als Viewer-Fenster einbetten")
          .setIcon("layout-panel-left")
          .onClick(() => this.plugin.pickPdf((f) => this.addPdfViewer(f)))
      );
      menu.addItem((item) =>
        item
          .setTitle("PDF als Seiten-Ausdruck einfügen")
          .setIcon("file-text")
          .onClick(() => this.plugin.pickPdf((f) => this.addPdf(f)))
      );
      menu.addItem((item) =>
        item
          .setTitle("PDF als Anhang-Karte verknüpfen")
          .setIcon("paperclip")
          .onClick(() => this.plugin.pickPdf((f) => this.addPdfLink(f)))
      );

      const s = this.sel;
      const hasSelPdf = Boolean(s && (s.entry || s.link || s.viewer));
      const allEmbedded = this.getAllEmbeddedPdfs();
      if (hasSelPdf || allEmbedded.length > 0) {
        menu.addSeparator();
        if (hasSelPdf) {
          const curTarget = s.entry || s.link || s.viewer;
          const curName = curTarget.path ? (curTarget.path.split("/").pop() || curTarget.path) : "PDF";
          menu.addItem((item) =>
            item
              .setTitle(`Ausgewählte PDF ändern (${curName}) …`)
              .setIcon("refresh-cw")
              .onClick(() => this.changeSelectedPdf())
          );
        }
        if (allEmbedded.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Bereits eingebettete PDF-Datei ändern …")
              .setIcon("refresh-cw")
              .onClick(() => this.promptChangeAnyEmbeddedPdf(ev))
          );
        }
      }
      menu.showAtMouseEvent(ev);
    });

    mkBtn(rightGroup, "more-horizontal", "Weitere Optionen & Ansicht", (ev) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle(`Hintergrund: ${BG_LABELS[this.doc.bg]} (wechseln)`)
          .setIcon("grid-3x3")
          .onClick(() => {
            const i = BGS.indexOf(this.doc.bg);
            this.doc.bg = BGS[(i + 1) % BGS.length];
            new Notice("Hintergrund: " + BG_LABELS[this.doc.bg]);
            this.changed();
          })
      );
      menu.addItem((item) =>
        item
          .setTitle(`Formerkennung beim Halten: ${this.plugin.settings.shapeRecognition ? "An ✓" : "Aus"}`)
          .setIcon("shapes")
          .onClick(() => {
            this.plugin.settings.shapeRecognition = !this.plugin.settings.shapeRecognition;
            this.plugin.saveSettings();
            new Notice(`Formerkennung: ${this.plugin.settings.shapeRecognition ? "An" : "Aus"}`);
          })
      );
      menu.addItem((item) =>
        item
          .setTitle(`Mit Finger zeichnen: ${this.plugin.settings.fingerDraws ? "An ✓" : "Aus"}`)
          .setIcon("hand")
          .onClick(() => {
            this.plugin.settings.fingerDraws = !this.plugin.settings.fingerDraws;
            this.plugin.saveSettings();
            new Notice(`Mit Finger zeichnen: ${this.plugin.settings.fingerDraws ? "An" : "Aus"}`);
          })
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Alles anzeigen (Zoom anpassen)")
          .setIcon("maximize")
          .onClick(() => this.fitAll())
      );
      menu.addItem((item) =>
        item
          .setTitle("Als PNG-Bild exportieren")
          .setIcon("image-down")
          .onClick(() => this.exportPng())
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Werkzeugleiste ausblenden (Vollbild)")
          .setIcon("chevron-up")
          .onClick(() => this.toggleToolbar(true))
      );
      menu.showAtMouseEvent(ev);
    });

    this._outsideClickHandler = (ev) => {
      if (this.strokePopover && this.strokePopover.classList.contains("is-open")) {
        if (!this.strokePopover.contains(ev.target) && !this.btnStrokePopover.contains(ev.target)) {
          this.strokePopover.classList.remove("is-open");
        }
      }
    };
    window.addEventListener("pointerdown", this._outsideClickHandler, true);

    this.bindEvents();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);
    this.resize();
    this.refreshToolbar();
    this.syncViewerDoms();
    this.syncTextDoms();
  }

  buildStrokePopover() {
    this.strokePopover.empty();
    const stop = (e) => e.stopPropagation();
    this.strokePopover.addEventListener("pointerdown", stop);

    const presetsRow = this.strokePopover.createDiv({ cls: "ink-popover-presets" });
    const presets = [1.5, 2.5, 4, 7, 11];
    for (const pVal of presets) {
      const btn = presetsRow.createEl("button", {
        cls: "ink-preset-btn",
        attr: { title: `Stärke ${pVal}` },
      });
      const dot = btn.createDiv({ cls: "ink-preset-dot" });
      const sz = clamp(Math.round(pVal * 1.4 + 3), 4, 18);
      dot.style.width = `${sz}px`;
      dot.style.height = `${sz}px`;
      btn.addEventListener("click", () => {
        this.width = pVal;
        this.plugin.settings.penWidth = pVal;
        this.plugin.saveSettings();
        if (this.widthSliderEl) this.widthSliderEl.value = String(pVal);
        if (this.widthValLabel) this.widthValLabel.textContent = pVal.toFixed(1);
        this.updateStrokeTriggerPreview();
      });
    }

    const rowW = this.strokePopover.createDiv({ cls: "ink-popover-row" });
    rowW.createSpan({ cls: "ink-popover-label", text: "Stärke" });
    this.widthSliderEl = rowW.createEl("input", {
      cls: "ink-width",
      attr: { type: "range", min: "1", max: "14", step: "0.5" },
    });
    this.widthSliderEl.value = String(this.width);
    this.widthValLabel = rowW.createSpan({ cls: "ink-val-label", text: this.width.toFixed(1) });
    this.widthSliderEl.addEventListener("input", () => {
      const v = parseFloat(this.widthSliderEl.value);
      this.width = v;
      this.widthValLabel.textContent = v.toFixed(1);
      this.plugin.settings.penWidth = v;
      this.plugin.saveSettings();
      this.updateStrokeTriggerPreview();
    });

    const rowS = this.strokePopover.createDiv({ cls: "ink-popover-row" });
    rowS.createSpan({ cls: "ink-popover-label", text: "Glättung" });
    const smSlider = rowS.createEl("input", {
      cls: "ink-width",
      attr: { type: "range", min: "0", max: "1", step: "0.05" },
    });
    smSlider.value = String(this.plugin.settings.smoothing);
    const smVal = rowS.createSpan({ cls: "ink-val-label", text: Math.round(this.plugin.settings.smoothing * 100) + "%" });
    smSlider.addEventListener("input", () => {
      const v = parseFloat(smSlider.value);
      smVal.textContent = Math.round(v * 100) + "%";
      this.plugin.settings.smoothing = v;
      this.plugin.saveSettings();
    });
  }

  toggleStrokePopover() {
    if (!this.strokePopover) return;
    const open = !this.strokePopover.classList.contains("is-open");
    if (open && this.btnStrokePopover) {
      const rBtn = this.btnStrokePopover.getBoundingClientRect();
      const rWrap = this.wrap.getBoundingClientRect();
      const left = clamp(rBtn.left - rWrap.left - 90, 10, Math.max(10, this.cssW - 240));
      this.strokePopover.style.left = `${left}px`;
    }
    this.strokePopover.classList.toggle("is-open", open);
  }

  updateStrokeTriggerPreview() {
    if (!this.strokePreviewDot) return;
    const isHl = this.tool === "highlighter";
    const col = isHl ? this.hlColor : this.penColor;
    const sz = clamp(Math.round(this.width * 1.3 + 4), 5, 20);
    this.strokePreviewDot.style.width = `${sz}px`;
    this.strokePreviewDot.style.height = `${sz}px`;
    this.strokePreviewDot.style.background = col;
  }

  toggleToolbar(collapse) {
    this.toolbar.classList.toggle("is-collapsed", collapse);
    this.uncollapseBtn.classList.toggle("is-visible", collapse);
    if (collapse && this.strokePopover) this.strokePopover.classList.remove("is-open");
    setTimeout(() => this.resize(), 20);
  }

  setTool(t) {
    if (t !== this.tool) {
      if (t !== "text" && t !== "move" && t !== "lasso") {
        this.blurAllTexts();
      }
      this.sel = null;
      this.lasso = null;
    }
    this.tool = t;
    this.barrelHeld = false;
    this.contextMenuBarrel = false;
    if (t !== "eraser") this.eraserPos = null;
    if (this.strokePopover) this.strokePopover.classList.remove("is-open");
    this.refreshToolbar();
    this.updateViewersTransform();
    this.updateTextsTransform();
    this.requestDraw();
  }

  getEffectiveTool() {
    if (this.barrelHeld && this.plugin.settings.penButton !== "off") {
      return this.plugin.settings.penButton === "eraser" ? "eraser" : "move";
    }
    return this.tool;
  }

  removeCustomColor(colorHex, isPen) {
    const target = colorHex.toLowerCase();
    if (isPen) {
      this.plugin.settings.customPenColors = (this.plugin.settings.customPenColors || [])
        .filter((x) => x.toLowerCase() !== target);
      if (this.penColor.toLowerCase() === target) {
        const remaining = this.plugin.settings.customPenColors;
        this.penColor = remaining.length ? remaining[remaining.length - 1] : DEFAULT_PEN_COLORS[0];
      }
    } else {
      this.plugin.settings.customHlColors = (this.plugin.settings.customHlColors || [])
        .filter((x) => x.toLowerCase() !== target);
      if (this.hlColor.toLowerCase() === target) {
        const remaining = this.plugin.settings.customHlColors;
        this.hlColor = remaining.length ? remaining[remaining.length - 1] : DEFAULT_HL_COLORS[0];
      }
    }
    this.plugin.saveSettings();
    this.refreshToolbar();
    new Notice(`Eigene Farbe ${target} gelöscht.`);
  }

  refreshToolbar() {
    if (!this.btnPen) return;
    const effTool = this.getEffectiveTool();
    const isBarrelOverride = this.barrelHeld && this.plugin.settings.penButton !== "off";
    const act = (b, on) => b && b.classList.toggle("is-active", !!on);
    act(this.btnPen, effTool === "pen");
    act(this.btnHl, effTool === "highlighter");
    act(this.btnEr, effTool === "eraser");
    act(this.btnText, effTool === "text");
    act(this.btnLasso, effTool === "lasso");
    act(this.btnMove, effTool === "move");
    this.btnEr.classList.toggle("is-barrel-override", Boolean(isBarrelOverride && effTool === "eraser"));
    this.btnUndo.disabled = !this.undoStack.length;
    this.btnRedo.disabled = !this.redoStack.length;

    const s = this.sel;
    const hasSel = Boolean(s && (s.entry || s.link || s.viewer || s.text || (s.strokes && s.strokes.length)));
    this.contextGroup.classList.toggle("is-hidden", !hasSel);
    if (hasSel) {
      const isTextTarget = Boolean(s.text);
      const canDup = Boolean(isTextTarget || (!s.entry && !s.link && !s.viewer && s.strokes.length));
      const isPdfTarget = Boolean(s.link || s.entry || s.viewer);
      const lay = s.entry ? this.entryLayout(s.entry) : null;
      const canUngroup = Boolean(s.entry && s.entry.page == null && lay && lay.pages.length > 1);

      this.btnEditText.classList.toggle("is-hidden", !isTextTarget);
      this.btnToggleTable.classList.toggle("is-hidden", !isTextTarget);
      if (isTextTarget) {
        this.btnToggleTable.classList.toggle("is-active", Boolean(s.text.table && s.text.table.length));
      }
      this.btnChangePdf.classList.toggle("is-hidden", !isPdfTarget);
      this.btnOpenLink.classList.toggle("is-hidden", !isPdfTarget);
      this.btnDup.classList.toggle("is-hidden", !canDup);
      this.btnUngroup.classList.toggle("is-hidden", !canUngroup);
    }

    const hasSelText = Boolean(s && s.text);
    const showColors = this.tool === "pen" || this.tool === "highlighter" || this.tool === "text" || hasSelText;
    this.styleGroup.classList.toggle("is-hidden", !showColors);
    this.btnStrokePopover.classList.toggle("is-hidden", this.tool === "text" && !hasSelText ? true : false);
    this.colorBox.empty();

    if (showColors) {
      const isHl = this.tool === "highlighter" && !hasSelText;
      const isPen = !isHl;
      const defaults = isPen ? DEFAULT_PEN_COLORS : DEFAULT_HL_COLORS;
      const customs = ((isPen ? this.plugin.settings.customPenColors : this.plugin.settings.customHlColors) || [])
        .filter((c) => !defaults.includes(c.toLowerCase()))
        .slice(-MAX_CUSTOM_COLORS);
      const allColors = [...defaults, ...customs];
      const activeColorSource = hasSelText ? (s.text.color || this.penColor) : (isPen ? this.penColor : this.hlColor);
      const cur = activeColorSource.toLowerCase();
      let isCurrentCustom = false;

      const applyChosenColor = (c) => {
        if (isPen) this.penColor = c; else this.hlColor = c;
        if (this.sel && this.sel.text) {
          const tb = this.sel.text;
          const oldCol = tb.color || "#111111";
          if (oldCol.toLowerCase() !== c.toLowerCase()) {
            tb.color = c;
            this.pushUndo({ t: "textstyle", textBlock: tb, prop: "color", oldVal: oldCol, newVal: c });
            this.syncTextDoms();
            this.requestSave();
          }
        }
      };

      for (const c of allColors) {
        const cLow = c.toLowerCase();
        const isCustom = customs.some((x) => x.toLowerCase() === cLow);
        if (isCustom && cLow === cur) isCurrentCustom = true;

        const sw = this.colorBox.createEl("button", {
          cls: "ink-swatch" + (isCustom ? " is-custom" : ""),
          attr: {
            "aria-label": c,
            title: isCustom
              ? `Eigene Farbe ${c} (× drücken oder 0,5s halten zum Löschen)`
              : c,
          },
        });
        sw.style.background = c;
        if (cLow === cur) sw.classList.add("is-active");

        sw.addEventListener("click", () => {
          applyChosenColor(c);
          this.refreshToolbar();
        });

        if (isCustom) {
          sw.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            this.removeCustomColor(c, isPen);
          });
          let pressTimer = null;
          sw.addEventListener("pointerdown", () => {
            pressTimer = setTimeout(() => {
              pressTimer = null;
              this.removeCustomColor(c, isPen);
            }, 500);
          });
          const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
          sw.addEventListener("pointerup", clearPress);
          sw.addEventListener("pointerleave", clearPress);
          sw.addEventListener("pointercancel", clearPress);
        }
      }

      const pickerWrap = this.colorBox.createDiv({
        cls: "ink-color-picker-wrap",
        attr: { title: `Eigene Farbe hinzufügen (${customs.length}/${MAX_CUSTOM_COLORS})` },
      });
      pickerWrap.createDiv({ cls: "ink-color-picker-btn", text: "+" });
      const colorInp = pickerWrap.createEl("input", {
        cls: "ink-color-input",
        attr: { type: "color", value: cur },
      });
      colorInp.addEventListener("input", () => {
        const val = colorInp.value.toLowerCase();
        applyChosenColor(val);
        this.updateStrokeTriggerPreview();
      });
      colorInp.addEventListener("change", () => {
        const val = colorInp.value.toLowerCase();
        const arr = isPen ? this.plugin.settings.customPenColors : this.plugin.settings.customHlColors;
        const defList = isPen ? DEFAULT_PEN_COLORS : DEFAULT_HL_COLORS;

        applyChosenColor(val);

        if (!defList.includes(val)) {
          const existingIdx = arr.findIndex((x) => x.toLowerCase() === val);
          if (existingIdx >= 0) arr.splice(existingIdx, 1);
          arr.push(val);
          while (arr.length > MAX_CUSTOM_COLORS) arr.shift();
          this.plugin.saveSettings();
        }
        this.refreshToolbar();
      });

      if (isCurrentCustom) {
        const delBtn = this.colorBox.createEl("button", {
          cls: "ink-swatch-del",
          text: "×",
          attr: { title: `Eigene Farbe (${cur}) löschen` },
        });
        delBtn.addEventListener("click", () => this.removeCustomColor(cur, isPen));
      }
      this.updateStrokeTriggerPreview();
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
    this.updateViewersTransform();
    this.updateTextsTransform();
    this.requestDraw();
  }

  /**
   * Schnelle Strich-Invalidierung (v2.2.0):
   * Markiert nur den Statik-Canvas als dirty, OHNE teure DOM-Style-Recalculations
   * (`updateViewersTransform` / `updateTextsTransform`) bei jedem Radier-Frame auszulösen!
   */
  invalidateStrokes() {
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

    for (const lnk of (this.doc.links || [])) {
      const w = lnk.w || CARD_W;
      const h = this.linkHeight(lnk);
      if (lnk.x > vx1 || lnk.x + w < vx0 || lnk.y > vy1 || lnk.y + h < vy0) continue;
      drawPdfLinkCard(ctx, lnk, v.z);
    }

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
    if (sb && !(this.sel && (this.sel.viewer || this.sel.text))) {
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
    if (sb && !(this.sel && (this.sel.viewer || this.sel.text))) {
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

  /* ----- Eingabe & Ultra-flüssiger S-Pen-Radierer (v2.2.0) ----- */
  bindEvents() {
    const c = this.canvas;

    // 1. Native Android TouchEvent-Behandlung (passive: false):
    // - Erkennt Samsung S-Pen TOOL_TYPE_ERASER (toolType === 4 / "eraser").
    // - Ruft `te.preventDefault()` NUR bei aktivem S-Pen-Barrel-Modus auf, damit Android keinen
    //   `StylusTextSelector`-Abbruch auslöst.
    // - WICHTIG (v2.2.0 Performance-Fix): Führt `eraseAtSegment` im Touch-Handler NUR noch als
    //   Fallback aus, falls Android den regulären `pointermove`-Stream per `pointercancel` abgebrochen hat
    //   (`this.pointerCancelledBarrel || now - this.lastPointerMoveTime > 28`). Dadurch wird die dreifache
    //   CPU-Last pro Frame eliminiert!
    const handleTouch = (te) => {
      let foundEraser = false;
      const list = te.touches && te.touches.length ? te.touches : te.changedTouches || [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const tt = t.toolType !== undefined ? t.toolType : "";
        if (tt === "eraser" || tt === 4) {
          foundEraser = true;
          break;
        }
      }
      this.androidTouchEraser = foundEraser;
      this.touchContactActive = Boolean(te.touches && te.touches.length > 0);
      const now = performance.now();

      if (foundEraser) {
        this.lastPen = now;
        this.lastBarrelSignalTime = now;
        this.hoverClearFrames = 0;
        clearTimeout(this.barrelReleaseTimer);
        const p0 = list.length ? this.local(list[0]) : null;
        this.setBarrelHeld(true, p0);
      }

      if (this.barrelHeld || foundEraser || this.contextMenuBarrel) {
        if (te.cancelable) te.preventDefault();
        const needsTouchFallback = this.pointerCancelledBarrel || (now - this.lastPointerMoveTime > 28);
        if (needsTouchFallback && list.length === 1 && this.plugin.settings.penButton !== "off") {
          const t0 = list[0];
          const p = this.local(t0);
          const d = this.toDoc(p);
          this.lastPen = now;
          this.lastBarrelSignalTime = now;
          this.hoverClearFrames = 0;
          clearTimeout(this.barrelReleaseTimer);
          this.setBarrelHeld(true, p);

          if (!this.active) {
            this.startBarrelContactAction(1, p);
          } else if (this.active.kind === "draw") {
            this.switchActiveDrawToBarrel(p);
          } else if (this.active.kind === "erase") {
            this.eraseAtSegment(this.active.lastDoc || d, d, p);
            this.active.lastDoc = d;
          } else if (this.active.kind === "pan" && this.active.viaBarrel) {
            const v = this.doc.view;
            v.x += p.x - this.active.last.x;
            v.y += p.y - this.active.last.y;
            this.active.last = p;
            this.invalidateStatic();
          }
          this.updateDebugHud(
            { pointerType: "pen(touch)", buttons: 2, button: 0, pressure: t0.force || 0.5 },
            this.plugin.settings.penButton
          );
        }
      }
    };
    c.addEventListener("touchstart", handleTouch, { passive: false });
    c.addEventListener("touchmove", handleTouch, { passive: false });
    c.addEventListener("touchend", (te) => {
      this.androidTouchEraser = false;
      this.contextMenuBarrel = false;
      this.touchContactActive = Boolean(te.touches && te.touches.length > 0);
      this.pointerCancelledBarrel = false;
      if (this.active && this.active.viaBarrel) {
        this.finishBarrelAction();
      }
      // v2.2.0 Scrubbing-Fix: Beim kurzen Anheben der Stiftspitze zwischen schnellen Radier-Zügen
      // `barrelHeld` NICHT sofort hart abschalten, sondern über Hover-Events bzw. kurzes Nachlauf-Fenster prüfen!
      if (this.barrelHeld && !this.keyBarrelHeld) {
        this.scheduleBarrelReleaseCheck();
      }
    }, { passive: true });
    c.addEventListener("touchcancel", () => {
      this.androidTouchEraser = false;
      this.contextMenuBarrel = false;
      this.touchContactActive = false;
      this.pointerCancelledBarrel = false;
      if (this.active && this.active.viaBarrel) {
        this.finishBarrelAction();
      }
    }, { passive: true });

    // 2. Contextmenu auf Canvas:
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      const isPenEvent = e.pointerType === "pen" || (now - this.lastPen < 650);

      if (isPenEvent) {
        const dtDown = now - this.lastPenDownTime;
        if (this.barrelHeld || dtDown < 420 || (e.buttons & 2) || (e.buttons & 32) || e.button === 2) {
          this.contextMenuBarrel = true;
          this.lastBarrelSignalTime = now;
          this.hoverClearFrames = 0;
          clearTimeout(this.barrelReleaseTimer);
          const p = this.local(e);
          this.setBarrelHeld(true, p);
          if (this.active && this.active.kind === "draw") {
            this.switchActiveDrawToBarrel(p);
          } else if (!this.active && this.plugin.settings.penButton !== "off") {
            this.startBarrelContactAction(e.pointerId || 1, p);
          }
        }
        return;
      }

      // Maus-Rechtsklick auf ein Element auf der Leinwand -> Kontextmenü
      const p = this.local(e);
      const d = this.toDoc(p);
      const hitTb = this.hitText(d);
      if (hitTb) {
        this.sel = { entry: null, link: null, viewer: null, text: hitTb, strokes: [] };
        this.refreshToolbar();
        this.updateTextsTransform();
        this.requestDraw();
        const menu = new Menu();
        menu.addItem((mi) =>
          mi.setTitle("Text bearbeiten").setIcon("edit-3").onClick(() => this.focusTextDom(hitTb.id, false))
        );
        menu.addItem((mi) =>
          mi
            .setTitle(hitTb.table ? "Tabelle entfernen" : "Tabelle hinzufügen")
            .setIcon("table")
            .onClick(() => {
              const oldTbl = cloneTable(hitTb.table);
              hitTb.table = hitTb.table ? null : [["Spalte 1", "Spalte 2"], ["", ""]];
              this.pushUndo({ t: "texttable", textBlock: hitTb, oldTable: oldTbl, newTable: cloneTable(hitTb.table) });
              this.syncTextDoms();
              this.changed();
            })
        );
        menu.addItem((mi) =>
          mi.setTitle("Duplizieren").setIcon("copy").onClick(() => this.duplicateSelection())
        );
        menu.addSeparator();
        menu.addItem((mi) =>
          mi.setTitle("Textblock löschen").setIcon("trash-2").onClick(() => this.deleteSelection())
        );
        menu.showAtMouseEvent(e);
        return;
      }

      const hitLnk = this.hitLink(d);
      const hitP = !hitLnk ? this.hitPdf(d) : null;
      if (hitLnk || hitP) {
        const target = hitLnk || hitP;
        const targetType = hitLnk ? "link" : "entry";
        this.sel = {
          entry: hitP || null,
          link: hitLnk || null,
          viewer: null,
          text: null,
          strokes: hitP ? this.strokesInEntry(hitP) : [],
        };
        this.refreshToolbar();
        this.requestDraw();
        const menu = new Menu();
        menu.addItem((mi) =>
          mi
            .setTitle("Eingebettete PDF-Datei ändern …")
            .setIcon("refresh-cw")
            .onClick(() => this.changePdfFile(target, targetType))
        );
        menu.addItem((mi) =>
          mi
            .setTitle("PDF in neuem Tab öffnen")
            .setIcon("external-link")
            .onClick(() => this.openPdfLink(target))
        );
        menu.addSeparator();
        menu.addItem((mi) =>
          mi
            .setTitle("Auswahl löschen")
            .setIcon("trash-2")
            .onClick(() => this.deleteSelection())
        );
        menu.showAtMouseEvent(e);
      }
    });

    // 3. KeyEvent-Detektor (falls Samsung/Android F20/F21/Eraser sendet)
    this._keyDownHandler = (ke) => {
      if (ke.key === "F20" || ke.key === "F21" || ke.code === "Eraser") {
        this.keyBarrelHeld = true;
        this.lastBarrelSignalTime = performance.now();
        this.hoverClearFrames = 0;
        clearTimeout(this.barrelReleaseTimer);
        this.setBarrelHeld(true);
        if (this.active && this.active.kind === "draw") {
          this.switchActiveDrawToBarrel();
        }
      }
    };
    this._keyUpHandler = (ke) => {
      if (ke.key === "F20" || ke.key === "F21" || ke.code === "Eraser") {
        this.keyBarrelHeld = false;
        this.setBarrelHeld(false);
      }
    };
    window.addEventListener("keydown", this._keyDownHandler, true);
    window.addEventListener("keyup", this._keyUpHandler, true);

    // 4. Low-Level pointerrawupdate:
    // - Erkennt den S-Pen-Seitentasten-Zustand sofort mit 0ms Verzögerung.
    // - Führt Radier-Segmente nur dann direkt aus, wenn `pointermove` durch Androids `pointercancel`
    //   unterbrochen wurde (`this.pointerCancelledBarrel`), sodass `pointermove` und `pointerrawupdate`
    //   niemals doppelt pro Frame rechnen!
    c.addEventListener("pointerrawupdate", (e) => {
      const isPen = e.pointerType === "pen" || this.androidTouchEraser;
      if (!isPen) return;
      const now = performance.now();
      this.lastPen = now;
      const p = this.local(e);
      const penOverride = this.resolvePenAction(e, p);
      if (penOverride) {
        this.updateDebugHud(e, penOverride);
        if (this.active && this.active.kind === "draw") {
          this.switchActiveDrawToBarrel(p);
          return;
        }
        const needsRawFallback = this.pointerCancelledBarrel || (now - this.lastPointerMoveTime > 28);
        if (needsRawFallback && ((e.pressure || 0) > 0 || this.touchContactActive)) {
          const d = this.toDoc(p);
          if (!this.active) {
            this.startBarrelContactAction(e.pointerId, p);
          } else if (this.active.kind === "erase") {
            this.eraseAtSegment(this.active.lastDoc || d, d, p);
            this.active.lastDoc = d;
          } else if (this.active.kind === "pan" && this.active.viaBarrel) {
            const v = this.doc.view;
            v.x += p.x - this.active.last.x;
            v.y += p.y - this.active.last.y;
            this.active.last = p;
            this.invalidateStatic();
          }
        }
      }
    });

    // 5. Reguläre PointerEvents
    c.addEventListener("pointerdown", (e) => this.onDown(e));
    c.addEventListener("pointermove", (e) => this.onMove(e));
    c.addEventListener("pointerup", (e) => this.onUp(e, false));
    c.addEventListener("pointercancel", (e) => this.onUp(e, true));
    c.addEventListener("pointerleave", () => {
      this.androidTouchEraser = false;
      this.keyBarrelHeld = false;
      this.contextMenuBarrel = false;
      this.touchContactActive = false;
      this.pointerCancelledBarrel = false;
      this.hoverBtn1Frames = 0;
      clearTimeout(this.barrelReleaseTimer);
      this.setBarrelHeld(false);
      if (this.eraserPos && !this.active) { this.eraserPos = null; this.requestDraw(); }
    });
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("auxclick", (e) => e.preventDefault());
    c.addEventListener("selectstart", (e) => e.preventDefault());
  }

  scheduleBarrelReleaseCheck() {
    clearTimeout(this.barrelReleaseTimer);
    this.lastBarrelLiftTime = performance.now();
    this.barrelReleaseTimer = setTimeout(() => {
      if (!this.touchContactActive && !this.keyBarrelHeld && (!this.active || !this.active.viaBarrel)) {
        if (performance.now() - this.lastBarrelSignalTime > 160) {
          this.setBarrelHeld(false);
        }
      }
    }, 220);
  }

  setBarrelHeld(held, p) {
    const next = Boolean(held && this.plugin.settings.penButton !== "off");
    if (next) clearTimeout(this.barrelReleaseTimer);
    if (this.barrelHeld === next) {
      if (next && p && this.plugin.settings.penButton === "eraser") {
        this.eraserPos = p;
        this.requestDraw();
      }
      return;
    }
    this.barrelHeld = next;
    if (!next) {
      this.contextMenuBarrel = false;
      this.contactHasBarrelBit = false;
      this.pointerCancelledBarrel = false;
      this.hoverBtn1Frames = 0;
      if (this.active && this.active.viaBarrel) {
        this.finishBarrelAction();
      }
      if (this.tool !== "eraser" && this.eraserPos) {
        this.eraserPos = null;
        this.requestDraw();
      }
    } else if (p && this.plugin.settings.penButton === "eraser") {
      this.eraserPos = p;
      this.requestDraw();
    }
    this.updateTextsTransform();
    this.refreshToolbar();
  }

  finishBarrelAction() {
    const a = this.active;
    if (!a || !a.viaBarrel) return;
    this.active = null;
    if (!this.barrelHeld && this.tool !== "eraser") {
      this.eraserPos = null;
    }
    if (this.viewersLayer) this.viewersLayer.classList.remove("is-drawing-active");
    if (a.kind === "erase" && a.removed && a.removed.length) {
      this.pushUndo({ t: "del", items: a.removed });
      this.requestSave();
      this.refreshToolbar();
      this.requestDraw();
    } else {
      this.requestDraw();
    }
  }

  startBarrelContactAction(pointerId, p, replayPts) {
    const st = this.plugin.settings;
    if (st.penButton === "off") return;
    const d = this.toDoc(p);
    if (this.viewersLayer) this.viewersLayer.classList.add("is-drawing-active");
    if (st.penButton === "eraser") {
      const prevRemoved = (this.active && this.active.kind === "erase") ? this.active.removed : [];
      this.active = { id: pointerId, kind: "erase", pen: true, viaBarrel: true, removed: prevRemoved, lastDoc: d, lastScreen: p };
      if (Array.isArray(replayPts) && replayPts.length > 0) {
        let prev = { x: replayPts[0][0], y: replayPts[0][1] };
        for (let i = 0; i < replayPts.length; i++) {
          const cur = { x: replayPts[i][0], y: replayPts[i][1] };
          this.eraseAtSegment(prev, cur, p);
          prev = cur;
        }
        this.eraseAtSegment(prev, d, p);
      } else {
        this.eraseAtSegment(d, d, p);
      }
    } else if (st.penButton === "pan") {
      this.active = { id: pointerId, kind: "pan", pen: true, viaBarrel: true, last: p };
    }
  }

  /**
   * v2.2.0: Wenn Android das Seitentasten-Signal (z. B. `contextmenu` oder `buttons: 2`) erst 10-40ms
   * nach dem Aufsetzen der Stiftspitze nachreicht, verwirft `switchActiveDrawToBarrel` nicht nur den
   * versehentlich begonnenen Strich, sondern radiert rückwirkend entlang der bereits zurückgelegten
   * Punkte (`replayPts`), sodass sich der Radierer ab dem ersten Millimeter absolut direkt anfühlt!
   */
  switchActiveDrawToBarrel(fallbackPos) {
    const st = this.plugin.settings;
    if (st.penButton === "off") return;
    const p = fallbackPos || this.eraserPos || this.holdAnchor || { x: 0, y: 0 };
    const ptrId = this.active ? this.active.id : 1;
    let replayPts = null;

    if (this.active && this.active.kind === "draw") {
      clearTimeout(this.holdTimer);
      const isTinyStart = (performance.now() - this.active.t0 < 280) ||
        (this.cur && this.cur.points.length < 24);

      if (!isTinyStart && this.cur && this.cur.points.length > 1) {
        this.doc.strokes.push(this.cur);
        this.pushUndo({ t: "add", s: this.cur });
        this.appendStrokeToStatic(this.cur);
        this.requestSave();
      } else if (this.cur && this.cur.points.length > 0) {
        replayPts = this.cur.points.slice();
      }
      this.cur = null;
      this.predicted = [];
      this.snapped = null;
    }

    this.setBarrelHeld(true, p);
    this.startBarrelContactAction(ptrId, p, replayPts);
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

  updateBarrelState(e, p) {
    const isPen = e.pointerType === "pen" || this.androidTouchEraser;
    if (!isPen) return false;
    if (this.plugin.settings.penButton === "off") {
      if (this.barrelHeld) this.setBarrelHeld(false);
      return false;
    }

    const b = e.buttons || 0;
    const btn = e.button;
    const pr = e.pressure || 0;
    const now = performance.now();

    const explicitBit = Boolean(
      (b & 2) ||
      (b & 4) ||
      (b & 32) ||
      btn === 2 ||
      btn === 5 ||
      this.androidTouchEraser ||
      this.keyBarrelHeld
    );

    const notNormalDraw = !this.active || this.active.viaBarrel;
    // v2.2.0: Sofortige 1-Frame-Erkennung, wenn im Hover `pr === 0 && b === 1` anliegt!
    if (notNormalDraw && pr === 0 && b === 1 && !explicitBit) {
      this.hoverBtn1Frames++;
    } else if (pr === 0 && b === 0) {
      this.hoverBtn1Frames = 0;
    }
    const isHoverButton1 = this.hoverBtn1Frames >= 1;
    const hasSignal = explicitBit || isHoverButton1 || this.contextMenuBarrel;

    if (hasSignal) {
      this.lastBarrelSignalTime = now;
      this.hoverClearFrames = 0;
      if (((b & 2) || (b & 4) || (b & 32)) && pr > 0) {
        this.contactHasBarrelBit = true;
      }
      this.setBarrelHeld(true, p);
      return true;
    }

    // Stift schwebt ohne gedrückte Taste in der Luft (pr === 0 und b === 0)
    if (pr === 0 && b === 0 && !this.touchContactActive) {
      this.contextMenuBarrel = false;
      this.hoverBtn1Frames = 0;
      this.hoverClearFrames++;
      if (this.hoverClearFrames >= 2 || now - this.lastBarrelSignalTime > 120) {
        this.setBarrelHeld(false);
      }
      return this.barrelHeld;
    }

    // Stift setzt auf oder bewegt sich auf dem Display, während barrelHeld aktiv ist
    if (this.barrelHeld) {
      const isMoveEv = e.type === "pointermove" || e.type === "pointerrawupdate";
      if (isMoveEv && this.contactHasBarrelBit && b === 1 && pr > 0) {
        this.hoverClearFrames++;
        if (this.hoverClearFrames >= 3) {
          this.setBarrelHeld(false);
          return false;
        }
      } else {
        this.hoverClearFrames = 0;
      }
      this.lastBarrelSignalTime = now;
      this.setBarrelHeld(true, p);
      return true;
    }

    return false;
  }

  resolvePenAction(e, p) {
    const mode = this.plugin.settings.penButton;
    if (mode === "off") return null;
    if (this.updateBarrelState(e, p)) return mode;
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
      `pressure=${r2(e.pressure || 0)} | sideBtn=${this.barrelHeld ? "GEHALTEN" : "losgelassen"} | tool=${action || this.tool}`;
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
    if (this.viewersLayer) this.viewersLayer.classList.remove("is-drawing-active");
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
    const isPen = e.pointerType === "pen" || this.androidTouchEraser;
    if (!isPen) e.preventDefault();

    const p = this.local(e);
    const d = this.toDoc(p);
    this.pointerCancelledBarrel = false;

    if (isPen) {
      const now = performance.now();
      this.lastPen = now;
      this.lastPenDownTime = now;
      this.lastPointerMoveTime = now;
      if (this.active && !this.active.pen) {
        this.cancelActive();
      }
      this.touches.clear();
      this.multiTap = null;
    }

    const penOverride = isPen ? this.resolvePenAction(e, p) : null;
    if (isPen) this.updateDebugHud(e, penOverride);

    if (!isPen || (!penOverride && !this.barrelHeld && (e.pressure || 0) > 0)) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* */ }
    } else {
      try {
        if (this.canvas.hasPointerCapture && this.canvas.hasPointerCapture(e.pointerId)) {
          this.canvas.releasePointerCapture(e.pointerId);
        }
      } catch (err) { /* */ }
    }

    // Direkt-Buttons auf PDF-Anhang-Karten
    if (this.getEffectiveTool() !== "eraser") {
      const changeBtnHit = this.hitLinkChangeButton(d);
      if (changeBtnHit) {
        this.sel = { entry: null, link: changeBtnHit, viewer: null, text: null, strokes: [] };
        this.refreshToolbar();
        this.requestDraw();
        this.changePdfFile(changeBtnHit, "link");
        return;
      }
      const openBtnHit = this.hitLinkOpenButton(d);
      if (openBtnHit) {
        this.openPdfLink(openBtnHit);
        return;
      }
    }

    if (e.pointerType === "touch" && !this.androidTouchEraser && !this.barrelHeld) {
      if (this.penBusy()) return;
      this.touches.set(e.pointerId, p);
      const count = this.touches.size;

      if (count === 1) {
        this.multiTap = { maxTouches: 1, t0: performance.now(), moved: false, startPts: new Map([[e.pointerId, p]]) };
      } else if (this.multiTap) {
        this.multiTap.maxTouches = Math.max(this.multiTap.maxTouches, count);
        this.multiTap.startPts.set(e.pointerId, p);
      }

      // Im Textblock-Werkzeug erzeugt auch ein kurzes 1-Finger-Tippen auf die Leinwand ein Textfeld!
      if (count === 1 && this.tool === "text") {
        const hitTb = this.hitText(d);
        if (hitTb) {
          this.sel = { entry: null, link: null, viewer: null, text: hitTb, strokes: [] };
          this.refreshToolbar();
          this.updateTextsTransform();
          this.focusTextDom(hitTb.id, false);
        } else {
          this.addTextBlock(d.x, d.y, false);
        }
        return;
      }

      if (count >= 2 || !this.plugin.settings.fingerDraws) {
        this.cancelActive();
        this.gest = this.gestureState();
        return;
      }
    }

    // S-Pen-Seitentaste gedrückt -> Sofort Radierer/Pan starten oder fortsetzen
    if (penOverride || (this.barrelHeld && this.plugin.settings.penButton !== "off")) {
      this.blurAllTexts();
      if (this.active && this.active.kind === "draw") {
        this.switchActiveDrawToBarrel(p);
      } else if (this.active && this.active.viaBarrel) {
        this.active.id = e.pointerId;
        if (this.active.kind === "erase") {
          this.eraseAtSegment(this.active.lastDoc || d, d, p);
          this.active.lastDoc = d;
          this.active.lastScreen = p;
        } else if (this.active.kind === "pan") {
          this.active.last = p;
        }
      } else {
        this.startBarrelContactAction(e.pointerId, p);
      }
      return;
    }

    if (this.active) {
      return;
    }

    if (e.pointerType === "mouse" && e.button !== 0) {
      this.active = { id: e.pointerId, kind: "pan", last: p };
      return;
    }

    let tool = this.tool;

    // Textblock-Werkzeug: Klick/Tap auf die Leinwand erzeugt sofort ein neues Textfeld zum Tippen
    if (tool === "text") {
      const hitTb = this.hitText(d);
      if (hitTb) {
        this.sel = { entry: null, link: null, viewer: null, text: hitTb, strokes: [] };
        this.refreshToolbar();
        this.updateTextsTransform();
        this.focusTextDom(hitTb.id, false);
      } else {
        this.addTextBlock(d.x, d.y, false);
      }
      return;
    }

    this.blurAllTexts();
    if (this.viewersLayer) this.viewersLayer.classList.add("is-drawing-active");

    if (tool === "move" || tool === "lasso") {
      const now = performance.now();
      const isDoubleTap = (now - this.lastTapTime < 360) &&
        this.lastTapPos && Math.hypot(p.x - this.lastTapPos.x, p.y - this.lastTapPos.y) < 22;

      const hitTb = this.hitText(d);
      if (hitTb && isDoubleTap) {
        this.sel = { entry: null, link: null, viewer: null, text: hitTb, strokes: [] };
        this.lastTapTime = 0;
        if (this.viewersLayer) this.viewersLayer.classList.remove("is-drawing-active");
        this.refreshToolbar();
        this.updateTextsTransform();
        this.focusTextDom(hitTb.id, false);
        return;
      }

      const hitLnk = this.hitLink(d);
      if (hitLnk && isDoubleTap) {
        this.openPdfLink(hitLnk);
        this.lastTapTime = 0;
        if (this.viewersLayer) this.viewersLayer.classList.remove("is-drawing-active");
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
        if (hitTb) {
          this.sel = { entry: null, link: null, viewer: null, text: hitTb, strokes: [] };
          this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: null, link: null, viewer: null, text: hitTb, strokes: [], dx: 0, dy: 0 };
        } else if (hitLnk) {
          this.sel = { entry: null, link: hitLnk, viewer: null, text: null, strokes: [] };
          this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: null, link: hitLnk, viewer: null, text: null, strokes: [], dx: 0, dy: 0 };
        } else {
          const hit = this.hitPdf(d);
          if (hit) {
            this.sel = { entry: hit, link: null, viewer: null, text: null, strokes: this.strokesInEntry(hit) };
            this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: hit, link: null, viewer: null, text: null, strokes: this.sel.strokes, dx: 0, dy: 0 };
          } else {
            const hitS = this.hitSingleStroke(d);
            if (hitS) {
              this.sel = { entry: null, link: null, viewer: null, text: null, strokes: [hitS] };
              this.active = { id: e.pointerId, kind: "drag", pen: isPen, last: d, entry: null, link: null, viewer: null, text: null, strokes: [hitS], dx: 0, dy: 0 };
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
            entry: this.sel.entry, link: this.sel.link, viewer: this.sel.viewer, text: this.sel.text, strokes: this.sel.strokes, dx: 0, dy: 0,
          };
        } else {
          this.sel = null;
          this.lasso = { pts: [[d.x, d.y]], startScreen: p };
          this.active = { id: e.pointerId, kind: "lasso", pen: isPen, last: p };
        }
      }
      this.refreshToolbar();
      this.updateViewersTransform();
      this.updateTextsTransform();
      this.requestDraw();
      return;
    }

    if (tool === "eraser") {
      this.active = {
        id: e.pointerId,
        kind: "erase",
        pen: isPen,
        viaBarrel: false,
        removed: [],
        lastDoc: d,
        lastScreen: p,
      };
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
    const now = performance.now();
    if (isPen) {
      this.lastPen = now;
      this.lastPointerMoveTime = now;
    }
    const p = this.local(e);
    const d = this.toDoc(p);

    if (isPen || (this.barrelHeld && this.plugin.settings.penButton !== "off")) {
      const penOverride = isPen
        ? this.resolvePenAction(e, p)
        : (this.barrelHeld ? this.plugin.settings.penButton : null);
      if (isPen) this.updateDebugHud(e, penOverride);

      if (penOverride) {
        if (this.active && this.active.kind === "draw") {
          this.switchActiveDrawToBarrel(p);
          return;
        }
        if (!this.active && ((e.pressure || 0) > 0 || (e.buttons || 0) > 0 || this.touchContactActive)) {
          this.startBarrelContactAction(e.pointerId, p);
          return;
        }
      } else {
        if (this.active && this.active.viaBarrel) {
          this.finishBarrelAction();
        }
        if (!this.active) {
          if (this.tool === "eraser") {
            this.eraserPos = p;
            this.requestDraw();
          } else if (this.eraserPos) {
            this.eraserPos = null;
            this.requestDraw();
          }

          if ((e.buttons & 1) && (e.pressure || 0) > 0 && (this.tool === "pen" || this.tool === "highlighter")) {
            const pr = this.pressure(e);
            if (this.viewersLayer) this.viewersLayer.classList.add("is-drawing-active");
            this.cur = {
              tool: this.tool,
              color: this.tool === "pen" ? this.penColor : this.hlColor,
              width: this.width,
              points: [[d.x, d.y, pr]],
            };
            this.predicted = [];
            this.sm = { x: d.x, y: d.y, p: pr };
            this.rawLast = { x: d.x, y: d.y, p: pr };
            this.snapped = null;
            this.holdAnchor = p;
            this.active = { id: e.pointerId, kind: "draw", pen: true, t0: now, startScreen: p };
            this.armHold();
            this.requestDraw();
            return;
          }
        }
      }
    }

    if (e.pointerType === "touch" && !this.androidTouchEraser && !this.barrelHeld && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p);
      if (this.multiTap && !this.multiTap.moved) {
        const s0 = this.multiTap.startPts.get(e.pointerId);
        if (s0 && Math.hypot(p.x - s0.x, p.y - s0.y) > 14) this.multiTap.moved = true;
      }
      if (this.touches.size >= 2 || !this.plugin.settings.fingerDraws) {
        e.preventDefault();
        if (!this.multiTap || this.multiTap.moved || now - this.multiTap.t0 > 180) {
          this.applyGesture();
        }
        return;
      }
    }

    const a = this.active;
    if (!a) return;
    if (a.id !== e.pointerId && !a.viaBarrel) return;
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
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const list = evs.length ? evs : [e];
      for (const ev of list) {
        const lp = this.local(ev);
        const ld = this.toDoc(lp);
        this.eraseAtSegment(a.lastDoc || ld, ld, lp);
        a.lastDoc = ld;
        a.lastScreen = lp;
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
      if (a.viewer) { a.viewer.x += dx; a.viewer.y += dy; this.updateViewersTransform(); }
      if (a.text) { a.text.x += dx; a.text.y += dy; this.updateTextsTransform(); }
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
    const isPen = e.pointerType === "pen" || this.androidTouchEraser;
    if (isPen) {
      this.lastPen = performance.now();
    }

    if (e.pointerType === "touch" && !this.androidTouchEraser && !this.barrelHeld) {
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

    // Falls Android wegen gedrückter S-Pen-Seitentaste ein künstliches pointercancel feuert:
    // `pointerCancelledBarrel = true` markieren, damit `touchmove`/`pointerrawupdate` den Radierer
    // ohne jede Unterbrechung weiterführen!
    if (cancelled && (isPen || this.barrelHeld) && (this.barrelHeld || this.contextMenuBarrel)) {
      this.pointerCancelledBarrel = true;
      if (this.active && this.active.kind === "draw") {
        this.switchActiveDrawToBarrel(this.local(e));
      } else if (!this.active && this.plugin.settings.penButton !== "off") {
        this.startBarrelContactAction(e.pointerId || 1, this.local(e));
      }
      return;
    }

    if (isPen && !cancelled) {
      this.androidTouchEraser = false;
      this.keyBarrelHeld = false;
      this.contextMenuBarrel = false;
      this.touchContactActive = false;
      this.pointerCancelledBarrel = false;
      // v2.2.0 Scrubbing-Fix: Beim Anheben der Stiftspitze nach einem Radier-Zug NICHT sofort
      // `setBarrelHeld(false)` erzwingen, sondern über die nachfolgenden Hover-Events (bzw. Timer)
      // prüfen, ob die Seitentaste noch gedrückt gehalten wird!
      if (this.barrelHeld) {
        this.scheduleBarrelReleaseCheck();
      }
      this.updateDebugHud(e, this.barrelHeld ? this.plugin.settings.penButton : null);
    }

    const a = this.active;
    if (!a || (a.id !== e.pointerId && !a.viaBarrel)) return;
    clearTimeout(this.holdTimer);
    this.active = null;
    if (!this.barrelHeld && this.tool !== "eraser") {
      this.eraserPos = null;
    }
    this.predicted = [];
    if (this.viewersLayer) this.viewersLayer.classList.remove("is-drawing-active");

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
        this.requestSave();
        this.refreshToolbar();
      }
    } else if (a.kind === "drag") {
      if (a.dx || a.dy) {
        this.pushUndo({ t: "move", entry: a.entry, link: a.link, viewer: a.viewer, text: a.text, strokes: a.strokes, dx: a.dx, dy: a.dy });
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
      const hitTb = this.hitText(d);
      if (hitTb) {
        this.sel = { entry: null, link: null, viewer: null, text: hitTb, strokes: [] };
      } else {
        const hitL = this.hitLink(d);
        if (hitL) {
          this.sel = { entry: null, link: hitL, viewer: null, text: null, strokes: [] };
        } else {
          const hitS = this.hitSingleStroke(d);
          if (hitS) {
            this.sel = { entry: null, link: null, viewer: null, text: null, strokes: [hitS] };
          } else {
            const hitP = this.hitPdf(d);
            if (hitP) this.sel = { entry: hitP, link: null, viewer: null, text: null, strokes: this.strokesInEntry(hitP) };
          }
        }
      }
      this.refreshToolbar();
      this.updateViewersTransform();
      this.updateTextsTransform();
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
      if (picked.length) this.sel = { entry: null, link: null, viewer: null, text: null, strokes: picked };
    }
    this.refreshToolbar();
    this.updateViewersTransform();
    this.updateTextsTransform();
  }

  /**
   * v2.2.0: Hochgeschwindigkeits-Radierer mit geschwindigkeitsabhängiger Radius-Anpassung
   * und entkoppeltem `invalidateStrokes()` (kein DOM-Layout-Stall während des Radierens).
   */
  eraseAtSegment(d0, d1, p) {
    const z = this.doc.view.z;
    const screenDist = Math.hypot((d1.x - d0.x) * z, (d1.y - d0.y) * z);
    const speedBoost = clamp(1 + screenDist / 90, 1, 1.35);
    const r = (ERASER_R * speedBoost) / z;
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
        if (this.active && this.active.removed) {
          this.active.removed.push({ s, i });
        }
        hitAny = true;
      }
    }
    this.eraserPos = p;
    if (hitAny) this.invalidateStrokes();
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
    for (const vw of (this.doc.viewers || [])) {
      const d = this.docs.get(vw.path);
      const vwW = vw.w || VIEWER_W, vwH = vw.h || VIEWER_H;
      ctx.fillStyle = "#f1f5f9";
      ctx.fillRect(vw.x, vw.y, vwW, vwH);
      if (d && d.pdf) {
        const pgIdx = clamp(vw.page || 0, 0, d.asp.length - 1);
        const pg = await d.pdf.getPage(pgIdx + 1);
        const vp0 = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: ((vwW - 24) * s) / vp0.width });
        const tmp = document.createElement("canvas");
        tmp.width = Math.max(1, Math.ceil(vp.width));
        tmp.height = Math.max(1, Math.ceil(vp.height));
        await pg.render({ canvasContext: tmp.getContext("2d"), canvas: tmp, viewport: vp }).promise;
        const fullPageH = (vwW - 24) * (d.asp[pgIdx] || 1.414);
        const drawH = Math.min(vwH - 52, fullPageH);
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height * (drawH / fullPageH), vw.x + 12, vw.y + 44, vwW - 24, drawH);
      }
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 2;
      ctx.strokeRect(vw.x, vw.y, vwW, vwH);
    }
    for (const lnk of (this.doc.links || [])) {
      drawPdfLinkCard(ctx, lnk, s);
    }
    for (const tb of (this.doc.texts || [])) {
      drawTextBlockOnCanvas(ctx, tb);
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
      .setName("S-Pen-Seitentaste (gedrückt halten)")
      .setDesc("Solange der seitliche Knopf am S Pen gedrückt gehalten wird, wird diese Aktion aktiviert; beim Loslassen wechselt das Plugin automatisch zurück zum vorher benutzten Stift.")
      .addDropdown((d) => {
        d.addOption("eraser", "Radierer (beim Loslassen zurück zum Stift)");
        d.addOption("pan", "Leinwand verschieben");
        d.addOption("off", "Deaktiviert (immer normal schreiben)");
        d.setValue(st.penButton).onChange(async (v) => {
          st.penButton = v; await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("Mit Finger zeichnen")
      .setDesc("Aus: Finger verschiebt/zoomt die Leinwand, nur der S Pen schreibt (empfohlen auf dem Galaxy Tab).")
      .addToggle((t) => t.setValue(st.fingerDraws).onChange(async (v) => {
        st.fingerDraws = v; await this.plugin.saveSettings();
      }));
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
      .setName("Eigene Farben (Fav-5-Stack) zurücksetzen")
      .setDesc("Löscht alle gespeicherten eigenen Stift- und Textmarker-Farben.")
      .addButton((b) => b.setButtonText("Alle löschen").onClick(async () => {
        st.customPenColors = [];
        st.customHlColors = [];
        await this.plugin.saveSettings();
        const v = this.plugin.getActiveInk();
        if (v) v.refreshToolbar();
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
    new Setting(containerEl)
      .setName("Live-Tasten-Diagnose (unten links)")
      .setDesc("Zeigt unten links auf der Leinwand live alle Signale des S Pen an.")
      .addToggle((t) => t.setValue(st.penButtonDebug).onChange(async (v) => {
        st.penButtonDebug = v; await this.plugin.saveSettings();
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
      callback: () => this.pickPdf((f) => this.createNote(f, "printout")),
    });
    this.addCommand({
      id: "insert-text-block",
      name: "Textblock zum Tippen in Handschrift-Notiz einfügen",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) {
          v.setTool("text");
          v.addTextBlock(null, null, false);
        }
        return true;
      },
    });
    this.addCommand({
      id: "insert-table-block",
      name: "Textblock mit Tabelle in Handschrift-Notiz einfügen",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) {
          v.setTool("text");
          v.addTextBlock(null, null, true);
        }
        return true;
      },
    });
    this.addCommand({
      id: "insert-pdf-viewer",
      name: "PDF als scrollbares Viewer-Fenster in Handschrift-Notiz einbetten",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) this.pickPdf((f) => v.addPdfViewer(f));
        return true;
      },
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
      id: "change-embedded-pdf",
      name: "Eingebettete PDF-Datei in Handschrift-Notiz ändern / austauschen",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) v.changeSelectedPdf();
        return true;
      },
    });
    this.addCommand({
      id: "toggle-eraser",
      name: "Handschrift: Zwischen Stift und Radierer wechseln",
      checkCallback: (checking) => {
        const v = this.getActiveInk();
        if (!v) return false;
        if (!checking) v.setTool(v.tool === "eraser" ? "pen" : "eraser");
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
        menu.addItem((i) => i.setTitle("In Handschrift-Notiz als Viewer-Fenster einbetten").setIcon("layout-panel-left").onClick(() => this.createNote(file, "viewer")));
        menu.addItem((i) => i.setTitle("Mit Handschrift beschriften (Ausdruck)").setIcon("pencil").onClick(() => this.createNote(file, "printout")));
        menu.addItem((i) => i.setTitle("In Handschrift-Notiz als Anhang verknüpfen").setIcon("paperclip").onClick(() => this.createNote(file, "link")));
      }
    }));

    this.addSettingTab(new InkSettingTab(this.app, this));
  }

  getActiveInk() {
    const v = this.app.workspace.getActiveViewOfType(TextFileView);
    return v instanceof InkView ? v : null;
  }

  pickPdf(cb, placeholder) {
    new PdfSuggestModal(this.app, cb, placeholder).open();
  }

  async createNote(pdfFile, mode = "printout") {
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
      if (mode === "viewer") await leaf.view.addPdfViewer(pdfFile);
      else if (mode === "link") leaf.view.addPdfLink(pdfFile);
      else await leaf.view.addPdf(pdfFile);
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    delete this.settings.penEraserEnd;
    if (!Array.isArray(this.settings.customPenColors)) this.settings.customPenColors = [];
    if (!Array.isArray(this.settings.customHlColors)) this.settings.customHlColors = [];
    this.settings.customPenColors = this.settings.customPenColors.slice(-MAX_CUSTOM_COLORS);
    this.settings.customHlColors = this.settings.customHlColors.slice(-MAX_CUSTOM_COLORS);
  }
  async saveSettings() { await this.saveData(this.settings); }
}

InkPlugin._test = { recognizeShape, rdp, scaleStrokes, pointInPoly, shiftStrokes, strokeHitSegment, segSegDistSq };
module.exports = InkPlugin;
