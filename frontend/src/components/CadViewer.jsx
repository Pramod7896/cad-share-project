// components/CadViewer.jsx
// React Three Fiber + Drei viewer with:
//   - STL (STLLoader)
//   - OBJ (OBJLoader)
//   - STEP / IGES (occt-import-js WASM -> triangle meshes)
//   - DXF (basic 2D entities via dxf-parser)
//   - OrbitControls + bounds-fit camera
//   - Proper lighting + contact shadows

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Bounds, Center, ContactShadows, Environment, OrbitControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';
import { useLoader } from '@react-three/fiber';
import DxfParser from 'dxf-parser';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry';
import helvetikerRegular from 'three/examples/fonts/helvetiker_regular.typeface.json';

const LOADERS = {
  '.stl': 'stl',
  '.obj': 'obj',
  '.step': 'step',
  '.stp': 'step',
  '.iges': 'iges',
  '.igs': 'iges',
  '.dxf': 'dxf',
  '.dwg': 'dwg',
};

const dxfFont = new FontLoader().parse(helvetikerRegular);

let occtModulePromise;
async function loadOcctImport() {
  if (occtModulePromise) return occtModulePromise;

  occtModulePromise = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && typeof window.occtimportjs === 'function') {
      resolve(window.occtimportjs);
      return;
    }

    const candidates = [
      `${process.env.PUBLIC_URL}/vendor/occt-import-js/occt-import-js.js`,
      `${process.env.PUBLIC_URL}/vendor/occt-import-js/occt-import-js.min.js`,
    ];

    const tryLoadAt = (idx) => {
      if (idx >= candidates.length) {
        reject(new Error('Failed to load occt-import-js script.'));
        return;
      }

      const script = document.createElement('script');
      script.src = candidates[idx];
      script.async = true;

      script.onload = () => {
        if (typeof window.occtimportjs === 'function') {
          resolve(window.occtimportjs);
          return;
        }
        tryLoadAt(idx + 1);
      };

      script.onerror = () => tryLoadAt(idx + 1);
      document.head.appendChild(script);
    };

    tryLoadAt(0);
  }).then((occtimportjs) => occtimportjs());

  return occtModulePromise;
}

function flattenTriplets(maybeTriplets) {
  if (!Array.isArray(maybeTriplets)) return maybeTriplets;
  if (!maybeTriplets.length) return [];
  return Array.isArray(maybeTriplets[0]) ? maybeTriplets.flat() : maybeTriplets;
}

function toPoint(p) {
  if (!p) return null;
  if (Array.isArray(p) && p.length >= 2) {
    const x = Number(p[0]);
    const y = Number(p[1]);
    const z = Number(p[2] || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }

  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function aciToRgb(aci) {
  // Minimal AutoCAD Color Index mapping for common CAD layer colors.
  // https://help.autodesk.com/view/OARX/2024/ENU/?guid=OARX-ManagedRefGuide-Autodesk_AutoCAD_Colors_Color
  switch (Number(aci)) {
    case 1: return [1, 0, 0];       // red
    case 2: return [1, 1, 0];       // yellow
    case 3: return [0, 1, 0];       // green
    case 4: return [0, 1, 1];       // cyan
    case 5: return [0, 0, 1];       // blue
    case 6: return [1, 0, 1];       // magenta
    case 7: return [1, 1, 1];       // white
    case 8: return [0.6, 0.6, 0.6]; // dark gray
    case 9: return [0.8, 0.8, 0.8]; // light gray
    default: return [1, 1, 1];
  }
}

function getLayerAci(doc, layerName) {
  if (!layerName) return null;
  const layers = doc?.tables?.layer?.layers;
  if (!layers) return null;

  // dxf-parser can represent layers as object map or array.
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

function getEntityRgb(doc, ent) {
  // DXF color rules:
  // - colorNumber: 0=BYBLOCK, 256=BYLAYER
  // - trueColor: 24-bit RGB (0xRRGGBB) if present
  const trueColor = ent?.trueColor ?? ent?.truecolor ?? ent?.rgb;
  if (trueColor !== undefined && trueColor !== null) {
    const n = Number(trueColor);
    if (Number.isFinite(n) && n >= 0) {
      const r = ((n >> 16) & 255) / 255;
      const g = ((n >> 8) & 255) / 255;
      const b = (n & 255) / 255;
      return [r, g, b];
    }
  }

  const byEntity = ent?.colorNumber ?? ent?.color;
  const byEntityNum = Number(byEntity);
  if (Number.isFinite(byEntityNum) && byEntityNum > 0 && byEntityNum !== 256) {
    return aciToRgb(byEntityNum);
  }

  const byLayer = getLayerAci(doc, ent?.layer);
  const byLayerNum = Number(byLayer);
  if (Number.isFinite(byLayerNum) && byLayerNum > 0) return aciToRgb(byLayerNum);

  return aciToRgb(7);
}

function buildDxfLineSegments(doc) {
  const group = new THREE.Group();
  group.name = 'dxf_group';

  const points = [];
  const colors = [];

  const pushColoredSegment = (rgb, a, b) => {
    const pa = toPoint(a);
    const pb = toPoint(b);
    if (!pa || !pb) return;
    points.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
  };

  const pushColoredSegmentMat = (rgb, a, b, mat4) => {
    const pa = toPoint(a);
    const pb = toPoint(b);
    if (!pa || !pb) return;

    const va = new THREE.Vector3(pa.x, pa.y, pa.z).applyMatrix4(mat4);
    const vb = new THREE.Vector3(pb.x, pb.y, pb.z).applyMatrix4(mat4);

    points.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
    colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
  };

  const addArc = (rgb, center, radius, startDeg, endDeg) => {
    const c = toPoint(center);
    const r = Number(radius);
    let s = Number(startDeg);
    let e = Number(endDeg);
    if (!c || !Number.isFinite(r) || !Number.isFinite(s) || !Number.isFinite(e)) return;
    if (e < s) e += 360;

    const steps = 96;
    const start = THREE.MathUtils.degToRad(s);
    const end = THREE.MathUtils.degToRad(e);
    const delta = (end - start) / steps;
    let prev = null;

    for (let i = 0; i <= steps; i++) {
      const a = start + delta * i;
      const p = new THREE.Vector3(
        c.x + Math.cos(a) * r,
        c.y + Math.sin(a) * r,
        c.z
      );
      if (prev) pushColoredSegment(rgb, prev, p);
      prev = p;
    }
  };

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

  const addBulgeArc = (rgb, v1, v2, bulge, mat4) => {
    const p1 = toPoint(v1);
    const p2 = toPoint(v2);
    const b = Number(bulge);
    if (!p1 || !p2 || !Number.isFinite(b) || b === 0) {
      pushColoredSegmentMat(rgb, v1, v2, mat4);
      return;
    }

    const x1 = p1.x; const y1 = p1.y;
    const x2 = p2.x; const y2 = p2.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const c = Math.hypot(dx, dy);
    if (!c) return;

    const theta = 4 * Math.atan(b);
    const sinHalf = Math.sin(theta / 2);
    if (Math.abs(sinHalf) < 1e-8) {
      pushColoredSegmentMat(rgb, v1, v2, mat4);
      return;
    }

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

    // Ensure direction matches bulge sign.
    if (b > 0 && a2 < a1) a2 += Math.PI * 2;
    if (b < 0 && a2 > a1) a2 -= Math.PI * 2;

    const steps = Math.max(12, Math.min(256, Math.ceil(Math.abs(theta) * 24)));
    let prev = new THREE.Vector3(x1, y1, p1.z || 0);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const a = a1 + (a2 - a1) * t;
      const next = new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, p1.z || 0);
      pushColoredSegmentMat(rgb, prev, next, mat4);
      prev = next;
    }
  };

  const addEntity = (ent, mat4, depth = 0) => {
    if (!ent || !ent.type) return;
    if (depth > 8) return; // prevent infinite recursion

    const rgb = getEntityRgb(doc, ent);
    const color = new THREE.Color(rgb[0], rgb[1], rgb[2]);

    if (ent.type === 'LINE') {
      pushColoredSegmentMat(rgb, ent.start, ent.end, mat4);
      return;
    }

    if (ent.type === 'POINT') {
      const p = toPoint(ent.position || ent.point || ent);
      if (!p) return;
      const size = 1; // best-effort; CAD viewers vary
      pushColoredSegmentMat(rgb, { x: p.x - size, y: p.y, z: p.z }, { x: p.x + size, y: p.y, z: p.z }, mat4);
      pushColoredSegmentMat(rgb, { x: p.x, y: p.y - size, z: p.z }, { x: p.x, y: p.y + size, z: p.z }, mat4);
      return;
    }

    if (ent.type === 'LWPOLYLINE' && Array.isArray(ent.vertices)) {
      const verts = ent.vertices;
      for (let i = 1; i < verts.length; i++) {
        const bulge = verts[i - 1]?.bulge ?? verts[i - 1]?.b;
        addBulgeArc(rgb, verts[i - 1], verts[i], bulge, mat4);
      }
      if ((ent.shape || ent.closed) && verts.length >= 2) {
        const bulge = verts[verts.length - 1]?.bulge ?? verts[verts.length - 1]?.b;
        addBulgeArc(rgb, verts[verts.length - 1], verts[0], bulge, mat4);
      }
      return;
    }

    if (ent.type === 'POLYLINE' && Array.isArray(ent.vertices)) {
      const verts = ent.vertices;
      for (let i = 1; i < verts.length; i++) {
        const bulge = verts[i - 1]?.bulge ?? verts[i - 1]?.b;
        addBulgeArc(rgb, verts[i - 1], verts[i], bulge, mat4);
      }
      if (ent.closed && verts.length >= 2) {
        const bulge = verts[verts.length - 1]?.bulge ?? verts[verts.length - 1]?.b;
        addBulgeArc(rgb, verts[verts.length - 1], verts[0], bulge, mat4);
      }
      return;
    }

    if (ent.type === 'CIRCLE') {
      // Approximate circle with segments in local space then transform.
      const c = toPoint(ent.center);
      const r = Number(ent.radius);
      if (!c || !Number.isFinite(r)) return;
      const steps = 192;
      let prev = new THREE.Vector3(c.x + r, c.y, c.z || 0);
      for (let i = 1; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const next = new THREE.Vector3(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, c.z || 0);
        pushColoredSegmentMat(rgb, prev, next, mat4);
        prev = next;
      }
      return;
    }

    if (ent.type === 'ARC') {
      const c = toPoint(ent.center);
      const r = Number(ent.radius);
      let s = Number(ent.startAngle);
      let e = Number(ent.endAngle);
      if (!c || !Number.isFinite(r) || !Number.isFinite(s) || !Number.isFinite(e)) return;
      if (e < s) e += 360;
      const start = THREE.MathUtils.degToRad(s);
      const end = THREE.MathUtils.degToRad(e);
      const steps = Math.max(24, Math.min(256, Math.ceil((end - start) * 32)));
      let prev = new THREE.Vector3(c.x + Math.cos(start) * r, c.y + Math.sin(start) * r, c.z || 0);
      for (let i = 1; i <= steps; i++) {
        const a = start + ((end - start) * i) / steps;
        const next = new THREE.Vector3(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, c.z || 0);
        pushColoredSegmentMat(rgb, prev, next, mat4);
        prev = next;
      }
      return;
    }

    if (ent.type === 'ELLIPSE') {
      const c = toPoint(ent.center);
      const major = ent.majorAxisEndPoint || ent.majorAxis || ent.major;
      const maj = toPoint(major);
      const ratio = Number(ent.axisRatio ?? ent.ratio ?? 1);
      let s = Number(ent.startAngle ?? 0);
      let e = Number(ent.endAngle ?? Math.PI * 2);
      if (!c || !maj || !Number.isFinite(ratio)) return;

      // DXF angles are radians for ELLIPSE.
      if (!Number.isFinite(s)) s = 0;
      if (!Number.isFinite(e)) e = Math.PI * 2;
      if (e < s) e += Math.PI * 2;

      const majorVec = new THREE.Vector3(maj.x, maj.y, maj.z || 0);
      const majorLen = majorVec.length();
      if (!majorLen) return;
      const majorDir = majorVec.clone().normalize();
      const minorDir = new THREE.Vector3(-majorDir.y, majorDir.x, 0);
      const minorLen = majorLen * ratio;

      const steps = 256;
      let prev = null;
      for (let i = 0; i <= steps; i++) {
        const t = s + ((e - s) * i) / steps;
        const p = new THREE.Vector3(
          c.x + Math.cos(t) * majorLen * majorDir.x + Math.sin(t) * minorLen * minorDir.x,
          c.y + Math.cos(t) * majorLen * majorDir.y + Math.sin(t) * minorLen * minorDir.y,
          c.z || 0
        );
        if (prev) pushColoredSegmentMat(rgb, prev, p, mat4);
        prev = p;
      }
      return;
    }

    if (ent.type === 'SPLINE') {
      const fit = Array.isArray(ent.fitPoints) ? ent.fitPoints : null;
      const ctrl = Array.isArray(ent.controlPoints) ? ent.controlPoints : null;
      const pts = (fit && fit.length >= 2) ? fit : (ctrl && ctrl.length >= 2) ? ctrl : null;
      if (!pts) return;

      const curvePts = pts.map((p) => {
        const pp = toPoint(p);
        return pp ? new THREE.Vector3(pp.x, pp.y, pp.z || 0) : null;
      }).filter(Boolean);

      if (curvePts.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(curvePts, false, 'centripetal');
      const samples = Math.min(600, Math.max(80, curvePts.length * 50));
      const sampled = curve.getPoints(samples);

      for (let i = 1; i < sampled.length; i++) {
        pushColoredSegmentMat(rgb, sampled[i - 1], sampled[i], mat4);
      }
      return;
    }

    if (ent.type === 'SOLID' || ent.type === 'TRACE') {
      const pts = [ent.p1, ent.p2, ent.p3, ent.p4].filter(Boolean);
      if (pts.length < 3) return;
      for (let i = 1; i < pts.length; i++) pushColoredSegmentMat(rgb, pts[i - 1], pts[i], mat4);
      pushColoredSegmentMat(rgb, pts[pts.length - 1], pts[0], mat4);
      return;
    }

    if (ent.type === 'TEXT' || ent.type === 'MTEXT' || ent.type === 'ATTRIB') {
      const raw = ent.text ?? ent.string ?? ent.value ?? ent.plainText ?? ent.mtext ?? ent.contents ?? '';
      let text = String(raw);
      if (!text.trim()) return;

      // Minimal MTEXT cleanup
      text = text
        .replace(/\\P/g, '\n')
        .replace(/\{\\.*?;/g, '')   // {\\...; style tags
        .replace(/[{}]/g, '')
        .replace(/\\[A-Za-z]+/g, '') // remaining control codes
        .trim();

      if (!text) return;

      const pos = toPoint(ent.startPoint || ent.position || ent.insert || ent.p1 || ent);
      if (!pos) return;

      const height = Number(ent.textHeight ?? ent.height ?? ent.charHeight ?? 2.5);
      const rotDeg = Number(ent.rotation ?? ent.rot ?? 0) || 0;
      const rot = THREE.MathUtils.degToRad(rotDeg);

      const geo = new TextGeometry(text, {
        font: dxfFont,
        size: Math.max(0.1, height),
        height: 0.001,
        curveSegments: 4,
        bevelEnabled: false,
      });
      geo.computeBoundingBox();

      const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'dxf_text';

      // Apply transform: entity local translate/rotate then block transform
      const m = new THREE.Matrix4().multiply(mat4);
      m.multiply(new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z || 0));
      m.multiply(new THREE.Matrix4().makeRotationZ(rot));
      mesh.applyMatrix4(m);
      group.add(mesh);
      return;
    }

    if (ent.type === 'DIMENSION') {
      // DIMENSION entities usually reference an anonymous block that contains the drawn dimension graphics.
      const bname = String(ent.block || ent.blockName || ent.dimBlock || '').trim();
      if (!bname) return;
      const pos = toPoint(ent.anchorPoint || ent.defPoint || ent.middleOfText || ent.textMidpoint || ent.position || ent);
      const fakeInsert = {
        type: 'INSERT',
        name: bname,
        position: pos || { x: 0, y: 0, z: 0 },
        rotation: ent.rotation || 0,
        xScale: 1,
        yScale: 1,
        zScale: 1,
        layer: ent.layer,
        colorNumber: ent.colorNumber,
        trueColor: ent.trueColor,
      };
      addEntity(fakeInsert, mat4, depth + 1);
      return;
    }

    if (ent.type === 'INSERT') {
      const name = String(ent.name || ent.block || ent.blockName || ent.refName || '').trim();
      if (!name) return;
      const block = blockMap.get(name);
      const blockEntities = block?.entities || block?.Entity || block?.children || block?.objects;
      if (!Array.isArray(blockEntities) || !blockEntities.length) return;

      const pos = toPoint(ent.position || ent.point || ent.insert || ent);
      const sx = Number(ent.xScale ?? ent.scaleX ?? ent.xscale ?? 1) || 1;
      const sy = Number(ent.yScale ?? ent.scaleY ?? ent.yscale ?? 1) || 1;
      const sz = Number(ent.zScale ?? ent.scaleZ ?? ent.zscale ?? 1) || 1;
      const rot = THREE.MathUtils.degToRad(Number(ent.rotation ?? 0) || 0);

      const cols = Math.max(1, Number(ent.columns ?? ent.columnCount ?? 1) || 1);
      const rows = Math.max(1, Number(ent.rows ?? ent.rowCount ?? 1) || 1);
      const colSp = Number(ent.columnSpacing ?? ent.columnspace ?? 0) || 0;
      const rowSp = Number(ent.rowSpacing ?? ent.rowspace ?? 0) || 0;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const m = new THREE.Matrix4();
          m.multiply(mat4);
          if (pos) m.multiply(new THREE.Matrix4().makeTranslation(pos.x + c * colSp, pos.y + r * rowSp, pos.z || 0));
          m.multiply(new THREE.Matrix4().makeRotationZ(rot));
          m.multiply(new THREE.Matrix4().makeScale(sx, sy, sz));

          for (const be of blockEntities) addEntity(be, m, depth + 1);
        }
      }
      return;
    }
  };

  const identity = new THREE.Matrix4();
  for (const ent of (doc?.entities || [])) addEntity(ent, identity, 0);

  if (!points.length && group.children.length === 0) return null;

  if (points.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    if (colors.length === points.length) {
      geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    }

    const mat = new THREE.LineBasicMaterial({
      vertexColors: colors.length === points.length,
      color: 0xffffff,
      toneMapped: false, // keep CAD colors punchy under tone mapping
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.name = 'dxf_lines';
    group.add(lines);
  }

  return group;
}

function useRemoteText(url, enabled) {
  const [state, setState] = useState({ status: 'idle', text: '', error: '' });

  useEffect(() => {
    if (!enabled || !url) return;

    const abortController = new AbortController();
    setState({ status: 'loading', text: '', error: '' });

    (async () => {
      try {
        const resp = await fetch(url, { signal: abortController.signal });
        const contentType = resp.headers.get('content-type') || '';
        const text = await resp.text();

        if (abortController.signal.aborted) return;

        // Backend may return JSON errors (e.g. missing DWG2DXF_CMD).
        if (!resp.ok || contentType.includes('application/json')) {
          try {
            const j = JSON.parse(text);
            const msg = [j?.error, j?.details, j?.hint].filter(Boolean).join('\n');
            setState({ status: 'error', text, error: msg || `Request failed (${resp.status}).` });
          } catch {
            setState({ status: 'error', text, error: `Request failed (${resp.status}).` });
          }
          return;
        }

        setState({ status: 'ready', text, error: '' });
      } catch (e) {
        if (abortController.signal.aborted) return;
        setState({ status: 'error', text: '', error: e?.message || 'Request failed.' });
      }
    })();

    return () => abortController.abort();
  }, [url, enabled]);

  return state;
}

function useOcctGroup(url, kind, enabled) {
  const [state, setState] = useState({ status: 'idle', group: null, error: '', raw: '' });

  useEffect(() => {
    if (!enabled || !url) return;

    const abortController = new AbortController();
    setState({ status: 'loading', group: null, error: '', raw: '' });

    (async () => {
      try {
        const [occt, resp] = await Promise.all([
          loadOcctImport(),
          fetch(url, { signal: abortController.signal }),
        ]);

        const contentType = resp.headers.get('content-type') || '';
        const buf = await resp.arrayBuffer();
        if (abortController.signal.aborted) return;

        if (!resp.ok || contentType.includes('application/json')) {
          // It might be a JSON error; surface it.
          const text = new TextDecoder().decode(new Uint8Array(buf.slice(0, 200_000)));
          try {
            const j = JSON.parse(text);
            const msg = [j?.error, j?.details, j?.hint].filter(Boolean).join('\n');
            setState({ status: 'error', group: null, error: msg || `Request failed (${resp.status}).`, raw: text });
          } catch {
            setState({ status: 'error', group: null, error: `Request failed (${resp.status}).`, raw: text });
          }
          return;
        }

        const bytes = new Uint8Array(buf);
        const result = kind === 'step'
          ? occt.ReadStepFile(bytes, null)
          : occt.ReadIgesFile(bytes, null);

        const meshes = Array.isArray(result?.meshes) ? result.meshes : [];
        const root = result?.root;

        if (!meshes.length || !root) {
          setState({ status: 'error', group: null, error: 'Could not parse the CAD file for preview.', raw: '' });
          return;
        }

        const buildNode = (node) => {
          const group = new THREE.Group();
          group.name = node?.name || '';

          for (const meshIndex of (node?.meshes || [])) {
            const m = meshes[meshIndex];
            if (!m) continue;

            const pos = flattenTriplets(m?.attributes?.position?.array);
            if (!pos || !pos.length) continue;

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));

            const norms = flattenTriplets(m?.attributes?.normal?.array);
            if (norms && norms.length) {
              geom.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
            } else {
              geom.computeVertexNormals();
            }

            const idx = flattenTriplets(m?.index?.array);
            if (idx && idx.length) geom.setIndex(idx);

            const mtl = new THREE.MeshStandardMaterial({
              color: Array.isArray(m?.color)
                ? new THREE.Color(m.color[0], m.color[1], m.color[2])
                : new THREE.Color(0x6b7cff),
              roughness: 0.35,
              metalness: 0.08,
              envMapIntensity: 0.9,
              side: THREE.DoubleSide,
            });

            const mesh = new THREE.Mesh(geom, mtl);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            group.add(mesh);
          }

          for (const child of (node?.children || [])) {
            group.add(buildNode(child));
          }

          return group;
        };

        const group = buildNode(root);
        group.name = 'cad_model';

        setState({ status: 'ready', group, error: '', raw: '' });
      } catch (e) {
        if (abortController.signal.aborted) return;
        setState({ status: 'error', group: null, error: e?.message || 'Could not load STEP/IGES preview.', raw: '' });
      }
    })();

    return () => abortController.abort();
  }, [url, kind, enabled]);

  return state;
}

function StlModel({ url, wireframe, onReady }) {
  const geometry = useLoader(STLLoader, url);

  useEffect(() => {
    onReady?.();
  }, [onReady, geometry]);

  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: 0x6b7cff,
    roughness: 0.35,
    metalness: 0.08,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
    wireframe,
  }), [wireframe]);

  return (
    <mesh geometry={geometry} material={material} castShadow receiveShadow />
  );
}

function ObjModel({ url, wireframe, onReady }) {
  const group = useLoader(OBJLoader, url);

  const baseMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: 0x6b7cff,
    roughness: 0.35,
    metalness: 0.08,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
  }), []);

  useEffect(() => {
    group.traverse((child) => {
      if (!child?.isMesh) return;
      child.material = baseMaterial;
      child.material.wireframe = wireframe;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    onReady?.();
  }, [group, baseMaterial, wireframe, onReady]);

  return <primitive object={group} />;
}

function OcctModel({ url, kind, wireframe, onReady, onError, onRaw }) {
  const { status, group, error, raw } = useOcctGroup(url, kind, true);

  useEffect(() => {
    if (status === 'ready') onReady?.();
    if (status === 'error') {
      onError?.(error || 'Could not load STEP/IGES preview.');
      if (raw) onRaw?.(raw);
    }
  }, [status, error, raw, onReady, onError, onRaw]);

  useEffect(() => {
    if (!group) return;
    group.traverse((child) => {
      if (!child?.isMesh || !child.material) return;
      child.material.wireframe = wireframe;
    });
  }, [group, wireframe]);

  if (!group) return null;
  return <primitive object={group} />;
}

function DxfModel({ url, onReady, onError, onRaw }) {
  const { status, text, error } = useRemoteText(url, true);

  const lines = useMemo(() => {
    if (status !== 'ready') return null;
    const parser = new DxfParser();
    const doc = parser.parseSync(text);
    return buildDxfLineSegments(doc);
  }, [status, text]);

  useEffect(() => {
    if (status === 'error') onError?.(error || 'Could not load DXF preview.');
  }, [status, error, onError]);

  useEffect(() => {
    if (status !== 'ready') return;

    if (!lines) {
      onRaw?.(text);
      onError?.('DXF preview: no supported entities found. Showing raw file content.');
      return;
    }

    onReady?.();
  }, [status, lines, onReady, onError, onRaw, text]);

  if (!lines) return null;
  return <primitive object={lines} />;
}

function Scene({ loaderType, fileUrl, wireframe, onReady, onError, onRaw, enableShadows }) {
  return (
    <Canvas
      shadows={enableShadows}
      dpr={[1, 2]}
      camera={loaderType === 'dxf'
        ? { fov: 35, near: 0.01, far: 100000, position: [0, 0, 120] }
        : { fov: 45, near: 0.01, far: 10000, position: [3, 2, 6] }}
      gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.shadowMap.enabled = enableShadows;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.35;
        gl.physicallyCorrectLights = true;
      }}
      style={{ width: '100%', height: '100%' }}
    >
      <color attach="background" args={['#0f1117']} />

      {loaderType !== 'dxf' && (
        <>
          {/* Lighting (3D) */}
          <ambientLight intensity={0.35} />
          <hemisphereLight intensity={1.0} color="#ffffff" groundColor="#1b1f2a" />
          <directionalLight
            intensity={3.0}
            position={[7, 12, 8]}
            castShadow={enableShadows}
            shadow-mapSize-width={2048}
            shadow-mapSize-height={2048}
            shadow-camera-near={0.1}
            shadow-camera-far={200}
            shadow-camera-left={-30}
            shadow-camera-right={30}
            shadow-camera-top={30}
            shadow-camera-bottom={-30}
            shadow-bias={-0.0001}
          />
          <directionalLight intensity={0.9} color="#9db4ff" position={[-10, 6, -8]} />
          <directionalLight intensity={0.35} color="#ffe0c2" position={[2, 3, 10]} />

          {/* Camera-facing fill */}
          <pointLight intensity={45} position={[4, 4, 6]} distance={60} decay={2} />
          <pointLight intensity={18} position={[-6, 2, -4]} distance={80} decay={2} />

          <Environment preset="warehouse" />
        </>
      )}

      {/* Helpers */}
      {loaderType !== 'dxf' && (
        <gridHelper args={[20, 20, '#2a2d3e', '#1e2130']} />
      )}
      {enableShadows && (
        <ContactShadows
          opacity={0.25}
          blur={1.6}
          far={60}
          resolution={1024}
          scale={80}
          position={[0, -0.001, 0]}
        />
      )}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={loaderType === 'dxf' ? 0.08 : 0.06}
        enablePan
        screenSpacePanning
        rotateSpeed={0.8}
        panSpeed={0.9}
        zoomSpeed={1.1}
      />

      <Bounds fit clip margin={1.2}>
        <Center>
          <Suspense fallback={null}>
            {loaderType === 'stl' && (
              <StlModel url={fileUrl} wireframe={wireframe} onReady={onReady} />
            )}
            {loaderType === 'obj' && (
              <ObjModel url={fileUrl} wireframe={wireframe} onReady={onReady} />
            )}
            {(loaderType === 'step' || loaderType === 'iges') && (
              <OcctModel
                url={fileUrl}
                kind={loaderType}
                wireframe={wireframe}
                onReady={onReady}
                onError={onError}
                onRaw={onRaw}
              />
            )}
            {loaderType === 'dxf' && (
              <DxfModel url={fileUrl} onReady={onReady} onError={onError} onRaw={onRaw} />
            )}
          </Suspense>
        </Center>
      </Bounds>
    </Canvas>
  );
}

export default function CadViewer({ fileUrl, fileName, displayName }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wireframe, setWireframe] = useState(false);

  const [rawText, setRawText] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const ext = useMemo(() => {
    if (!fileName) return '';
    return `.${String(fileName).split('.').pop().toLowerCase()}`;
  }, [fileName]);

  const loaderType = LOADERS[ext];
  const enableShadows = loaderType !== 'dxf';

  // Reset on file changes (avoid flicker on StrictMode effect replay).
  const lastKey = useRef('');
  useEffect(() => {
    const key = `${fileUrl}|${loaderType}`;
    if (key === lastKey.current) return;
    lastKey.current = key;

    setLoading(true);
    setError('');
    setWireframe(false);
    setRawText('');
    setShowRaw(false);
  }, [fileUrl, loaderType]);

  const handleReady = () => setLoading(false);
  const handleError = (msg) => {
    setError(msg || 'Could not load preview.');
    setLoading(false);
  };

  const handleRaw = (text) => {
    if (!text) return;
    setRawText(String(text).slice(0, 200_000));
    setShowRaw(true);
  };

  if (!fileUrl || !fileName) {
    return (
      <div style={styles.noViewer}>
        <p style={styles.noViewerTitle}>No file</p>
      </div>
    );
  }

  if (!loaderType || loaderType === 'dwg') {
    return (
      <div style={styles.noViewer}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#5b6af0" strokeWidth="1.5">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14,2 14,8 20,8"/>
        </svg>
        <p style={styles.noViewerTitle}>{displayName || fileName}</p>
        <p style={styles.noViewerText}>
          This format ({ext || 'unknown'}) is not supported for in-browser preview yet.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.viewerWrap}>
      {/* Controls bar */}
      <div style={styles.toolbar}>
        <span style={styles.toolbarLabel}>{displayName || fileName}</span>
        <div style={styles.toolbarActions}>
          {loaderType !== 'dxf' && (
            <button style={styles.toolBtn} onClick={() => setWireframe((v) => !v)}>
              {wireframe ? 'Solid' : 'Wireframe'}
            </button>
          )}
          {rawText && (
            <button style={styles.toolBtn} onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? '3D' : 'Raw'}
            </button>
          )}
        </div>
      </div>

      {/* 3D Canvas */}
      <div style={styles.canvas}>
        <Scene
          loaderType={loaderType}
          fileUrl={fileUrl}
          wireframe={wireframe}
          onReady={handleReady}
          onError={handleError}
          onRaw={handleRaw}
          enableShadows={enableShadows}
        />
      </div>

      {/* Loading overlay */}
      {loading && (
        <div style={styles.loadingOverlay}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Loading model…</p>
        </div>
      )}

      {/* Error */}
      {error && !showRaw && (
        <div style={styles.errorOverlay}>{error}</div>
      )}

      {/* Raw fallback */}
      {showRaw && rawText && (
        <div style={styles.rawOverlay}>
          <div style={styles.rawHeader}>
            <span style={styles.rawTitle}>Raw file content (first 200k chars)</span>
            <button style={styles.rawClose} onClick={() => setShowRaw(false)}>Close</button>
          </div>
          <pre style={styles.rawPre}>{rawText}</pre>
        </div>
      )}

      {/* Hint */}
      {!loading && !error && !showRaw && (
        <div style={styles.hint}>
          Left drag: rotate · Right drag / two-finger: pan · Scroll: zoom
        </div>
      )}
    </div>
  );
}

const styles = {
  viewerWrap: {
    position: 'relative', width: '100%', height: '100%',
    background: '#0f1117', borderRadius: 12, overflow: 'hidden',
  },
  toolbar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'rgba(15,17,23,0.85)', backdropFilter: 'blur(8px)',
    padding: '10px 16px', borderBottom: '1px solid #1e2130',
  },
  toolbarLabel: { color: '#c8cade', fontSize: 13, fontWeight: 500 },
  toolbarActions: { display: 'flex', gap: 8 },
  toolBtn: {
    padding: '5px 12px', borderRadius: 6, border: '1px solid #2a2d3e',
    background: '#1a1d27', color: '#8b8fa8', fontSize: 12, cursor: 'pointer',
    textDecoration: 'none',
  },
  canvas: { width: '100%', height: '100%', display: 'block' },
  loadingOverlay: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    background: 'rgba(15,17,23,0.8)',
  },
  spinner: {
    width: 36, height: 36, border: '3px solid #2a2d3e',
    borderTopColor: '#5b6af0', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: { color: '#8b8fa8', fontSize: 13, marginTop: 12 },
  errorOverlay: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'rgba(15,17,23,0.9)',
    color: '#f08080', fontSize: 14, padding: 24, textAlign: 'center', whiteSpace: 'pre-wrap',
  },
  hint: {
    position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(15,17,23,0.7)', borderRadius: 6, padding: '4px 12px',
    color: '#555770', fontSize: 11, pointerEvents: 'none', whiteSpace: 'nowrap',
  },
  noViewer: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: 12, padding: '2rem', textAlign: 'center',
    background: '#0f1117',
  },
  noViewerTitle: { color: '#c8cade', fontSize: 16, fontWeight: 600, margin: 0 },
  noViewerText: { color: '#8b8fa8', fontSize: 13, margin: 0, lineHeight: 1.6 },
  rawOverlay: {
    position: 'absolute', inset: 0, zIndex: 20,
    background: 'rgba(15,17,23,0.96)',
    display: 'flex', flexDirection: 'column',
  },
  rawHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 16px', borderBottom: '1px solid #1e2130',
    background: 'rgba(15,17,23,0.9)',
  },
  rawTitle: { color: '#c8cade', fontSize: 12, fontWeight: 500 },
  rawClose: {
    padding: '5px 12px', borderRadius: 6, border: '1px solid #2a2d3e',
    background: '#1a1d27', color: '#8b8fa8', fontSize: 12, cursor: 'pointer',
  },
  rawPre: {
    margin: 0,
    padding: 16,
    overflow: 'auto',
    color: '#c8cade',
    fontSize: 12,
    lineHeight: 1.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    whiteSpace: 'pre',
  },
};
