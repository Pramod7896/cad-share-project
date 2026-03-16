// server.js — CAD Share Backend
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const uploadRoute = require('./routes/upload');
const viewerRoute = require('./routes/viewer');
const { initDatabase } = require('./db/database');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Security headers ─────────────────────────────────────────────────────────
// If you run behind a reverse proxy (nginx, Render, Heroku, etc.), set TRUST_PROXY
// (recommended: "1" for a single proxy) so req.ip is derived from X-Forwarded-For.
// In local/dev, some tools may add X-Forwarded-For even without a proxy; we relax
// express-rate-limit's validation in that case so the server doesn't crash.
function parseTrustProxy(value) {
  if (value === undefined) return undefined;
  const lowered = String(value).trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(lowered)) return false;
  if (['true', 'on', 'yes'].includes(lowered)) return 1; // avoid permissive `true`
  if (/^\\d+$/.test(lowered)) return Number(lowered);
  return value; // e.g. "loopback", "uniquelocal", "127.0.0.1"
}

const configuredTrustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (configuredTrustProxy !== undefined) {
  app.set('trust proxy', configuredTrustProxy);
} else if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const rateLimitValidate =
  app.get('trust proxy') === false ? { xForwardedForHeader: false } : true;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow file streaming
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-session-id'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Share link entrypoint: redirect backend /view/:token to the frontend route.
app.get('/view/:token', (req, res) => {
  const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  if (!base) {
    return res.status(400).json({
      error: 'FRONTEND_URL is not configured on the backend.',
      hint: 'Set FRONTEND_URL (e.g. http://localhost:3000) so /view/:token can redirect.',
    });
  }
  return res.redirect(302, `${base}/view/${req.params.token}`);
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Uploads: max 10 per 15 min per IP
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many uploads from this IP, please try again later.' },
  validate: rateLimitValidate,
});

// Viewer: max 120 requests per minute per IP
const viewerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests, please slow down.' },
  validate: rateLimitValidate,
});

// ─── CRITICAL: Explicitly block direct /uploads access ───────────────────────
// Files must ONLY be served through the viewer API.
app.use('/uploads', (_req, res) => {
  res.status(403).json({ error: 'Direct file access is not permitted.' });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/upload',  uploadLimiter, uploadRoute);
app.use('/api/viewer',  viewerLimiter, viewerRoute);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// 404 for everything else
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Initialize database and then start server
async function startServer() {
  try {
    console.log('Initializing database...');
    await initDatabase();
    console.log('Database initialized successfully.');
    
    app.listen(PORT, () => {
      console.log(`✓ CAD Share backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
