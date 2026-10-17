// Makes a printable one-sheet PDF for a book: cover, ISBN with barcode, description, tune list and logo.
// Reads the book's page on this site, so run tools/build-site.mjs first.
//   node tools/build-one-sheet.mjs <book-slug>
// Writes one-sheets/<book-slug>.pdf. Rerun tools/build-site.mjs afterwards so the book page links to it.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

const slug = process.argv[2];
if (!slug) throw new Error('Usage: node tools/build-one-sheet.mjs <book-slug>');
const page = await readFile(join(ROOT, 'books', slug, 'index.html'), 'utf8');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const text = html => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const pick = re => (page.match(re) || [])[1];

// ---- What the book page tells us -------------------------------------------------------------

const title = decode(pick(/class="book-title">([^<]*)</) || '');
const author = decode(pick(/class="book-author">by ([^<]*)</) || '');
const isbn = pick(/class="book-isbn">ISBN ([\d-]+)/);
const cover = decode(pick(/<img class="book-cover" src="([^"]+)"/) || '').replace(/width=\d+/, 'width=1000');
const descHtml = pick(/<div class="book-desc">([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/) || '';
const pages = pick(/(\d+)\s+pages/i);
const hasAudio = /audio/i.test(descHtml);

// Description: the paragraphs before the tune list, minus the store's boilerplate lines.
const paras = [];
for (const [, p] of descHtml.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
  if (/songs included|tunes included/i.test(p)) break;
  const t = text(p);
  if (!t || /^\d+ pages\.?$/i.test(t) || /published by|free downloadable audio|free audio downloads|link to the page/i.test(t)) continue;
  paras.push(t);
}

// Tunes: store descriptions list them as "<em><strong>Name</strong></em> - Tuning".
const tunes = [...descHtml.matchAll(/<strong>([^<]+)<\/strong>\s*<\/em>\s*-\s*([^<]+?)\s*(?=<br|<\/p>)/g)]
  .map(m => ({ name: decode(m[1]).trim(), tuning: decode(m[2]).replace(/\s*Tuning$/i, '').trim() }))
  .filter(t => !/songs included/i.test(t.name));
const tunings = [...new Set(tunes.map(t => t.tuning))];
const MAX_TUNES = 60;
const shown = tunes.slice(0, MAX_TUNES);

// ---- ISBN barcode (EAN-13) -------------------------------------------------------------------

function ean13Svg(isbn13) {
  const d = isbn13.replace(/\D/g, '');
  const sum = [...d.slice(0, 12)].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  if (d.length !== 13 || (10 - (sum % 10)) % 10 !== Number(d[12])) throw new Error(`Invalid ISBN-13: ${isbn13}`);
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = L.map(c => [...c].reverse().map(b => (b === '1' ? '0' : '1')).join(''));
  const R = L.map(c => [...c].map(b => (b === '1' ? '0' : '1')).join(''));
  const parity = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'][d[0]];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? L : G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  bits += '101';

  // 95 modules plus quiet zones; guard bars run longer than data bars.
  const guards = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  const x0 = 11, bars = [...bits].map((b, i) => b === '1'
    ? `<rect x="${x0 + i}" y="0" width="1" height="${guards.has(i) ? 58 : 52}"/>` : '').join('');
  const digit = (s, x) => `<text x="${x}" y="64" text-anchor="middle">${s}</text>`;
  const left = [...d.slice(1, 7)].map((c, i) => digit(c, x0 + 3 + i * 7 + 3.5)).join('');
  const right = [...d.slice(7)].map((c, i) => digit(c, x0 + 50 + i * 7 + 3.5)).join('');
  return `<svg class="barcode" viewBox="0 0 117 66" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ISBN barcode ${esc(isbn13)}">
    <g fill="#000">${bars}</g>
    <g font-family="Arial, sans-serif" font-size="8.5">${digit(d[0], 5)}${left}${right}</g>
  </svg>`;
}

// ---- The sheet -------------------------------------------------------------------------------

const logo = pathToFileURL(join(ROOT, 'images', 'fingers-of-steel-logo.png')).href;
const bookUrl = `fingersofsteel.com/books/${slug}/`;
const printUrl = pick(/class="buy buy-print" href="([^"]+)"/);
const pdfUrl = pick(/class="buy buy-pdf" href="([^"]+)"/);
const tuneCols = shown.length > 40 ? 4 : shown.length > 12 ? 3 : 2;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} – Fingers Of Steel® one-sheet</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: Georgia, "Times New Roman", serif; color: #222; font-size: 10.5pt; line-height: 1.4; }
  .head { display: flex; align-items: center; gap: 14px; padding-bottom: 10px; border-bottom: 3px solid #3b6b2a; }
  .head img { height: 0.85in; }
  .head .imprint { font-size: 17pt; letter-spacing: 0.02em; }
  .head .sub { font-size: 9.5pt; color: #666; }
  .main { display: grid; grid-template-columns: 2.7in 1fr; gap: 0.3in; margin-top: 0.25in; }
  .cover { width: 100%; border: 1px solid #ccc; }
  h1 { font-size: 22pt; font-weight: normal; line-height: 1.15; margin: 0; }
  .author { font-size: 13pt; color: #555; margin: 4px 0 12px; }
  .desc p { margin: 0 0 8px; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 12px 0; font-size: 10pt; }
  .facts dt { color: #666; }
  .facts dd { margin: 0; }
  .barcode { width: 1.75in; display: block; margin-top: 6px; }
  .tunes { margin-top: 0.25in; border-top: 1px solid #ddd; padding-top: 10px; }
  .tunes h2 { font-size: 12pt; margin: 0 0 6px; }
  .tunes h2 span { font-weight: normal; color: #666; font-size: 10pt; }
  .tunes ol { columns: ${tuneCols}; column-gap: 0.25in; margin: 0; padding-left: 1.6em; font-size: ${shown.length > 40 ? 8.5 : 10.5}pt; line-height: ${shown.length > 40 ? 1.35 : 1.55}; }
  .tunes li { break-inside: avoid; }
  .tunes .more { margin: 6px 0 0; color: #666; font-size: 9pt; }
  .foot { position: fixed; bottom: 0; left: 0; right: 0; border-top: 3px solid #3b6b2a; padding-top: 8px; font-size: 9pt; display: flex; justify-content: space-between; gap: 16px; }
  .foot strong { display: block; color: #3b6b2a; }
</style>
</head>
<body>
  <header class="head">
    <img src="${logo}" alt="Fingers Of Steel logo">
    <div>
      <div class="imprint">Fingers Of Steel® Publications</div>
      <div class="sub">Mountain dulcimer books from Folkcraft® Instruments</div>
    </div>
  </header>

  <section class="main">
    <div>${cover ? `<img class="cover" src="${esc(cover)}" alt="Cover">` : ''}</div>
    <div>
      <h1>${esc(title)}</h1>
      ${author ? `<p class="author">by ${esc(author)}</p>` : ''}
      <div class="desc">${paras.map(p => `<p>${esc(p)}</p>`).join('')}</div>
      <dl class="facts">
        ${isbn ? `<dt>ISBN</dt><dd>${esc(isbn)}</dd>` : ''}
        ${pages ? `<dt>Pages</dt><dd>${esc(pages)}</dd>` : ''}
        ${tunes.length ? `<dt>Tunes</dt><dd>${tunes.length}${tunings.length === 1 ? `, all in ${esc(tunings[0])} tuning` : ''}</dd>` : ''}
        ${hasAudio ? '<dt>Audio</dt><dd>Free demonstration tracks to download</dd>' : ''}
        <dt>Publisher</dt><dd>Folkcraft® Instruments</dd>
      </dl>
      ${isbn ? ean13Svg(isbn) : ''}
    </div>
  </section>

  ${shown.length ? `<section class="tunes">
    <h2>Tunes in this book <span>(${tunes.length})</span></h2>
    <ol>${shown.map(t => `<li>${esc(t.name)}${tunings.length > 1 ? ` <span style="color:#666">(${esc(t.tuning)})</span>` : ''}</li>`).join('')}</ol>
    ${tunes.length > shown.length ? `<p class="more">…and ${tunes.length - shown.length} more.</p>` : ''}
  </section>` : ''}

  <footer class="foot">
    ${printUrl ? `<div><strong>Printed book</strong>folkcraft.com</div>` : ''}
    ${pdfUrl ? `<div><strong>PDF download</strong>dulcimerdownloads.com</div>` : ''}
    <div><strong>More about this book</strong>${esc(bookUrl)}</div>
  </footer>
</body>
</html>`;

// ---- Render with Edge ------------------------------------------------------------------------

if (!EDGE) throw new Error('Microsoft Edge not found; it is used to turn the sheet into a PDF.');
const work = join(tmpdir(), `one-sheet-${slug}`);
await mkdir(work, { recursive: true });
const htmlPath = join(work, 'sheet.html');
await writeFile(htmlPath, html);
await mkdir(join(ROOT, 'one-sheets'), { recursive: true });
const pdfPath = join(ROOT, 'one-sheets', `${slug}.pdf`);
execFileSync(EDGE, [
  '--headless', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=15000',
  `--user-data-dir=${join(work, 'profile')}`, `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
], { stdio: 'ignore' });
await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
console.log(`Wrote one-sheets/${slug}.pdf (${tunes.length} tunes, ${shown.length} shown)`);
