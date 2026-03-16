/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const distDir = path.join(projectRoot, 'node_modules', 'occt-import-js', 'dist');
  const publicVendorDir = path.join(projectRoot, 'public', 'vendor', 'occt-import-js');

  const jsCandidates = [
    path.join(distDir, 'occt-import-js.js'),
    path.join(distDir, 'occt-import-js.min.js'),
  ];

  const wasmCandidates = [
    path.join(distDir, 'occt-import-js.wasm'),
  ];

  const jsSrc = jsCandidates.find((p) => fs.existsSync(p));
  const wasmSrc = wasmCandidates.find((p) => fs.existsSync(p));

  if (!jsSrc || !wasmSrc) {
    console.warn('[postinstall] occt-import-js dist artifacts not found.');
    console.warn('[postinstall] Expected in:', distDir);
    console.warn('[postinstall] Found JS:', jsSrc || '(none)');
    console.warn('[postinstall] Found WASM:', wasmSrc || '(none)');
    console.warn('[postinstall] STEP/IGES preview will be unavailable until this is fixed.');
    return;
  }

  const jsDestName = path.basename(jsSrc);
  copyFileSync(jsSrc, path.join(publicVendorDir, jsDestName));
  copyFileSync(wasmSrc, path.join(publicVendorDir, 'occt-import-js.wasm'));

  console.log('[postinstall] Copied occt-import-js assets to:', publicVendorDir);
}

main();
