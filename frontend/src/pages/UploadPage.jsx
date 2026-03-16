// pages/UploadPage.jsx
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';

const ACCEPTED_EXTENSIONS = ['.dwg','.dxf','.step','.stp','.iges','.igs','.obj','.stl'];

const VIEW_PRESETS = [
  { label: '1 view',   value: 1 },
  { label: '5 views',  value: 5 },
  { label: '10 views', value: 10 },
  { label: '25 views', value: 25 },
  { label: 'Custom',   value: 'custom' },
];

export default function UploadPage() {
  const [file, setFile]         = useState(null);
  const [maxViews, setMaxViews] = useState(5);
  const [customMax, setCustomMax] = useState('');
  const [viewPreset, setViewPreset] = useState(5);
  const [uploading, setUploading]   = useState(false);
  const [result, setResult]         = useState(null);
  const [error, setError]           = useState('');
  const [copied, setCopied]         = useState(false);

  const onDrop = useCallback((accepted) => {
    if (accepted.length) {
      setFile(accepted[0]);
      setError('');
      setResult(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED_EXTENSIONS.reduce((acc, ext) => ({ ...acc, [`application/${ext.slice(1)}`]: [ext] }), {}),
    maxFiles: 1,
    multiple: false,
    onDropRejected: () => setError(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`),
  });

  const effectiveMax = viewPreset === 'custom' ? parseInt(customMax, 10) : viewPreset;

  const handleUpload = async () => {
    if (!file) return setError('Please select a file first.');
    if (isNaN(effectiveMax) || effectiveMax < 1 || effectiveMax > 1000) {
      return setError('Max views must be between 1 and 1000.');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('max_views', effectiveMax);

    setUploading(true);
    setError('');

    try {
      const { data } = await axios.post('/api/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
      setFile(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(result.share_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>CAD File Share</h1>
        <p style={styles.subtitle}>
          Upload a CAD file and get a secure, view-limited shareable link.
        </p>

        {/* Drop zone */}
        <div {...getRootProps()} style={{ ...styles.dropzone, ...(isDragActive ? styles.dropzoneActive : {}) }}>
          <input {...getInputProps()} />
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4 }}>
            <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
          </svg>
          {file ? (
            <p style={styles.fileName}>{file.name} <span style={styles.fileSize}>({(file.size / 1024 / 1024).toFixed(2)} MB)</span></p>
          ) : (
            <p style={styles.dropText}>
              {isDragActive ? 'Drop your CAD file here…' : 'Drag & drop a CAD file, or click to browse'}
            </p>
          )}
          <p style={styles.dropHint}>{ACCEPTED_EXTENSIONS.join('  ')}</p>
        </div>

        {/* View limit selector */}
        <div style={styles.section}>
          <label style={styles.label}>Max views</label>
          <div style={styles.presetRow}>
            {VIEW_PRESETS.map((p) => (
              <button
                key={p.value}
                style={{ ...styles.presetBtn, ...(viewPreset === p.value ? styles.presetBtnActive : {}) }}
                onClick={() => { setViewPreset(p.value); if (p.value !== 'custom') setMaxViews(p.value); }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {viewPreset === 'custom' && (
            <input
              type="number" min="1" max="1000" placeholder="Enter number (1–1000)"
              value={customMax}
              onChange={(e) => setCustomMax(e.target.value)}
              style={styles.customInput}
            />
          )}
        </div>

        {error && <div style={styles.errorBox}>{error}</div>}

        <button
          style={{ ...styles.uploadBtn, ...(uploading ? styles.uploadBtnDisabled : {}) }}
          onClick={handleUpload}
          disabled={uploading || !file}
        >
          {uploading ? 'Uploading…' : 'Upload & Generate Link'}
        </button>

        {/* Success result */}
        {result && (
          <div style={styles.resultBox}>
            <p style={styles.resultTitle}>✓ Link ready</p>
            <div style={styles.linkRow}>
              <span style={styles.linkText}>{result.share_url}</span>
              <button style={styles.copyBtn} onClick={copyLink}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <p style={styles.resultMeta}>
              {result.file_name} · max {result.max_views} view{result.max_views !== 1 ? 's' : ''}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page: {
    minHeight: '100vh',
    background: '#0f1117',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    fontFamily: "'Inter', system-ui, sans-serif",
  },
  card: {
    background: '#1a1d27',
    border: '1px solid #2a2d3e',
    borderRadius: 16,
    padding: '2.5rem',
    width: '100%',
    maxWidth: 560,
  },
  title: { color: '#e8eaf0', fontSize: 26, fontWeight: 600, margin: '0 0 6px' },
  subtitle: { color: '#8b8fa8', fontSize: 14, margin: '0 0 2rem', lineHeight: 1.5 },

  dropzone: {
    border: '1.5px dashed #2a2d3e',
    borderRadius: 12,
    padding: '2rem',
    textAlign: 'center',
    cursor: 'pointer',
    transition: 'border-color 0.2s, background 0.2s',
    background: '#13151f',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
    color: '#8b8fa8',
  },
  dropzoneActive: {
    borderColor: '#5b6af0',
    background: '#1a1d2e',
  },
  dropText: { fontSize: 14, margin: 0, color: '#8b8fa8' },
  dropHint: { fontSize: 11, margin: 0, color: '#555770', letterSpacing: '0.04em' },
  fileName: { fontSize: 14, margin: 0, color: '#c8cade', fontWeight: 500 },
  fileSize: { color: '#8b8fa8', fontWeight: 400 },

  section: { marginTop: '1.5rem' },
  label: { display: 'block', fontSize: 13, color: '#8b8fa8', marginBottom: 10 },
  presetRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  presetBtn: {
    padding: '6px 14px', borderRadius: 8, border: '1px solid #2a2d3e',
    background: '#13151f', color: '#8b8fa8', fontSize: 13, cursor: 'pointer',
    transition: 'all 0.15s',
  },
  presetBtnActive: {
    borderColor: '#5b6af0', background: '#1e2142', color: '#9da8f8',
  },
  customInput: {
    marginTop: 10, width: '100%', boxSizing: 'border-box',
    background: '#13151f', border: '1px solid #2a2d3e', borderRadius: 8,
    color: '#e8eaf0', padding: '8px 12px', fontSize: 14, outline: 'none',
  },

  errorBox: {
    marginTop: '1rem', padding: '10px 14px', borderRadius: 8,
    background: '#2a1520', border: '1px solid #4a2530',
    color: '#f08080', fontSize: 13,
  },

  uploadBtn: {
    marginTop: '1.5rem', width: '100%', padding: '12px',
    background: '#5b6af0', border: 'none', borderRadius: 10,
    color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer',
    transition: 'background 0.2s',
  },
  uploadBtnDisabled: { background: '#2a2d3e', color: '#555770', cursor: 'not-allowed' },

  resultBox: {
    marginTop: '1.5rem', padding: '1rem 1.25rem',
    background: '#0e1f18', border: '1px solid #1a4a35',
    borderRadius: 10,
  },
  resultTitle: { color: '#4ade80', fontSize: 13, fontWeight: 600, margin: '0 0 10px' },
  linkRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#0a1510', borderRadius: 8, padding: '8px 12px',
    border: '1px solid #1a4a35',
  },
  linkText: { color: '#7dd3a8', fontSize: 13, flex: 1, wordBreak: 'break-all' },
  copyBtn: {
    padding: '5px 12px', borderRadius: 6, border: '1px solid #1a4a35',
    background: '#1a4a35', color: '#4ade80', fontSize: 12, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  resultMeta: { color: '#557a66', fontSize: 12, margin: '8px 0 0' },
};
