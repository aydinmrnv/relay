// Generates the logo from the CLI's own pixel font, so the mark in the browser
// and the wordmark `relay start` prints in a terminal are one drawing that
// cannot drift. Run by hand after changing either (`npm run gen:brand`); the
// output is committed, because a deploy of `web/` alone has no `../src`.
//
//   src/lib/pixel-font.generated.ts   the glyph table, for <BrandMark>
//   src/app/icon.svg                  the favicon
//   public/brand/*.svg                the mark, the wordmark and the lockups
//
// `--png` also renders PNGs (app icons, the social banner, favicon.ico) with a
// local Chromium: set CHROME_PATH, or have Chrome, Brave or Edge installed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliLogo = join(root, '..', 'src', 'ui', 'logo.ts');
const { bigText, LOGO_TEXT } = await import(pathToFileURL(cliLogo).href);

const ASCII = { unicode: false };
const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** One glyph as five rows of five, padded back out: `bigText` trims trailing paper. */
function glyph(character) {
  return bigText(character, ASCII).map((row) => row.padEnd(5, ' '));
}

/* ------------------------------------------------------------------ */
/* Geometry and colour: the only design decisions in this file         */
/* ------------------------------------------------------------------ */

const PITCH = 9; // one cell of the grid
const PIXEL = 8; // the square drawn in it; the rest is the gap that makes it read as pixels
const ROUND = 1.8;
/** The second pass: the same letter again, a quarter-cell down and right. */
const ECHO = 2.5;

const COLORS = {
  tileFrom: '#8b5cf6',
  tileTo: '#4f46e5',
  ink: '#ffffff',
  echo: '#5eead4',
  night: '#0c0b16',
  day: '#16151f',
};

function cells(rows, originX, originY, fill) {
  const out = [];
  rows.forEach((row, y) => {
    [...row].forEach((character, x) => {
      if (character === '#') {
        out.push(`<rect x="${originX + x * PITCH}" y="${originY + y * PITCH}" width="${PIXEL}" height="${PIXEL}" rx="${ROUND}" fill="${fill}"/>`);
      }
    });
  });
  return out.join('');
}

/** A letter drawn twice: the echo first, the ink on top. */
function twoPass(rows, x, y, ink, echo) {
  return cells(rows, x + ECHO, y + ECHO, echo) + cells(rows, x, y, ink);
}

const GLYPH_SPAN = PITCH * 4 + PIXEL; // 44
const TILE = 64;

/** The app icon: the brand's first letter, two-pass, on the violet tile. */
function markSvg(character = LOGO_TEXT[0]) {
  const offset = (TILE - GLYPH_SPAN - ECHO) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">
  <defs><linearGradient id="relay-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.tileFrom}"/><stop offset="1" stop-color="${COLORS.tileTo}"/></linearGradient></defs>
  <rect width="${TILE}" height="${TILE}" rx="15" fill="url(#relay-tile)"/>
  ${twoPass(glyph(character), offset, offset, COLORS.ink, COLORS.echo)}
</svg>
`;
}

/** The whole name in the pixel font, the way the terminal draws it, with a one-column gap between letters. */
function wordmarkRows(text) {
  const letters = [...text].map(glyph);
  return [0, 1, 2, 3, 4].map((row) => letters.map((letter) => letter[row]).join(' '));
}

function wordmarkSvg(ink, echo) {
  const rows = wordmarkRows(LOGO_TEXT);
  const width = (rows[0].length - 1) * PITCH + PIXEL + ECHO;
  const height = GLYPH_SPAN + ECHO;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  ${twoPass(rows, 0, 0, ink, echo)}
</svg>
`;
}

/** Mark and wordmark side by side, for a README header or a banner. */
function lockupSvg(ink, echo) {
  const rows = wordmarkRows(LOGO_TEXT);
  const gap = 22;
  const wordWidth = (rows[0].length - 1) * PITCH + PIXEL + ECHO;
  const width = TILE + gap + wordWidth;
  const wordY = (TILE - GLYPH_SPAN - ECHO) / 2;
  const mark = markSvg().replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${TILE}">
  <g>${mark}</g>
  <g transform="translate(${TILE + gap} ${wordY})">${twoPass(rows, 0, 0, ink, echo)}</g>
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

function write(relative, contents) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`gen-brand: ${relative}`);
}

const fontEntries = [...CHARACTERS].map((character) => {
  const key = /^[A-Z]$/.test(character) ? character : `'${character}'`;
  return `  ${key}: [${glyph(character).map((row) => `'${row}'`).join(', ')}],`;
});
write(
  'src/lib/pixel-font.generated.ts',
  `// Generated by scripts/gen-brand.mjs from the CLI's pixel font (src/ui/logo.ts). Do not edit.
// Five rows of five per glyph, '#' for ink.
export const PIXEL_FONT: Readonly<Record<string, readonly string[]>> = {
${fontEntries.join('\n')}
};
`,
);

write('src/app/icon.svg', markSvg());
write('public/brand/relay-mark.svg', markSvg());
write('public/brand/relay-wordmark-dark.svg', wordmarkSvg(COLORS.ink, COLORS.tileFrom));
write('public/brand/relay-wordmark-light.svg', wordmarkSvg(COLORS.day, COLORS.tileFrom));
write('public/brand/relay-logo-dark.svg', lockupSvg(COLORS.ink, COLORS.tileFrom));
write('public/brand/relay-logo-light.svg', lockupSvg(COLORS.day, COLORS.tileFrom));

/* ------------------------------------------------------------------ */
/* PNGs, only when asked                                               */
/* ------------------------------------------------------------------ */

if (process.argv.includes('--png')) renderPngs();

function findChromium() {
  const candidates = [
    process.env['CHROME_PATH'],
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function screenshot(chromium, html, width, height, out, scale = 1, quiet = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-brand-'));
  try {
    const page = join(dir, 'page.html');
    writeFileSync(page, html);
    execFileSync(
      chromium,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--default-background-color=00000000',
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        `--screenshot=${out}`,
        pathToFileURL(page).href,
      ],
      { stdio: 'ignore' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!quiet) console.log(`gen-brand: ${out.slice(root.length + 1)}`);
}

function iconPage(size) {
  return `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(markSvg()).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
}

/** A favicon.ico whose images are PNGs, which every browser since IE has read. */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + pngs.length * 16;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map(({ data }) => data)]);
}

function renderPngs() {
  const chromium = findChromium();
  if (chromium === undefined) {
    console.error('gen-brand: --png needs Chrome, Brave, Edge or Chromium; set CHROME_PATH to one.');
    process.exit(1);
  }

  const brand = join(root, 'public', 'brand');
  screenshot(chromium, iconPage(512), 512, 512, join(brand, 'relay-mark-512.png'));
  screenshot(chromium, iconPage(180), 180, 180, join(root, 'src', 'app', 'apple-icon.png'));

  const sizes = [16, 32, 48];
  const pngs = sizes.map((size) => {
    const out = join(tmpdir(), `gen-brand-${size}.png`);
    screenshot(chromium, iconPage(size), size, size, out, 1, true);
    const data = readFileSync(out);
    rmSync(out);
    return { size, data };
  });
  writeFileSync(join(root, 'src', 'app', 'favicon.ico'), ico(pngs));
  console.log('gen-brand: src/app/favicon.ico');

  const banner = readFileSync(join(root, 'scripts', 'brand-banner.html'), 'utf8').replace(
    '<!--LOGO-->',
    lockupSvg(COLORS.ink, COLORS.tileFrom),
  );
  screenshot(chromium, banner, 1200, 630, join(root, 'src', 'app', 'opengraph-image.png'));
  screenshot(chromium, banner, 1200, 630, join(brand, 'relay-banner.png'), 2);
}
