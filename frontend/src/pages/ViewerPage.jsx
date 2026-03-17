// pages/ViewerPage.jsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';
import CadViewer from '../components/CadViewer';
import CadSheetViewer from '../components/CadSheetViewer';
import { useSessionId } from '../hooks/useSessionId';

const API = '/api/viewer';

export default function ViewerPage() {
  const { token }  = useParams();
  const sessionId  = useSessionId();

  const [state, setState] = useState('loading'); // loading | ready | expired | locked | error
  const [meta, setMeta]   = useState(null);
  const [msg, setMsg]     = useState('');
  const [copied, setCopied] = useState(false);

  const shareUrl = token ? `${window.location.origin}/view/${token}` : '';

  const originalName = meta?.file_name;
  const isDwg = /\.dwg$/i.test(originalName || '');
  const isDxf = /\.dxf$/i.test(originalName || '');
  const fileUrl = isDwg ? `${API}/${token}/preview` : `${API}/${token}/file`;
  const viewerFileName = isDwg ? originalName.replace(/\.dwg$/i, '.dxf') : originalName;

  const renderSvgUrl = `${API}/${token}/render?format=svg`;
  // Keep PNG optional. Many render pipelines (like dxf2svg) only support SVG.
  // If you later add PNG rendering on the backend, set this to `.../render?format=png`.
  const renderPngUrl = undefined;

  useEffect(() => {
    if (!token) return;

    const uploadBypass = sessionStorage.getItem(`upload_bypass:${token}`);

    axios.get(`${API}/${token}/info`, {
      headers: {
        'x-session-id': sessionId,
        ...(uploadBypass ? { 'x-upload-bypass': uploadBypass } : {}),
      },
    })
    .then(({ data }) => {
      setMeta(data);
      setState(data.status === 'expired' ? 'expired' : 'ready');
    })
    .catch((err) => {
      const { status, data } = err.response || {};
      if (status === 404) { setState('error'); setMsg('This link does not exist.'); }
      else if (status === 410) { setState('expired'); setMsg(data?.error); }
      else if (status === 423) { setState('locked'); setMsg(data?.error); }
      else { setState('error'); setMsg('Something went wrong.'); }
    })
    .finally(() => {
      if (uploadBypass) sessionStorage.removeItem(`upload_bypass:${token}`);
    });

    // Release single-viewer lock when tab closes
    return () => {
      navigator.sendBeacon(`${API}/${token}/release`);
    };
  }, [token, sessionId]);

  const copyShareLink = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  if (state === 'loading') return <StatusScreen icon="⏳" title="Loading…" />;

  if (state === 'expired') return (
    <StatusScreen
      icon="🔒"
      title="Link Expired"
      body={msg || 'This link has expired. Maximum view limit reached.'}
      accent="#f08080"
    />
  );

  if (state === 'locked') return (
    <StatusScreen
      icon="👁"
      title="Currently Viewing"
      body={msg || 'Another viewer is currently viewing this file. Try again shortly.'}
      accent="#fbbf24"
    />
  );

  if (state === 'error') return (
    <StatusScreen icon="❌" title="Not Found" body={msg || 'This link does not exist.'} />
  );

  return (
    <div style={styles.page}>
      {/* Sidebar metadata */}
      <aside style={styles.sidebar}>
        <h2 style={styles.sidebarTitle}>CAD Viewer</h2>
        {meta && (
          <>
            <div style={styles.metaGroup}>
              <p style={styles.metaLabel}>Share</p>
              <div style={styles.shareRow}>
                <span style={styles.shareText}>{shareUrl}</span>
                <button style={styles.shareBtn} onClick={copyShareLink}>
                  {copied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div style={styles.metaGroup}>
              <p style={styles.metaLabel}>File</p>
              <p style={styles.metaValue}>{meta.file_name}</p>
            </div>
            <div style={styles.metaGroup}>
              <p style={styles.metaLabel}>Size</p>
              <p style={styles.metaValue}>{(meta.file_size / 1024 / 1024).toFixed(2)} MB</p>
            </div>
            <div style={styles.metaGroup}>
              <p style={styles.metaLabel}>Views</p>
              <ViewMeter current={meta.current_views} max={meta.max_views} />
            </div>
            <div style={styles.metaGroup}>
              <p style={styles.metaLabel}>Status</p>
              <span style={{
                ...styles.badge,
                background: meta.status === 'active' ? '#0e2a1e' : '#2a1520',
                color:      meta.status === 'active' ? '#4ade80' : '#f08080',
                borderColor:meta.status === 'active' ? '#1a4a35' : '#4a2530',
              }}>
                {meta.status}
              </span>
            </div>
            {meta.status === 'expired' && (
              <div style={styles.expiredBanner}>
                Maximum view limit reached — this link is now expired.
              </div>
            )}
          </>
        )}
      </aside>

      {/* 3D Viewer */}
      <main style={styles.viewer}>
        {(isDwg || isDxf) ? (
          <CadSheetViewer
            svgUrl={renderSvgUrl}
            pngUrl={renderPngUrl}
            title={originalName}
            fallback={(
              <CadViewer
                fileUrl={fileUrl}
                fileName={viewerFileName}
                displayName={originalName}
                mimeType={meta?.mime_type}
              />
            )}
          />
        ) : (
          <CadViewer
            fileUrl={fileUrl}
            fileName={viewerFileName}
            displayName={originalName}
            mimeType={meta?.mime_type}
          />
        )}
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ViewMeter({ current, max }) {
  const pct = Math.min((current / max) * 100, 100);
  const color = pct >= 100 ? '#f08080' : pct >= 80 ? '#fbbf24' : '#4ade80';
  return (
    <div>
      <p style={{ color: '#c8cade', fontSize: 13, margin: '0 0 6px' }}>
        {current} / {max}
      </p>
      <div style={{ background: '#1a1d27', borderRadius: 4, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4,
                      transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

function StatusScreen({ icon, title, body, accent = '#8b8fa8' }) {
  return (
    <div style={{
      minHeight: '100vh', background: '#0f1117', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', system-ui, sans-serif", padding: '2rem', textAlign: 'center',
      gap: 16,
    }}>
      <span style={{ fontSize: 48 }}>{icon}</span>
      <h1 style={{ color: accent, fontSize: 24, fontWeight: 600, margin: 0 }}>{title}</h1>
      {body && <p style={{ color: '#8b8fa8', fontSize: 15, margin: 0, maxWidth: 400, lineHeight: 1.6 }}>{body}</p>}
      <a href="/" style={{ marginTop: 8, color: '#5b6af0', fontSize: 13 }}>← Upload a new file</a>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page: {
    display: 'flex', height: '100vh', overflow: 'hidden',
    background: '#0f1117', fontFamily: "'Inter', system-ui, sans-serif",
  },
  sidebar: {
    width: 240, minWidth: 220, padding: '1.5rem',
    background: '#1a1d27', borderRight: '1px solid #2a2d3e',
    overflowY: 'auto', flexShrink: 0,
  },
  sidebarTitle: { color: '#e8eaf0', fontSize: 16, fontWeight: 600, margin: '0 0 1.5rem' },
  metaGroup: { marginBottom: '1.25rem' },
  metaLabel: { color: '#555770', fontSize: 11, textTransform: 'uppercase',
               letterSpacing: '0.06em', margin: '0 0 4px' },
  metaValue: { color: '#c8cade', fontSize: 13, margin: 0, wordBreak: 'break-word' },
  shareRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#13151f', borderRadius: 8, padding: '8px 10px',
    border: '1px solid #2a2d3e',
  },
  shareText: { color: '#c8cade', fontSize: 12, flex: 1, wordBreak: 'break-all', lineHeight: 1.35 },
  shareBtn: {
    padding: '5px 10px', borderRadius: 6, border: '1px solid #2a2d3e',
    background: '#1e2142', color: '#9da8f8', fontSize: 12, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  badge: {
    display: 'inline-block', padding: '3px 10px', borderRadius: 6,
    fontSize: 12, fontWeight: 500, border: '1px solid',
  },
  expiredBanner: {
    marginTop: '1rem', padding: '10px 12px', borderRadius: 8,
    background: '#2a1520', border: '1px solid #4a2530',
    color: '#f08080', fontSize: 12, lineHeight: 1.5,
  },
  viewer: { flex: 1, overflow: 'hidden' },
};
