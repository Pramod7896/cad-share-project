/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function patchToSvg(jsPath) {
  const src = fs.readFileSync(jsPath, 'utf8');

  // The published build of some dxf2svg versions contains a broken block that references
  // an undefined identifier `Entities` and crashes Node at runtime:
  //   // Blocks
  //   Entities.map(...)
  // This block is not required for basic conversion and is safe to remove.
  const pattern = /(\r?\n)\s*\/\/ Blocks\r?\n\s*Entities\.map\([\s\S]*?\r?\n\s*\/\/ Blocks;\s*\r?\n/;

  if (!pattern.test(src)) {
    return { changed: false };
  }

  const next = src.replace(
    pattern,
    `$1    // Blocks (patched: removed broken Entities.map block)\n`
  );

  fs.writeFileSync(jsPath, next, 'utf8');
  return { changed: true };
}

function main() {
  const backendRoot = path.resolve(__dirname, '..');
  const target = path.join(backendRoot, 'node_modules', 'dxf2svg', 'lib', 'toSVG.js');

  if (!fs.existsSync(target)) {
    console.log('[patch-dxf2svg] target not found, skipping:', target);
    return;
  }

  const { changed } = patchToSvg(target);
  console.log(changed ? '[patch-dxf2svg] patched:' : '[patch-dxf2svg] already ok:', target);
}

main();

