// components/CadViewer.jsx
// Three.js-based WebGL viewer with:
//   - STL loader (binary + ASCII)
//   - OBJ loader
//   - STEP / IGES loader (via occt-import-js)
//   - DXF (basic 2D entities)
//   - Orbit controls (zoom, rotate, pan)
//   - Responsive canvas
//   - Auto-centering and camera framing

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls }  from 'three/examples/jsm/controls/OrbitControls';
import { STLLoader }      from 'three/examples/jsm/loaders/STLLoader';
import { OBJLoader }      from 'three/examples/jsm/loaders/OBJLoader';
import DxfParser          from 'dxf-parser';

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

let occtModulePromise;
async function loadOcctImport() {
  if (occtModulePromise) return occtModulePromise;

  occtModulePromise = new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && typeof window.occtimportjs === 'function') {
      resolve(window.occtimportjs);
      return;
    }

    const candidates = [
      // Copied by `npm install` (postinstall) into `public/vendor/occt-import-js/`.
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

export default function CadViewer({ fileUrl, fileName, displayName }) {
  const mountRef  = useRef(null);
  const sceneData = useRef({ materials: [] });
  const lastLoadKeyRef = useRef('');

  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [wireframe, setWireframe] = useState(false);
  const [rawText, setRawText]   = useState('');
  const [showRaw, setShowRaw]   = useState(false);

  const ext = useMemo(() => {
    if (!fileName) return '';
    return `.${String(fileName).split('.').pop().toLowerCase()}`;
  }, [fileName]);

  const loaderType = LOADERS[ext];

  useEffect(() => {
    if (!fileUrl || !mountRef.current) return;

    const loadKey = `${fileUrl}|${loaderType}`;
    if (lastLoadKeyRef.current !== loadKey) {
      lastLoadKeyRef.current = loadKey;
      setLoading(true);
      setError('');
      setWireframe(false);
      setRawText('');
      setShowRaw(false);
      sceneData.current = { materials: [] };
    } else {
      // React 18 StrictMode will re-run effects in dev; avoid flashing UI by
      // not resetting state when deps are effectively unchanged.
      setLoading(true);
      setError('');
    }

    const abortController = new AbortController();
    let disposed = false;

    const mount = mountRef.current;
    const { width, height } = mount.getBoundingClientRect();

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.physicallyCorrectLights = true;
    mount.appendChild(renderer.domElement);

    // Scene & camera
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1117);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10000);
    camera.position.set(0, 0, 5);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x1b1f2a, 0.75);
    scene.add(hemi);

    // Key light (casts shadows)
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
    keyLight.position.set(7, 12, 8);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 200;
    keyLight.shadow.camera.left = -30;
    keyLight.shadow.camera.right = 30;
    keyLight.shadow.camera.top = 30;
    keyLight.shadow.camera.bottom = -30;
    keyLight.shadow.bias = -0.0001;
    scene.add(keyLight);

    // Rim/back light for better silhouette
    const rimLight = new THREE.DirectionalLight(0x9db4ff, 0.9);
    rimLight.position.set(-10, 6, -8);
    scene.add(rimLight);

    // Small warm fill from the front
    const fillLight = new THREE.DirectionalLight(0xffe0c2, 0.35);
    fillLight.position.set(2, 3, 10);
    scene.add(fillLight);

    // Grid helper
    const grid = new THREE.GridHelper(20, 20, 0x2a2d3e, 0x1e2130);
    scene.add(grid);

    // Shadow catcher plane (subtle grounding)
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.18 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.receiveShadow = true;
    shadowPlane.position.y = -0.001;
    scene.add(shadowPlane);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping    = true;
    controls.dampingFactor    = 0.05;
    controls.enablePan        = true;
    controls.zoomSpeed        = 1.2;
    controls.rotateSpeed      = 0.8;
    controls.minDistance      = 0.1;
    controls.maxDistance      = 5000;

    const frameObject = (obj) => {
      const box    = new THREE.Box3().setFromObject(obj);
      const center = new THREE.Vector3();
      const size   = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);

      obj.position.sub(center);
      grid.position.y = -size.y / 2;
      shadowPlane.position.y = grid.position.y - 0.001;

      const maxDim  = Math.max(size.x, size.y, size.z || 0.0001);
      const fovRad  = (camera.fov * Math.PI) / 180;
      let   camDist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.5;
      camDist = Math.max(camDist, 1);

      camera.position.set(camDist * 0.8, camDist * 0.5, camDist);
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    const markReady = () => {
      if (disposed) return;
      setLoading(false);
    };

    const markError = (msg) => {
      if (disposed) return;
      setError(msg);
      setLoading(false);
    };

    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0x6b7cff,
      roughness: 0.35,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });

    sceneData.current.materials.push(baseMaterial);

    if (loaderType === 'stl') {
      const loader = new STLLoader();
      loader.load(
        fileUrl,
        (geometry) => {
          if (disposed) return;
          geometry.computeVertexNormals();

          const mesh = new THREE.Mesh(geometry, baseMaterial);
          mesh.castShadow    = true;
          mesh.receiveShadow = true;
          scene.add(mesh);
          frameObject(mesh);
          markReady();
        },
        undefined,
        (err) => { console.error(err); markError('Could not load STL preview.'); }
      );
    } else if (loaderType === 'obj') {
      const loader = new OBJLoader();
      loader.load(
        fileUrl,
        (group) => {
          if (disposed) return;

          group.traverse((child) => {
            if (child.isMesh) {
              child.material = baseMaterial;
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });

          scene.add(group);
          frameObject(group);
          markReady();
        },
        undefined,
        (err) => { console.error(err); markError('Could not load OBJ preview.'); }
      );
    } else if (loaderType === 'step' || loaderType === 'iges') {
      // Remove the base material entry; occt import provides its own materials.
      sceneData.current.materials = [];

      (async () => {
        try {
          const [occt, resp] = await Promise.all([
            loadOcctImport(),
            fetch(fileUrl, { signal: abortController.signal }),
          ]);

          if (!resp.ok) throw new Error(`Failed to fetch file (${resp.status}).`);
          const buf = await resp.arrayBuffer();
          const fileBytes = new Uint8Array(buf);

          const result = loaderType === 'step'
            ? occt.ReadStepFile(fileBytes, null)
            : occt.ReadIgesFile(fileBytes, null);

          const meshes = Array.isArray(result?.meshes) ? result.meshes : [];
          const root = result?.root;

          if (!meshes.length || !root) {
            markError('Could not parse the CAD file for preview.');
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
                color: Array.isArray(m?.color) ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : 0x6b7cff,
                roughness: 0.4,
                metalness: 0.05,
                side: THREE.DoubleSide,
              });

              sceneData.current.materials.push(mtl);

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

          if (disposed) return;

          const model = buildNode(root);
          model.name = 'cad_model';
          scene.add(model);
          frameObject(model);
          markReady();
        } catch (e) {
          if (abortController.signal.aborted) return;
          console.error(e);
          markError('Could not load STEP/IGES preview.');
        }
      })();
    } else if (loaderType === 'dxf') {
      // Remove base material from wireframe list (DXF is lines).
      sceneData.current.materials = [];

      (async () => {
        try {
          const resp = await fetch(fileUrl, { signal: abortController.signal });
          const contentType = resp.headers.get('content-type') || '';
          const text = await resp.text();

          const asJsonError = () => {
            try {
              const j = JSON.parse(text);
              const msg = [j?.error, j?.hint].filter(Boolean).join('\n');
              return msg || `Failed to load DXF preview (${resp.status}).`;
            } catch {
              return `Failed to load DXF preview (${resp.status}).`;
            }
          };

          if (!resp.ok) {
            markError(asJsonError());
            return;
          }

          if (contentType.includes('application/json')) {
            markError(asJsonError());
            return;
          }

          const parser = new DxfParser();
          let doc;
          try {
            doc = parser.parseSync(text);
          } catch (e) {
            console.error(e);
            setRawText(text.slice(0, 200_000));
            setShowRaw(true);
            markError('DXF preview parse failed. Showing raw file content.');
            return;
          }

          const group = new THREE.Group();
          group.name = 'dxf_model';

          const points = [];
          const toPoint = (p) => {
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
          };

          const pushSegment = (a, b) => {
            const pa = toPoint(a);
            const pb = toPoint(b);
            if (!pa || !pb) return;
            points.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
          };

          const addArc = (center, radius, startDeg, endDeg) => {
            const c = toPoint(center);
            const r = Number(radius);
            let s = Number(startDeg);
            let e = Number(endDeg);
            if (!c || !Number.isFinite(r) || !Number.isFinite(s) || !Number.isFinite(e)) return;
            if (e < s) e += 360;

            const steps = 64;
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
              if (prev) pushSegment(prev, p);
              prev = p;
            }
          };

          try {
            for (const ent of (doc?.entities || [])) {
              if (!ent || !ent.type) continue;

              if (ent.type === 'LINE') {
                pushSegment(ent.start, ent.end);
              } else if (ent.type === 'LWPOLYLINE' && Array.isArray(ent.vertices)) {
                for (let i = 1; i < ent.vertices.length; i++) {
                  pushSegment(ent.vertices[i - 1], ent.vertices[i]);
                }
                if ((ent.shape || ent.closed) && ent.vertices.length >= 2) {
                  pushSegment(ent.vertices[ent.vertices.length - 1], ent.vertices[0]);
                }
              } else if (ent.type === 'POLYLINE' && Array.isArray(ent.vertices)) {
                for (let i = 1; i < ent.vertices.length; i++) {
                  pushSegment(ent.vertices[i - 1], ent.vertices[i]);
                }
                if (ent.closed && ent.vertices.length >= 2) {
                  pushSegment(ent.vertices[ent.vertices.length - 1], ent.vertices[0]);
                }
              } else if (ent.type === 'CIRCLE') {
                addArc(ent.center, ent.radius, 0, 360);
              } else if (ent.type === 'ARC') {
                addArc(ent.center, ent.radius, ent.startAngle, ent.endAngle);
              }
            }
          } catch (e) {
            console.error(e);
            setRawText(text.slice(0, 200_000));
            setShowRaw(true);
            markError('DXF preview render failed. Showing raw file content.');
            return;
          }

          if (!points.length) {
            setRawText(text.slice(0, 200_000));
            setShowRaw(true);
            markError('DXF preview: no supported entities found. Showing raw file content.');
            return;
          }

          if (disposed) return;

          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
          const lineMat = new THREE.LineBasicMaterial({ color: 0x6b7cff });
          const lines = new THREE.LineSegments(geom, lineMat);
          group.add(lines);
          scene.add(group);

          // For 2D DXF, set a top-down view.
          const box    = new THREE.Box3().setFromObject(group);
          const center = new THREE.Vector3();
          const size   = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);
          group.position.sub(center);
          grid.position.y = -size.y / 2;

          const maxDim = Math.max(size.x, size.y, size.z || 0.0001);
          const fovRad = (camera.fov * Math.PI) / 180;
          let camDist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.8;
          camDist = Math.max(camDist, 1);
          camera.position.set(0, 0, camDist);
          camera.lookAt(0, 0, 0);
          controls.target.set(0, 0, 0);
          controls.update();

          markReady();
        } catch (e) {
          if (abortController.signal.aborted) return;
          console.error(e);
          const msg = e?.message ? `Could not load DXF preview.\n${e.message}` : 'Could not load DXF preview.';
          markError(msg);
        }
      })();
    } else {
      markError('__no_viewer__');
    }

    // Animation loop
    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize
    const onResize = () => {
      const { width: w, height: h } = mount.getBoundingClientRect();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      abortController.abort();

      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();

      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [fileUrl, loaderType]);

  const toggleWireframe = () => {
    const mats = sceneData.current?.materials || [];
    if (!mats.length) return;

    const next = !wireframe;
    for (const m of mats) m.wireframe = next;
    setWireframe(next);
  };

  if (error === '__no_viewer__') {
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
          <button style={styles.toolBtn} onClick={toggleWireframe}>
            {wireframe ? 'Solid' : 'Wireframe'}
          </button>
          {rawText && (
            <button style={styles.toolBtn} onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? '3D' : 'Raw'}
            </button>
          )}
        </div>
      </div>

      {/* Canvas mount */}
      <div ref={mountRef} style={styles.canvas} />

      {/* Loading overlay */}
      {loading && (
        <div style={styles.loadingOverlay}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>Loading model…</p>
        </div>
      )}

      {/* Error */}
      {error && error !== '__no_viewer__' && !showRaw && (
        <div style={styles.errorOverlay}>{error}</div>
      )}

      {/* Raw DXF fallback */}
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
      {!loading && !error && (
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
};
