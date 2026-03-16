# CAD Share â€” Full-Stack Architecture Guide

## Table of Contents
1. [Folder Structure](#folder-structure)
2. [Database Schema](#database-schema)
3. [API Endpoints](#api-endpoints)
4. [File Upload Logic](#file-upload-logic)
5. [View Limit Logic](#view-limit-logic)
6. [CAD Viewer Integration](#cad-viewer-integration)
7. [Security Model](#security-model)
8. [Setup & Run](#setup--run)
9. [PostgreSQL Migration](#postgresql-migration)

---

## Folder Structure

```
cad-share/
â”œâ”€â”€ backend/
â”‚   â”œâ”€â”€ server.js                  # Express entry point, middleware stack
â”‚   â”œâ”€â”€ package.json
â”‚   â”œâ”€â”€ .env                       # PORT, FRONTEND_URL
â”‚   â”œâ”€â”€ data/
â”‚   â”‚   â””â”€â”€ cad_share.db           # SQLite database (auto-created)
â”‚   â”œâ”€â”€ uploads/                   # All CAD files stored here (UUID-named)
â”‚   â”‚   â”œâ”€â”€ 3f9a1bc2-...-.stl
â”‚   â”‚   â””â”€â”€ 7d2e8fa1-...-.dwg
â”‚   â”œâ”€â”€ db/
â”‚   â”‚   â””â”€â”€ database.js            # Schema, prepared statements, transactions
â”‚   â”œâ”€â”€ middleware/
â”‚   â”‚   â”œâ”€â”€ fileValidator.js       # Extension + MIME + size checks
â”‚   â”‚   â””â”€â”€ sessionLock.js         # In-memory single-viewer mutex
â”‚   â””â”€â”€ routes/
â”‚       â”œâ”€â”€ upload.js              # POST /api/upload
â”‚       â””â”€â”€ viewer.js              # GET /api/viewer/:token/info|file
â”‚
â””â”€â”€ frontend/
    â”œâ”€â”€ package.json
    â”œâ”€â”€ public/
    â”‚   â””â”€â”€ index.html
    â””â”€â”€ src/
        â”œâ”€â”€ index.jsx              # React root
        â”œâ”€â”€ App.jsx                # Router (/ and /view/:token)
        â”œâ”€â”€ hooks/
        â”‚   â””â”€â”€ useSessionId.js    # Per-tab session ID (sessionStorage)
        â”œâ”€â”€ pages/
        â”‚   â”œâ”€â”€ UploadPage.jsx     # Drag-drop upload + view limit selector
        â”‚   â””â”€â”€ ViewerPage.jsx     # Token resolution + metadata sidebar
        â””â”€â”€ components/
            â””â”€â”€ CadViewer.jsx      # Three.js WebGL viewer (STL + OBJ)
```

---

## Database Schema

```sql
CREATE TABLE files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name     TEXT    NOT NULL,          -- "bracket_v3.stl" (original name)
  stored_name   TEXT    NOT NULL UNIQUE,   -- "3f9a1bc2-xxxx.stl" (UUID on disk)
  file_path     TEXT    NOT NULL,          -- "/absolute/path/to/uploads/3f9a..."
  file_size     INTEGER NOT NULL,          -- bytes
  mime_type     TEXT    NOT NULL,
  share_token   TEXT    NOT NULL UNIQUE,   -- "abc123xyz..." (20-char nanoid)
  max_views     INTEGER NOT NULL DEFAULT 1,
  current_views INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'active'
                CHECK(status IN ('active', 'expired')),
  uploader_ip   TEXT,
  created_at    DATETIME DEFAULT (datetime('now')),
  expired_at    DATETIME                   -- set when status â†’ 'expired'
);

CREATE INDEX idx_share_token ON files(share_token);
CREATE INDEX idx_status      ON files(status);
```

**Key design decisions:**
- `stored_name` is a UUID â€” no enumerable filenames on disk.
- `share_token` is a 20-character nanoid (URL-safe alphabet) â€” separate from the file UUID so neither leaks the other.
- The `recordView` transaction increments the counter and conditionally expires the link atomically â€” no race condition between two simultaneous viewers.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/upload` | Upload CAD file, returns share URL |
| `GET`  | `/api/viewer/:token/info` | Fetch metadata + increment view count |
| `GET`  | `/api/viewer/:token/file` | Stream the CAD file bytes |
| `POST` | `/api/viewer/:token/release` | Release single-viewer session lock |
| `GET`  | `/health` | Server health check |

### POST /api/upload

**Request** (multipart/form-data):
```
file       â€” the CAD file
max_views  â€” integer 1â€“1000
```

**Response 201:**
```json
{
  "success": true,
  "share_url": "https://app.com/view/abc123xyz...",
  "token": "abc123xyz...",
  "file_name": "bracket_v3.stl",
  "file_size": 2048576,
  "max_views": 5
}
```

**Error responses:**
- `400` â€” missing file, invalid max_views, bad filename
- `413` â€” file exceeds 200 MB
- `415` â€” unsupported file type
- `429` â€” rate limit (10 uploads / 15 min / IP)

---

### GET /api/viewer/:token/info

**Headers:**
```
x-session-id: <per-tab UUID>   (used for single-viewer mode)
```

**Response 200:**
```json
{
  "file_name": "bracket_v3.stl",
  "file_size": 2048576,
  "mime_type": "application/octet-stream",
  "current_views": 3,
  "max_views": 5,
  "status": "active",
  "created_at": "2025-03-16T10:00:00"
}
```

**Error responses:**
- `404` â€” token not found
- `410` â€” link expired (status = 'expired')
- `423` â€” locked by another viewer (single-viewer mode)

---

### GET /api/viewer/:token/file

Streams the raw file bytes. Used directly as the `src` for Three.js loaders.

**Response headers:**
```
Content-Type: application/octet-stream
Content-Disposition: inline; filename="bracket_v3.stl"
Cache-Control: no-store
```

---

## File Upload Logic

```
Client â†’ POST /api/upload (multipart)
           â”‚
           â–¼
     multer.diskStorage
       â€¢ Saves to /uploads/
       â€¢ Filename = uuid4() + original extension
           â”‚
           â–¼
     validateCadFile middleware
       â€¢ Check extension is in allowlist
       â€¢ Check file size â‰¤ 200 MB
       â€¢ Sanitize original filename (path traversal)
           â”‚
           â–¼
     Generate share token
       â€¢ nanoid(20) â€” URL-safe, no lookalike chars
           â”‚
           â–¼
     INSERT into files table
           â”‚
           â–¼
     Return { share_url, token, ... }
```

**Why UUID filenames on disk?**
Even if someone gained SSH access to the server, they cannot reverse a UUID filename back to a share token or original filename â€” the mapping only lives in the database.

---

## View Limit Logic

The core is a single database transaction (`recordView`) that:

1. Increments `current_views` with `UPDATE`
2. Immediately re-reads the row
3. If `current_views >= max_views`, sets `status = 'expired'`

This is done inside `db.transaction()` (SQLite) which is synchronous and serialized â€” guaranteeing no two concurrent requests can both pass a limit check.

```
Request â†’ GET /api/viewer/:token/info
               â”‚
               â–¼
         Lookup token in DB
               â”‚
          â”Œâ”€â”€â”€â”€â”´â”€â”€â”€â”€â”
        Not       Found
        found       â”‚
          â”‚    status = 'expired'?
        404    â”Œâ”€â”€â”€â”€â”´â”€â”€â”€â”€â”
             Yes        No
              â”‚          â”‚
            410      BEGIN TRANSACTION
          (expired)       â”‚
                    current_views += 1
                          â”‚
                    current_views â‰¥ max_views?
                    â”Œâ”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”
                   Yes          No
                    â”‚            â”‚
               status =      COMMIT
               'expired'         â”‚
               COMMIT        Return metadata
                    â”‚
                  Return metadata
                  (status: 'expired')
```

**Frontend behavior on expiry:**
- The `/info` endpoint still returns the metadata with `status: 'expired'`
- The viewer renders normally for the current request (the last allowed view)
- On the next request, `/info` returns HTTP 410 and the frontend shows the expired screen

---

## CAD Viewer Integration

### Supported formats

| Extension | Renderer | Notes |
|-----------|----------|-------|
| `.stl` | Three.js STLLoader | Binary + ASCII STL |
| `.obj` | Three.js OBJLoader | Wavefront OBJ |
| `.step`, `.stp` | occt-import-js (WASM) + Three.js | Converted to triangle meshes in-browser |
| `.iges`, `.igs` | occt-import-js (WASM) + Three.js | Converted to triangle meshes in-browser |
| `.dxf` | dxf-parser + Three.js | Basic 2D entities (LINE/POLYLINE/ARC/CIRCLE) |
| `.dwg` | Server-side DWG->DXF | Requires configuring `DWG2DXF_CMD` on the backend |

### STEP/IGES/DXF preview setup

The frontend uses **occt-import-js** (OpenCascade compiled to WASM) for STEP/IGES, and **dxf-parser** for DXF.

After `npm install`, a `postinstall` script copies the occt-import-js JS + WASM artifacts into:

`frontend/public/vendor/occt-import-js/`

### DWG preview setup

DWG cannot be reliably parsed in-browser. This app supports DWG preview by converting DWG to DXF on the backend.

Set `DWG2DXF_CMD` in `backend/.env` to a command template that converts `{input}` to `{output}`.

Then the viewer will request `GET /api/viewer/:token/preview` for DWG links, and render the produced DXF.

If DWG conversion is not configured (or fails), the viewer will display the backend error + hint message.

**Windows (recommended)**
- Install **ODA File Converter**.
- Set `DWG2DXF_CMD` to use the included helper script:
  - `DWG2DXF_CMD=powershell -NoProfile -ExecutionPolicy Bypass -File tools\\dwg2dxf.ps1 -In {input} -Out {output}`
- Optional: if ODA is not in the default install path, set `ODA_FILE_CONVERTER` (full path to `ODAFileConverter.exe`) in `backend/.env` or your environment.

### Viewer controls

All powered by `OrbitControls`:

| Interaction | Action |
|-------------|--------|
| Left drag | Rotate |
| Right drag | Pan |
| Two-finger drag | Pan |
| Scroll wheel | Zoom |
| Toolbar button | Toggle wireframe |

---

## Security Model

### 1. No direct file access
```javascript
// server.js â€” blocks /uploads/* at the Express level
app.use('/uploads', (_req, res) => {
  res.status(403).json({ error: 'Direct file access is not permitted.' });
});
```

Even if Nginx/Apache were misconfigured to serve static files, Express intercepts first.

### 2. Path traversal prevention
```javascript
const uploadsDir = path.resolve(__dirname, '..', 'uploads');
const resolved   = path.resolve(row.file_path);

if (!resolved.startsWith(uploadsDir)) {
  return res.status(403).send('Forbidden.');
}
```

### 3. File type validation
- Extension must be in the allowlist
- `multer` enforces the 200 MB hard limit before the file hits disk
- `fileValidator` middleware re-validates after multer runs

### 4. Token design
- Tokens are 20-char nanoid â€” alphabet excludes lookalikes (0/O, 1/l/I)
- Entropy: 32^20 â‰ˆ 2^100 â€” brute-force infeasible
- Token â‰  filename â€” knowing one reveals nothing about the other

### 5. Rate limiting
- Upload: 10 requests / 15 min / IP
- Viewer: 120 requests / min / IP

### 6. Single-viewer mode
- In-memory mutex per token
- Auto-released after 5 min idle
- Renewed on every `/info` poll from the same session

---

## Setup & Run

### Prerequisites
- Node.js 18+
- npm 9+

### Backend

```bash
cd backend
npm install

# Create .env
echo "PORT=5000
FRONTEND_URL=http://localhost:3000" > .env

npm run dev   # nodemon for development
# npm start   # production
```

### Frontend

```bash
cd frontend
npm install
npm start     # CRA dev server on :3000, proxy â†’ :5000
```

### Production build

```bash
cd frontend && npm run build
# Serve /frontend/build as static files from Express:
```

```javascript
// Add to server.js for production:
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend/build')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build/index.html'));
});
```

---

## PostgreSQL Migration

Replace `better-sqlite3` with `pg` and adjust the query syntax:

```bash
npm install pg
npm uninstall better-sqlite3
```

```javascript
// db/database.js (PostgreSQL version)
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // connectionString: 'postgresql://user:pass@localhost:5432/cadshare'
});

// recordView becomes an async function using BEGIN/COMMIT
async function recordView(token, maxViews) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE files SET current_views = current_views + 1 WHERE share_token = $1',
      [token]
    );
    const { rows } = await client.query(
      'SELECT * FROM files WHERE share_token = $1', [token]
    );
    const row = rows[0];
    if (row && row.current_views >= maxViews) {
      await client.query(
        "UPDATE files SET status = 'expired', expired_at = NOW() WHERE share_token = $1",
        [token]
      );
    }
    await client.query('COMMIT');
    const final = await pool.query(
      'SELECT * FROM files WHERE share_token = $1', [token]
    );
    return final.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

All route handlers need to become `async` and use `await pool.query(...)` instead of `stmts.xxx.run(...)`.

