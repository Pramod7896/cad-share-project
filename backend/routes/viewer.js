// routes/viewer.js
// Handles:
//   GET  /api/viewer/:token/info     - returns metadata + increments view counter
//   GET  /api/viewer/:token/file     - streams the original CAD file (inline by default)
//   GET  /api/viewer/:token/preview  - streams a preview version (e.g. DWG -> DXF)
//   POST /api/viewer/:token/release  - releases single-viewer lock

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { stmts } = require('../db/database');
const { singleViewerGuard, releaseLock } = require('../middleware/sessionLock');
const { consumeBypassIfValid } = require('../utils/uploadViewBypass');

const router = express.Router();

// Prevent accidental double-counts (e.g. React 18 StrictMode effect re-runs in dev,
// quick refreshes, or retries) from consuming multiple views for the same client.
// Keyed by token + sessionId/ip and expires quickly.
const viewDedupe = new Map(); // key -> timeout handle
const VIEW_DEDUPE_TTL_MS = 10_000;
const tokenDedupe = new Map(); // token -> timeout handle
const TOKEN_DEDUPE_TTL_MS = 2_000;

function markViewedOnce(dedupeKey) {
  if (viewDedupe.has(dedupeKey)) return false;
  const handle = setTimeout(() => viewDedupe.delete(dedupeKey), VIEW_DEDUPE_TTL_MS);
  viewDedupe.set(dedupeKey, handle);
  return true;
}

function markTokenViewedOnce(token) {
  if (tokenDedupe.has(token)) return false;
  const handle = setTimeout(() => tokenDedupe.delete(token), TOKEN_DEDUPE_TTL_MS);
  tokenDedupe.set(token, handle);
  return true;
}

function resolveCadFilePath(row) {
  // Support both absolute paths (older DB rows) and relative paths:
  // - "uploads/<stored_name>" (recommended)
  // - "<stored_name>" (filename only)
  const filePath = row.file_path;

  const uploadsDir = path.resolve(__dirname, '..', 'uploads');
  const backendRoot = path.resolve(__dirname, '..');

  const normalized = String(filePath || '').replace(/^[\\/]+/, '');
  const isUploadsRelative = /^uploads[\\/]/i.test(normalized);

  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : isUploadsRelative
      ? path.resolve(backendRoot, normalized)
      : path.resolve(uploadsDir, normalized);

  const relativeToUploads = path.relative(uploadsDir, resolved);
  const isInsideUploads =
    relativeToUploads &&
    !relativeToUploads.startsWith('..') &&
    !path.isAbsolute(relativeToUploads);

  return { uploadsDir, resolved, isInsideUploads };
}

function streamFile(res, filePath, fileName, mimeType, dispositionType = 'inline') {
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Disposition',
    `${dispositionType}; filename="${encodeURIComponent(fileName)}"`
  );

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', (err) => {
    console.error('[viewer/stream] Stream error:', err);
    res.status(500).end();
  });
}

function safeDetails(message) {
  // Avoid leaking server paths; keep details helpful but generic.
  const s = String(message || '');
  return s
    .replace(/[A-Za-z]:\\\\[^\\s"]+/g, '<path>')
    .replace(/\/[^\\s"]+/g, '<path>');
}

function runTemplateCommand(template, vars, opts = {}) {
  const quoted = (v) => `"${String(v).replace(/\"/g, '\\"')}"`;
  const cmd = String(template || '')
    .replace(/\{input\}/g, quoted(vars.input))
    .replace(/\{output\}/g, quoted(vars.output))
    .replace(/\{format\}/g, String(vars.format || ''))
    .trim();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, windowsHide: true, ...opts });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const combined = [stderr, stdout].filter(Boolean).join('\n').slice(0, 8000);
      reject(new Error(`Command failed (exit ${code}): ${combined}`));
    });
  });
}

async function ensureDwgConvertedToDxf(row) {
  const originalExt = path.extname(row.file_name || '').toLowerCase();
  if (originalExt !== '.dwg') return null;

  const { uploadsDir, resolved: srcPath, isInsideUploads } = resolveCadFilePath(row);
  if (!isInsideUploads) {
    const err = new Error('Forbidden.');
    err.code = 'FORBIDDEN';
    throw err;
  }
  if (!fs.existsSync(srcPath)) {
    const err = new Error('File not found on server.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const previewsDir = path.resolve(uploadsDir, 'previews');
  fs.mkdirSync(previewsDir, { recursive: true });

  const storedBase = path.basename(row.stored_name || 'file', path.extname(row.stored_name || ''));
  const outPath = path.resolve(previewsDir, `${storedBase}.dxf`);

  const srcStat = fs.statSync(srcPath);
  const outExists = fs.existsSync(outPath);
  const outFresh = outExists ? fs.statSync(outPath).mtimeMs >= srcStat.mtimeMs : false;

  if (!outFresh) {
    const template = String(process.env.DWG2DXF_CMD || '').trim();
    if (!template) {
      const err = new Error('DWG preview is not configured on the server.');
      err.code = 'DWG2DXF_NOT_CONFIGURED';
      throw err;
    }

    const backendRoot = path.resolve(__dirname, '..');
    await runTemplateCommand(template, { input: srcPath, output: outPath }, { cwd: backendRoot });

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      const err = new Error('DWG preview conversion did not produce a DXF output.');
      err.code = 'DWG2DXF_NO_OUTPUT';
      throw err;
    }
  }

  return outPath;
}

// GET /api/viewer/:token/info
// Called by the frontend BEFORE showing the viewer.
// Increments the view counter and returns file metadata.
router.get('/:token/info', async (req, res) => {
  const { token } = req.params;
  const sessionId = req.headers['x-session-id'] || req.ip;
  const uploadBypass = req.headers['x-upload-bypass'];

  try {
    const row = await stmts.getByToken(token);

    if (!row) {
      return res.status(404).json({ error: 'Link not found.' });
    }

    if (row.status === 'expired') {
      return res.status(410).json({
        error: 'This link has expired. Maximum view limit reached.',
        expired: true,
      });
    }

    // Single-viewer guard (optional - add single_viewer column to DB if needed)
    const guard = singleViewerGuard(row.single_viewer === 1, token, sessionId);
    if (!guard.allowed) {
      return res.status(423).json({ error: guard.message, locked: true });
    }

    const dedupeKey = `${token}:${sessionId}`;

    // Atomically increment + expire if needed, but guard against duplicate /info
    // calls on initial render/refresh.
    const skipCount = consumeBypassIfValid(token, req.ip, uploadBypass);
    const shouldIncrement = !skipCount && markTokenViewedOnce(token) && markViewedOnce(dedupeKey);
    const updated = shouldIncrement
      ? await stmts.recordView(token, row.max_views)
      : await stmts.getByToken(token);

    return res.json({
      file_name: updated.file_name,
      file_size: updated.file_size,
      mime_type: updated.mime_type,
      current_views: updated.current_views,
      max_views: updated.max_views,
      status: updated.status,
      created_at: updated.created_at,
      view_counted: shouldIncrement,
    });
  } catch (err) {
    console.error('[viewer/info] Error:', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/viewer/:token/file
// Streams the CAD file - no direct disk access from outside.
router.get('/:token/file', async (req, res) => {
  const { token } = req.params;

  try {
    const row = await stmts.getByToken(token);

    if (!row) return res.status(404).send('Not found.');
    if (row.status === 'expired') return res.status(410).send('Link expired.');

    const { resolved, isInsideUploads } = resolveCadFilePath(row);
    if (!isInsideUploads) return res.status(403).send('Forbidden.');

    if (!fs.existsSync(resolved)) {
      return res.status(404).send('File not found on server.');
    }

    const dispositionType = req.query.download === '1' ? 'attachment' : 'inline';
    return streamFile(res, resolved, row.file_name, row.mime_type, dispositionType);
  } catch (err) {
    console.error('[viewer/file] Error:', err);
    return res.status(500).send('Server error.');
  }
});

// GET /api/viewer/:token/preview
// For formats that need server-side conversion for preview (currently DWG -> DXF).
router.get('/:token/preview', async (req, res) => {
  const { token } = req.params;

  try {
    const row = await stmts.getByToken(token);

    if (!row) return res.status(404).send('Not found.');
    if (row.status === 'expired') return res.status(410).send('Link expired.');

    const originalExt = path.extname(row.file_name || '').toLowerCase();

    // Nothing to convert; serve original.
    if (originalExt !== '.dwg') {
      return res.redirect(302, `/api/viewer/${encodeURIComponent(token)}/file`);
    }

    const outPath = await ensureDwgConvertedToDxf(row);
    return streamFile(res, outPath, row.file_name.replace(/\.dwg$/i, '.dxf'), 'application/dxf', 'inline');
  } catch (err) {
    console.error('[viewer/preview] Error:', err);
    const details = safeDetails(err?.message || err);
    if (err?.code === 'DWG2DXF_NOT_CONFIGURED') {
      return res.status(501).json({
        error: 'DWG preview is not configured on the server.',
        hint: 'Set DWG2DXF_CMD to a command that converts {input} -> {output} (e.g. using ODA File Converter or LibreDWG dwg2dxf).',
      });
    }
    return res.status(500).json({
      error: 'DWG->DXF conversion failed on the server.',
      details,
      hint: 'Verify ODA File Converter is installed and DWG2DXF_CMD/ODA_FILE_CONVERTER are set, then restart the backend.',
    });
  }
});

// GET /api/viewer/:token/render?format=svg|png
// Renders a 2D sheet preview server-side for pixel-perfect viewing.
router.get('/:token/render', async (req, res) => {
  const { token } = req.params;
  const format = String(req.query.format || 'svg').toLowerCase();
  const force = String(req.query.force || '').toLowerCase();
  const forceRender = force === '1' || force === 'true' || force === 'yes';

  if (!['svg', 'png'].includes(format)) {
    return res.status(400).json({ error: 'format must be svg or png.' });
  }

  try {
    const row = await stmts.getByToken(token);
    if (!row) return res.status(404).send('Not found.');
    if (row.status === 'expired') return res.status(410).send('Link expired.');

    const originalExt = path.extname(row.file_name || '').toLowerCase();
    const backendRoot = path.resolve(__dirname, '..');

    let inputPath;
    let inputStat;
    if (originalExt === '.dwg') {
      inputPath = await ensureDwgConvertedToDxf(row);
      inputStat = fs.statSync(inputPath);
    } else if (originalExt === '.dxf') {
      const { resolved, isInsideUploads } = resolveCadFilePath(row);
      if (!isInsideUploads) return res.status(403).send('Forbidden.');
      if (!fs.existsSync(resolved)) return res.status(404).send('File not found on server.');
      inputPath = resolved;
      inputStat = fs.statSync(inputPath);
    } else {
      return res.redirect(302, `/api/viewer/${encodeURIComponent(token)}/file`);
    }

    const { uploadsDir } = resolveCadFilePath(row);
    const renderDir = path.resolve(uploadsDir, 'previews', 'render');
    fs.mkdirSync(renderDir, { recursive: true });

    const storedBase = path.basename(row.stored_name || 'file', path.extname(row.stored_name || ''));
    const outPath = path.resolve(renderDir, `${storedBase}.${format}`);

    const outExists = fs.existsSync(outPath);

    // Consider renderer changes when deciding whether cached output is fresh.
    let freshnessMtimeMs = inputStat.mtimeMs;
    const templateForFreshness = String(process.env.CAD_RENDER_CMD || '').trim();
    const backendRootForFreshness = path.resolve(__dirname, '..');
    const deps = [];
    if (/render-cad\.ps1/i.test(templateForFreshness)) {
      deps.push(path.resolve(backendRootForFreshness, 'tools', 'render-cad.ps1'));
      deps.push(path.resolve(backendRootForFreshness, 'scripts', 'dxf-render-svg.js'));
    }
    if (/dxf-render-svg\.js/i.test(templateForFreshness)) {
      deps.push(path.resolve(backendRootForFreshness, 'scripts', 'dxf-render-svg.js'));
    }
    for (const dep of deps) {
      try {
        if (fs.existsSync(dep)) freshnessMtimeMs = Math.max(freshnessMtimeMs, fs.statSync(dep).mtimeMs);
      } catch {
        // ignore
      }
    }

    const outFresh = !forceRender && outExists ? fs.statSync(outPath).mtimeMs >= freshnessMtimeMs : false;

    if (!outFresh) {
      const template = String(process.env.CAD_RENDER_CMD || '').trim();
      if (!template) {
        return res.status(501).json({
          error: 'Server-side CAD rendering is not configured.',
          hint: 'Set CAD_RENDER_CMD to a command that renders {input} -> {output} (SVG/PNG).',
        });
      }

      await runTemplateCommand(template, { input: inputPath, output: outPath, format }, { cwd: backendRoot });

      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        return res.status(500).json({ error: 'Render command did not produce an output file.' });
      }
    }

    const mime = format === 'svg' ? 'image/svg+xml' : 'image/png';
    return streamFile(res, outPath, `${path.basename(row.file_name, originalExt)}.${format}`, mime, 'inline');
  } catch (err) {
    console.error('[viewer/render] Error:', err);
    const details = safeDetails(err?.message || err);
    if (err?.code === 'DWG2DXF_NOT_CONFIGURED') {
      return res.status(501).json({
        error: 'DWG preview is not configured on the server.',
        hint: 'Set DWG2DXF_CMD to a command that converts {input} -> {output} (e.g. using ODA File Converter or LibreDWG dwg2dxf).',
      });
    }
    return res.status(500).json({
      error: 'Server-side rendering failed.',
      details,
      hint: 'Verify CAD_RENDER_CMD is installed/working on the server and produces the requested format.',
    });
  }
});

// POST /api/viewer/:token/release
// Called when the viewer tab is closed (via navigator.sendBeacon)
router.post('/:token/release', (req, res) => {
  releaseLock(req.params.token);
  res.status(204).end();
});

module.exports = router;
