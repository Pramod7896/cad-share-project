/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function normalizeSvg(svg) {
  if (typeof svg !== 'string') return '';
  const trimmed = svg.trim();
  if (!trimmed) return '';
  if (/<\/svg>\s*$/i.test(trimmed)) return trimmed;
  return `${trimmed}\n</svg>`;
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error('Usage: node scripts/dxf-to-svg.js <input.dxf> <output.svg>');
    process.exit(2);
  }

  const dxf2svg = require('dxf2svg');
  const dxfText = fs.readFileSync(input, 'utf8');
  const parsed = dxf2svg.parseString(dxfText);

  const result = dxf2svg.toSVG(parsed);
  const svgRaw = typeof result === 'string' ? result : (result && (result.svg || result.SVG)) || '';
  const svg = normalizeSvg(svgRaw);

  if (!svg) {
    throw new Error('DXF->SVG renderer returned empty output.');
  }

  ensureDir(output);
  fs.writeFileSync(output, svg, 'utf8');
}

try {
  main();
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}

