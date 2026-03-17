// backend/utils/uploadViewBypass.js
// One-time bypass token used to avoid counting the immediate post-upload open as a "view".
// Stored in-memory (per backend process) and expires quickly.

const { customAlphabet } = require('nanoid');

const nanoid = customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', 32);
const BYPASS_TTL_MS = 2 * 60 * 1000; // 2 minutes

// shareToken -> { secret, expiresAt, timeoutHandle }
const bypasses = new Map();

function createBypass(shareToken) {
  const secret = nanoid();
  const expiresAt = Date.now() + BYPASS_TTL_MS;

  const existing = bypasses.get(shareToken);
  if (existing?.timeoutHandle) clearTimeout(existing.timeoutHandle);

  const timeoutHandle = setTimeout(() => {
    const cur = bypasses.get(shareToken);
    if (cur?.secret === secret) bypasses.delete(shareToken);
  }, BYPASS_TTL_MS).unref?.();

  bypasses.set(shareToken, { secret, expiresAt, timeoutHandle });
  return secret;
}

function consumeBypassIfValid(shareToken, _requesterIp, providedSecret) {
  if (!providedSecret) return false;

  const entry = bypasses.get(shareToken);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    bypasses.delete(shareToken);
    return false;
  }

  if (entry.secret !== String(providedSecret)) return false;

  if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
  bypasses.delete(shareToken);
  return true;
}

module.exports = { createBypass, consumeBypassIfValid };
