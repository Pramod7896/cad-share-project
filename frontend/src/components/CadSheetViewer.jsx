import React, { useEffect, useMemo, useRef, useState } from 'react';

function parseMaybeJsonError(text) {
  try {
    const j = JSON.parse(text);
    const msg = [j?.error, j?.details, j?.hint].filter(Boolean).join('\n');
    return msg || null;
  } catch {
    return null;
  }
}

async function fetchAsBlob(url, signal) {
  const resp = await fetch(url, { signal });
  const contentType = resp.headers.get('content-type') || '';
  const text = contentType.includes('application/json') ? await resp.text() : null;

  if (!resp.ok) {
    const msg = text ? (parseMaybeJsonError(text) || text) : `Request failed (${resp.status}).`;
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }

  if (text) {
    const msg = parseMaybeJsonError(text) || 'Server returned an error.';
    throw new Error(msg);
  }

  const blob = await resp.blob();
  return { blob, contentType };
}

export default function CadSheetViewer({ svgUrl, pngUrl, title, fallback }) {
  const containerRef = useRef(null);
  const imgRef = useRef(null);
  const [state, setState] = useState({ status: 'loading', src: '', error: '' }); // loading | ready | error
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [showFallback, setShowFallback] = useState(false);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  const reset = () => setTransform({ x: 0, y: 0, scale: 1 });

  const fit = () => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img) return;

    const cw = container.clientWidth || 0;
    const ch = container.clientHeight || 0;
    const iw = img.naturalWidth || img.width || 0;
    const ih = img.naturalHeight || img.height || 0;
    if (!cw || !ch || !iw || !ih) return;

    const pad = 32;
    const nextScale = Math.min((cw - pad) / iw, (ch - pad) / ih);
    setTransform({ x: 0, y: 0, scale: Math.min(20, Math.max(0.1, nextScale)) });
  };

  useEffect(() => {
    const abortController = new AbortController();
    let objectUrl = '';

    setState({ status: 'loading', src: '', error: '' });
    reset();
    setShowFallback(false);

    (async () => {
      try {
        const { blob } = await fetchAsBlob(svgUrl, abortController.signal);
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', src: objectUrl, error: '' });
      } catch (e1) {
        if (pngUrl) {
          try {
            const { blob } = await fetchAsBlob(pngUrl, abortController.signal);
            objectUrl = URL.createObjectURL(blob);
            setState({ status: 'ready', src: objectUrl, error: '' });
            return;
          } catch (e2) {
            setState({ status: 'error', src: '', error: e2?.message || e1?.message || 'Could not load preview.' });
            return;
          }
        }
        setState({ status: 'error', src: '', error: e1?.message || 'Could not load preview.' });
      }
    })();

    return () => {
      abortController.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [svgUrl, pngUrl]);

  const style = useMemo(() => ({
    transform: `translate(-50%, -50%) translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
  }), [transform]);

  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.12 : 1 / 1.12;

    setTransform((t) => {
      const nextScale = Math.min(20, Math.max(0.1, t.scale * factor));
      return { ...t, scale: nextScale };
    });
  };

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: transform.x,
      originY: transform.y,
    };
  };

  const onPointerMove = (e) => {
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setTransform((t) => ({ ...t, x: dragRef.current.originX + dx, y: dragRef.current.originY + dy }));
  };

  const onPointerUp = () => {
    dragRef.current.dragging = false;
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <span style={styles.title}>{title}</span>
        <div style={styles.actions}>
          <button style={styles.btn} onClick={fit}>Fit</button>
          <button style={styles.btn} onClick={reset}>Reset</button>
        </div>
      </div>

      <div
        ref={containerRef}
        style={styles.stage}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
      >
        {state.status === 'loading' && (
          <div style={styles.overlay}>
            <div style={styles.spinner} />
            <p style={styles.text}>Rendering preview…</p>
          </div>
        )}

        {state.status === 'error' && (
          <div style={styles.overlay}>
            <p style={styles.error}>{state.error}</p>
            {fallback && (
              <button style={styles.btn} onClick={() => setShowFallback(true)}>
                Open Interactive Viewer
              </button>
            )}
          </div>
        )}

        {showFallback && fallback}

        {state.status === 'ready' && !showFallback && (
          <img
            ref={imgRef}
            src={state.src}
            alt={title || 'CAD preview'}
            draggable={false}
            onLoad={fit}
            style={{ ...styles.img, ...style }}
          />
        )}
      </div>
    </div>
  );
}

const styles = {
  wrap: { position: 'relative', width: '100%', height: '100%', background: '#0f1117' },
  toolbar: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: 'rgba(15,17,23,0.85)', backdropFilter: 'blur(8px)',
    padding: '10px 16px', borderBottom: '1px solid #1e2130',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  title: { color: '#c8cade', fontSize: 13, fontWeight: 500 },
  actions: { display: 'flex', gap: 8 },
  btn: {
    padding: '5px 12px', borderRadius: 6, border: '1px solid #2a2d3e',
    background: '#1a1d27', color: '#8b8fa8', fontSize: 12, cursor: 'pointer',
  },
  stage: {
    position: 'absolute', inset: 0,
    overflow: 'hidden',
    touchAction: 'none',
    cursor: 'grab',
  },
  img: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transformOrigin: 'center center',
    userSelect: 'none',
    pointerEvents: 'none',
    maxWidth: 'none',
    maxHeight: 'none',
  },
  overlay: {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: 12,
    fontFamily: "'Inter', system-ui, sans-serif",
    padding: 24,
    textAlign: 'center',
    color: '#8b8fa8',
  },
  spinner: {
    width: 36, height: 36, border: '3px solid #2a2d3e',
    borderTopColor: '#5b6af0', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  text: { margin: 0, fontSize: 13 },
  error: { margin: 0, fontSize: 14, color: '#f08080', whiteSpace: 'pre-wrap' },
};
