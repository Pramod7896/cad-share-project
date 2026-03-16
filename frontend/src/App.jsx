// src/App.jsx
import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import ViewerPage from './pages/ViewerPage';

// Global CSS reset + spinner keyframes injected once
const globalStyle = document.createElement('style');
globalStyle.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; }
  @keyframes spin { to { transform: rotate(360deg); } }
  input:focus { outline: 2px solid #5b6af0; outline-offset: 2px; }
  button:active { opacity: 0.85; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #1a1d27; }
  ::-webkit-scrollbar-thumb { background: #2a2d3e; border-radius: 3px; }
`;
document.head.appendChild(globalStyle);

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"             element={<UploadPage />} />
        <Route path="/view/:token"  element={<ViewerPage />} />
        <Route path="*"             element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <div style={{
      minHeight: '100vh', background: '#0f1117', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', system-ui, sans-serif", gap: 12,
    }}>
      <h1 style={{ color: '#e8eaf0', fontSize: 32 }}>404</h1>
      <p style={{ color: '#8b8fa8' }}>Page not found.</p>
      <a href="/" style={{ color: '#5b6af0', fontSize: 14 }}>← Go home</a>
    </div>
  );
}
