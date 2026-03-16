// hooks/useSessionId.js
// Generates a stable per-tab session ID stored in sessionStorage.
// Used to identify the same viewer across requests for single-viewer mode.

import { useMemo } from 'react';

function generateId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function useSessionId() {
  return useMemo(() => {
    let id = sessionStorage.getItem('cad_session_id');
    if (!id) {
      id = generateId();
      sessionStorage.setItem('cad_session_id', id);
    }
    return id;
  }, []);
}
