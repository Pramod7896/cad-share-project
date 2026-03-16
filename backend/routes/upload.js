// routes/upload.js
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { customAlphabet }  = require('nanoid');
const { stmts }           = require('../db/database');
const { validateCadFile } = require('../middleware/fileValidator');

const router = express.Router();

// ─── Storage config ───────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// UUID-based filenames prevent enumeration and path conflicts
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${uuidv4()}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB hard limit
});

// Token alphabet: URL-safe, no lookalikes (0/O, 1/l)
const nanoid = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 20);

// ─── POST /api/upload ─────────────────────────────────────────────────────────
router.post('/', upload.single('file'), validateCadFile, async (req, res) => {
  try {
    const { file } = req;
    const maxViews = parseInt(req.body.max_views, 10) || 1;

    if (isNaN(maxViews) || maxViews < 1 || maxViews > 1000) {
      // Clean up uploaded file if validation fails
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'max_views must be between 1 and 1000.' });
    }

    const shareToken = nanoid();

    await stmts.insertFile({
      file_name:   file.originalname,
      stored_name: file.filename,
      file_path:   `uploads/${file.filename}`,
      file_size:   file.size,
      mime_type:   req.cadMimeType,
      share_token: shareToken,
      max_views:   maxViews,
      uploader_ip: req.ip,
    });

    const frontendBase = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
    const shareUrl = frontendBase
      ? `${frontendBase}/view/${shareToken}`
      : `${req.protocol}://${req.get('host')}/view/${shareToken}`;

    return res.status(201).json({
      success:    true,
      share_url:  shareUrl,
      token:      shareToken,
      file_name:  file.originalname,
      file_size:  file.size,
      max_views:  maxViews,
    });
  } catch (err) {
    console.error('[upload] Error:', err);
    // If multer wrote the file but DB failed, clean up
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

module.exports = router;
