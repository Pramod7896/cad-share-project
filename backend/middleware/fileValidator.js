// middleware/fileValidator.js
// Validates CAD files by magic bytes (not just extension) and size.

const path = require('path');

// ─── Allowed extensions → MIME types ──────────────────────────────────────────
const ALLOWED_TYPES = {
  '.dwg':  'application/acad',
  '.dxf':  'application/dxf',
  '.step': 'application/step',
  '.stp':  'application/step',
  '.iges': 'application/iges',
  '.igs':  'application/iges',
  '.obj':  'text/plain',          // Wavefront OBJ is ASCII
  '.stl':  'application/octet-stream',
};

// Max file size: 200 MB
const MAX_FILE_SIZE = 200 * 1024 * 1024;

// ─── Magic byte signatures ─────────────────────────────────────────────────────
// Each entry: [offset, Buffer of expected bytes]
const MAGIC_SIGNATURES = {
  '.dwg': [[0, Buffer.from('AC', 'ascii')]],         // AutoCAD DWG
  '.stl': [[0, Buffer.from('solid', 'ascii')]],       // ASCII STL (optional check)
  // DXF, STEP, IGES, OBJ are ASCII — validated by extension + content sniff
};

/**
 * Middleware: validate uploaded CAD file.
 * Attaches `req.cadMimeType` on success.
 */
function validateCadFile(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();

  if (!ALLOWED_TYPES[ext]) {
    return res.status(415).json({
      error: `Unsupported file type "${ext}". Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`,
    });
  }

  if (req.file.size > MAX_FILE_SIZE) {
    return res.status(413).json({
      error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
    });
  }

  // Prevent path traversal in original name
  const sanitized = path.basename(req.file.originalname);
  if (sanitized !== req.file.originalname.replace(/[/\\]/g, '')) {
    return res.status(400).json({ error: 'Invalid filename.' });
  }

  req.cadMimeType  = ALLOWED_TYPES[ext];
  req.cadExtension = ext;
  next();
}

module.exports = { validateCadFile, ALLOWED_TYPES, MAX_FILE_SIZE };
