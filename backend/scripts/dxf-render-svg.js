/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const DxfParser = require('dxf-parser');

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function hexToRgb(hex) {
  const h = String(hex || '').trim().toLowerCase();
  const m = /^#([0-9a-f]{6})$/.exec(h);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const to2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

// DXF drawings often use grey/black layer colors intended for a white background.
// On our dark canvas those become hard to see, so force them to white.
function brightenForDark(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const grayish = (max - min) <= 24;

  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  // Force grey-ish (incl. black) to white, and also any *very dark* color to white.
  if (grayish && lum < 0.98) return '#ffffff';
  if (lum < 0.18) return '#ffffff';
  return hex;
}

function aciToHex(aci) {
  switch (Number(aci)) {
    case 1: return '#ff0000';
    case 2: return '#ffff00';
    case 3: return '#00ff00';
    case 4: return '#00ffff';
    case 5: return '#0000ff';
    case 6: return '#ff00ff';
    case 7: return '#ffffff';
    case 8: return '#ffffff'; // force white for dark background
    case 9: return '#ffffff'; // force white for dark background
    default: return '#ffffff';
  }
}

function layerColor(doc, layerName) {
  if (!layerName) return null;
  const layers = doc?.tables?.layer?.layers;
  if (!layers) return null;

  if (Array.isArray(layers)) {
    const hit = layers.find((l) => l?.name === layerName);
    return hit?.colorNumber ?? hit?.color ?? null;
  }

  if (typeof layers === 'object') {
    const hit = layers[layerName];
    return hit?.colorNumber ?? hit?.color ?? null;
  }

  return null;
}

function entityHex(doc, ent) {
  const trueColor = ent?.trueColor ?? ent?.truecolor ?? ent?.rgb;
  if (trueColor !== undefined && trueColor !== null) {
    const n = Number(trueColor);
    if (Number.isFinite(n) && n >= 0) {
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return brightenForDark(
        `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
        .toString(16)
        .padStart(2, '0')}`
      );
    }
  }

  const byEntity = Number(ent?.colorNumber ?? ent?.color);
  if (Number.isFinite(byEntity) && byEntity > 0 && byEntity !== 256) return brightenForDark(aciToHex(byEntity));

  const byLayer = Number(layerColor(doc, ent?.layer));
  if (Number.isFinite(byLayer) && byLayer > 0) return brightenForDark(aciToHex(byLayer));

  return brightenForDark(aciToHex(7));
}

function toPoint(p) {
  if (!p) return null;
  if (Array.isArray(p) && p.length >= 2) {
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }
  const x = Number(p.x);
  const y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// 2D affine matrix, SVG-compatible: [a c e; b d f; 0 0 1]
function matIdentity() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function matMul(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function matTranslate(tx, ty) {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function matScale(sx, sy) {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

function matRotate(rad) {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function applyMat(pt, m) {
  return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
}

function bboxInit() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function bboxAdd(b, p) {
  if (!p) return;
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

function approxBulgePoints(v1, v2, bulge, steps = 64) {
  const p1 = toPoint(v1);
  const p2 = toPoint(v2);
  const b = Number(bulge);
  if (!p1 || !p2 || !Number.isFinite(b) || b === 0) return [p1, p2];

  const x1 = p1.x;
  const y1 = p1.y;
  const x2 = p2.x;
  const y2 = p2.y;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const c = Math.hypot(dx, dy);
  if (!c) return [p1, p2];

  const theta = 4 * Math.atan(b);
  const sinHalf = Math.sin(theta / 2);
  if (Math.abs(sinHalf) < 1e-8) return [p1, p2];

  const r = Math.abs(c / (2 * sinHalf));
  const midx = (x1 + x2) / 2;
  const midy = (y1 + y2) / 2;
  const hSq = Math.max(r * r - (c * c) / 4, 0);
  const h = Math.sqrt(hSq) * (b > 0 ? 1 : -1);
  const ux = -dy / c;
  const uy = dx / c;
  const cx = midx + ux * h;
  const cy = midy + uy * h;

  let a1 = Math.atan2(y1 - cy, x1 - cx);
  let a2 = Math.atan2(y2 - cy, x2 - cx);
  if (b > 0 && a2 < a1) a2 += Math.PI * 2;
  if (b < 0 && a2 > a1) a2 -= Math.PI * 2;

  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = a1 + (a2 - a1) * t;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error('Usage: node scripts/dxf-render-svg.js <input.dxf> <output.svg>');
    process.exit(2);
  }

  const parser = new DxfParser();
  const text = fs.readFileSync(input, 'utf8');
  const doc = parser.parseSync(text);

  const blocks = doc?.blocks;
  const blockMap = new Map();
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      const name = b?.name || b?.blockName || b?.block || b?.handle;
      if (!name) continue;
      blockMap.set(String(name), b);
    }
  } else if (blocks && typeof blocks === 'object') {
    for (const [k, v] of Object.entries(blocks)) blockMap.set(String(k), v);
  }

  const bbox = bboxInit();
  const pathsByColor = new Map(); // hex -> string[]
  const texts = []; // { x, y, color, size, rotateDeg, lines[] }

  const clampSteps = (n, min, max) => Math.max(min, Math.min(max, n));

  const addSegment = (hex, a, b) => {
    const key = hex || '#ffffff';
    if (!pathsByColor.has(key)) pathsByColor.set(key, []);
    pathsByColor.get(key).push(`M${a.x},${-a.y}L${b.x},${-b.y}`);
    bboxAdd(bbox, a);
    bboxAdd(bbox, b);
  };

  const addPolyline = (hex, pts) => {
    for (let i = 1; i < pts.length; i++) addSegment(hex, pts[i - 1], pts[i]);
  };

  const escapeXml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  const polylineVerticesToPoints = (verts) => {
    if (!Array.isArray(verts)) return [];
    const pts = [];
    for (const v of verts) {
      const p = toPoint(v?.location || v?.point || v);
      if (p) pts.push(p);
    }
    return pts;
  };

  const lineEndpoints = (ent) => {
    const p1 = toPoint(ent?.start);
    const p2 = toPoint(ent?.end);
    if (p1 && p2) return [p1, p2];

    // dxf-parser often emits LINE with `vertices: [{x,y,z},{x,y,z}]`
    if (Array.isArray(ent?.vertices) && ent.vertices.length >= 2) {
      const a = toPoint(ent.vertices[0]?.location || ent.vertices[0]);
      const b = toPoint(ent.vertices[1]?.location || ent.vertices[1]);
      if (a && b) return [a, b];
    }

    return [null, null];
  };

  const addEntity = (ent, mat, depth = 0) => {
    if (!ent || !ent.type || depth > 8) return;
    const hex = entityHex(doc, ent);

    if (ent.type === 'LINE') {
      const [p1, p2] = lineEndpoints(ent);
      if (!p1 || !p2) return;
      addSegment(hex, applyMat(p1, mat), applyMat(p2, mat));
      return;
    }

    if (ent.type === 'LWPOLYLINE' && Array.isArray(ent.vertices)) {
      const verts = ent.vertices;
      for (let i = 1; i < verts.length; i++) {
        const bulge = verts[i - 1]?.bulge ?? verts[i - 1]?.b;
        const pts = approxBulgePoints(verts[i - 1], verts[i], bulge);
        addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      }
      if ((ent.shape || ent.closed) && verts.length >= 2) {
        const bulge = verts[verts.length - 1]?.bulge ?? verts[verts.length - 1]?.b;
        const pts = approxBulgePoints(verts[verts.length - 1], verts[0], bulge);
        addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      }
      return;
    }

    if (ent.type === 'POLYLINE' && Array.isArray(ent.vertices)) {
      const verts = ent.vertices;
      for (let i = 1; i < verts.length; i++) {
        const bulge = verts[i - 1]?.bulge ?? verts[i - 1]?.b;
        const pts = approxBulgePoints(verts[i - 1], verts[i], bulge);
        addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      }
      if ((ent.shape || ent.closed || ent.isClosed) && verts.length >= 2) {
        const bulge = verts[verts.length - 1]?.bulge ?? verts[verts.length - 1]?.b;
        const pts = approxBulgePoints(verts[verts.length - 1], verts[0], bulge);
        addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      }
      return;
    }

    if (ent.type === 'CIRCLE') {
      const c = toPoint(ent.center);
      const r = Number(ent.radius);
      if (!c || !Number.isFinite(r)) return;
      const steps = 192;
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
      }
      addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      return;
    }

    if (ent.type === 'ARC') {
      const c = toPoint(ent.center);
      const r = Number(ent.radius);
      let s = Number(ent.startAngle);
      let e = Number(ent.endAngle);
      if (!c || !Number.isFinite(r) || !Number.isFinite(s) || !Number.isFinite(e)) return;
      if (e < s) e += 360;
      const start = (s * Math.PI) / 180;
      const end = (e * Math.PI) / 180;
      const steps = clampSteps(Math.ceil((end - start) * 32), 24, 256);
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const a = start + ((end - start) * i) / steps;
        pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
      }
      addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      return;
    }

    if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
      const raw = ent.text ?? ent.string ?? ent.value ?? ent.contents ?? '';
      const pos = toPoint(ent.startPoint || ent.position || ent.insertPoint || ent.point || ent);
      if (!pos) return;

      const size = Number(ent.textHeight ?? ent.height ?? ent.charHeight ?? ent.textheight);
      const rotateDeg = Number(ent.rotation ?? ent.angle ?? 0) || 0;
      const cleaned = String(raw)
        .replace(/\\P/gi, '\n')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Drop a few common MTEXT formatting codes. Not exhaustive.
        .replace(/\\[LlOoKkAaFfTtHhWwQq][^;]*;?/g, '');

      const lines = cleaned.split('\n').map((l) => l.trimEnd()).filter((l) => l.length);
      if (!lines.length) return;

      const p = applyMat(pos, mat);
      texts.push({
        x: p.x,
        y: -p.y,
        color: hex,
        size: Number.isFinite(size) && size > 0 ? size : 1,
        rotateDeg: -rotateDeg, // SVG rotates with Y+ down; our mapping flips Y
        lines,
      });

      // Very rough bbox contribution so the viewBox doesn't clip text-only drawings.
      const approxW = Math.max(...lines.map((l) => l.length)) * (Number.isFinite(size) && size > 0 ? size : 1) * 0.6;
      const approxH = lines.length * (Number.isFinite(size) && size > 0 ? size : 1) * 1.2;
      bboxAdd(bbox, { x: p.x, y: p.y });
      bboxAdd(bbox, { x: p.x + approxW, y: p.y + approxH });
      return;
    }

    if (ent.type === 'ELLIPSE') {
      const center = toPoint(ent.center);
      const majorEnd = toPoint(ent.majorAxisEndPoint || ent.majorAxis || ent.majorAxisEnd || ent.majorAxisEndpoint);
      const ratio = Number(ent.axisRatio ?? ent.ratio);
      if (!center || !majorEnd || !Number.isFinite(ratio) || ratio <= 0) return;

      const majorLen = Math.hypot(majorEnd.x, majorEnd.y);
      if (!Number.isFinite(majorLen) || majorLen <= 0) return;
      const majorAngle = Math.atan2(majorEnd.y, majorEnd.x);
      const minorLen = majorLen * ratio;

      // DXF uses start/end params in radians; some converters export degrees.
      let start = Number(ent.startAngle ?? ent.startParam ?? 0);
      let end = Number(ent.endAngle ?? ent.endParam ?? Math.PI * 2);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      if (Math.abs(start) > Math.PI * 2 + 1e-3 || Math.abs(end) > Math.PI * 2 + 1e-3) {
        start = (start * Math.PI) / 180;
        end = (end * Math.PI) / 180;
      }
      if (end < start) end += Math.PI * 2;

      const steps = clampSteps(Math.ceil((end - start) * 48), 48, 512);
      const cosA = Math.cos(majorAngle);
      const sinA = Math.sin(majorAngle);
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = start + ((end - start) * i) / steps;
        const ct = Math.cos(t);
        const st = Math.sin(t);
        // local ellipse: (majorLen*ct, minorLen*st) rotated by majorAngle
        const x = center.x + (majorLen * ct) * cosA - (minorLen * st) * sinA;
        const y = center.y + (majorLen * ct) * sinA + (minorLen * st) * cosA;
        pts.push({ x, y });
      }
      addPolyline(hex, pts.map((p) => applyMat(p, mat)));
      return;
    }

    if (ent.type === 'SPLINE') {
      const fit = polylineVerticesToPoints(ent.fitPoints || ent.fitpoints);
      if (fit.length >= 2) {
        addPolyline(hex, fit.map((p) => applyMat(p, mat)));
        return;
      }
      const ctrl = polylineVerticesToPoints(ent.controlPoints || ent.controlpoints);
      if (ctrl.length >= 2) {
        addPolyline(hex, ctrl.map((p) => applyMat(p, mat)));
      }
      return;
    }

    if (ent.type === 'INSERT') {
      const name = String(ent.name || ent.block || ent.blockName || ent.refName || '').trim();
      if (!name) return;
      const block = blockMap.get(name);
      const blockEntities = block?.entities;
      if (!Array.isArray(blockEntities) || !blockEntities.length) return;

      const pos = toPoint(ent.position || ent.point || ent.insert || ent);
      const sx = Number(ent.xScale ?? ent.scaleX ?? ent.xscale ?? 1) || 1;
      const sy = Number(ent.yScale ?? ent.scaleY ?? ent.yscale ?? 1) || 1;
      const rot = ((Number(ent.rotation ?? 0) || 0) * Math.PI) / 180;

      const cols = Math.max(1, Number(ent.columns ?? ent.columnCount ?? 1) || 1);
      const rows = Math.max(1, Number(ent.rows ?? ent.rowCount ?? 1) || 1);
      const colSp = Number(ent.columnSpacing ?? ent.columnspace ?? 0) || 0;
      const rowSp = Number(ent.rowSpacing ?? ent.rowspace ?? 0) || 0;

      for (let rr = 0; rr < rows; rr++) {
        for (let cc = 0; cc < cols; cc++) {
          let m = mat;
          if (pos) m = matMul(m, matTranslate(pos.x + cc * colSp, pos.y + rr * rowSp));
          m = matMul(m, matRotate(rot));
          m = matMul(m, matScale(sx, sy));
          for (const be of blockEntities) addEntity(be, m, depth + 1);
        }
      }
    }
  };

  const id = matIdentity();
  for (const ent of doc?.entities || []) addEntity(ent, id, 0);

  if (!Number.isFinite(bbox.minX) || !Number.isFinite(bbox.minY)) {
    throw new Error('No renderable entities found in DXF.');
  }

  const width = Math.max(1e-6, bbox.maxX - bbox.minX);
  const height = Math.max(1e-6, bbox.maxY - bbox.minY);
  const pad = Math.max(width, height) * 0.02;

  const vbX = bbox.minX - pad;
  const vbY = -(bbox.maxY + pad);
  const vbW = width + pad * 2;
  const vbH = height + pad * 2;
  const stroke = Math.max(vbW, vbH) / 1800;

  const parts = [];
  parts.push('<?xml version="1.0"?>');
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`
  );
  parts.push(`<rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#0f1117"/>`);

  for (const [hex, segments] of pathsByColor.entries()) {
    if (!segments.length) continue;
    const d = segments.join('');
    parts.push(
      `<path d="${d}" fill="none" stroke="${hex}" stroke-width="${stroke}" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision"/>`
    );
  }

  for (const t of texts) {
    const x = t.x;
    const y = t.y;
    const rotate = Number.isFinite(t.rotateDeg) && t.rotateDeg !== 0 ? ` transform="rotate(${t.rotateDeg} ${x} ${y})"` : '';
    parts.push(
      `<text x="${x}" y="${y}" fill="${t.color}" font-size="${t.size}" font-family="Arial, Helvetica, sans-serif"${rotate}>`
    );
    t.lines.forEach((line, idx) => {
      const dy = idx === 0 ? 0 : t.size * 1.2;
      parts.push(`<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`);
    });
    parts.push('</text>');
  }

  parts.push('</svg>');
  const svg = parts.join('\n');

  ensureDir(output);
  fs.writeFileSync(output, svg, 'utf8');
}

try {
  main();
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
