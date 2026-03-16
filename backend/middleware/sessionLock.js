// middleware/sessionLock.js
// In-memory mutex for single-viewer mode.
// Tracks which tokens are currently being viewed and by whom.
// For multi-process deployments, replace with Redis SETNX.

const activeSessions = new Map(); // token → { sessionId, startedAt, timeout }

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes idle = session released

/**
 * Try to acquire a lock for `token`.
 * Returns { acquired: true, sessionId } on success.
 * Returns { acquired: false, message } if already locked by someone else.
 */
function acquireLock(token, sessionId) {
  const existing = activeSessions.get(token);

  if (existing) {
    if (existing.sessionId === sessionId) {
      // Same viewer refreshed — renew their timeout
      clearTimeout(existing.timeout);
      existing.timeout = setTimeout(() => releaseLock(token), SESSION_TIMEOUT_MS);
      return { acquired: true, sessionId };
    }
    return {
      acquired: false,
      message: 'Another viewer is currently viewing this file. Try again shortly.',
    };
  }

  const timeout = setTimeout(() => releaseLock(token), SESSION_TIMEOUT_MS);
  activeSessions.set(token, { sessionId, startedAt: Date.now(), timeout });
  return { acquired: true, sessionId };
}

function releaseLock(token) {
  const session = activeSessions.get(token);
  if (session) {
    clearTimeout(session.timeout);
    activeSessions.delete(token);
  }
}

function isLocked(token) {
  return activeSessions.has(token);
}

/**
 * Express middleware — enforces single-viewer mode when
 * the file record has `single_viewer = 1` (optional DB column).
 * Pass `singleViewer = true` to enforce.
 */
function singleViewerGuard(singleViewer, token, sessionId) {
  if (!singleViewer) return { allowed: true };
  const result = acquireLock(token, sessionId);
  return result.acquired
    ? { allowed: true }
    : { allowed: false, message: result.message };
}

module.exports = { acquireLock, releaseLock, isLocked, singleViewerGuard };
