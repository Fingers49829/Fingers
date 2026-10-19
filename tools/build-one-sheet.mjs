// Makes a printable one-sheet PDF for a book: cover, ISBN with barcode, description, tune list and logo.
// Reads the book's page on this site, so run tools/build-site.mjs first.
//   node tools/build-one-sheet.mjs <book-slug> [--design classic|banner|trade] [--out dir]
// Writes one-sheets/<book-slug>.pdf (or <dir>/<book-slug>-<design>.pdf and .png with --out).
// Rerun tools/build-site.mjs afterwards so the book page links to the one-sheet.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Microsoft Edge renders the sheet; FOS_BROWSER can name another Chromium-based browser instead.
const EDGE = [
  process.env.FOS_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => p && existsSync(p));

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const design = opt('design') || 'banner';
const outDir = opt('out');
const slug = args[0];
if (!slug) throw new Error('Usage: node tools/build-one-sheet.mjs <book-slug> [--design classic|banner|trade] [--out dir]');
const page = await readFile(join(ROOT, 'books', slug, 'index.html'), 'utf8');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// Inline tags (italics, bold, links) vanish without leaving a gap; other tags become spaces.
const text = html => decode(html.replace(/<\/?(?:em|i|strong|b|a|span)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const pick = re => (page.match(re) || [])[1];

// ---- What the book page tells us -------------------------------------------------------------

const title = decode(pick(/class="book-title">([^<]*)</) || '');
const author = decode(pick(/class="book-author">by ([^<]*)</) || '');
const isbn = pick(/class="book-isbn">ISBN ([\d-]+)/);
// Site images are local files (/images/...); the sheet is rendered from disk, so point at them directly.
// The cover uses the 1200px copy the cover image links to.
const fileUrl = src => src.startsWith('/') ? pathToFileURL(join(ROOT, decodeURIComponent(src.split('?')[0]))).href : src;
const cover = fileUrl(decode(pick(/<a href="([^"]+)"><img\b[^>]*\bclass="book-cover"/) || ''));
const descHtml = pick(/<div class="book-desc">([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/) || '';
const pages = pick(/(\d+)\s+pages/i);
const hasAudio = /audio|mp3/i.test(descHtml);

// Description: the paragraphs before the tune list, minus boilerplate and download links (the "Free demo
// audio" tag covers those), and only as much as fits beside the cover (~600 characters).
// Bullet lists are folded into running text: onto the end of a paragraph that introduces them with a colon
// ("Each tune is arranged four ways: Rhythmic variation; Melodic variation; ..."), or as their own paragraph.
const paras = [];
for (const [, tag, p] of descHtml.matchAll(/<(p|ul)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
  if (/songs included|tunes included/i.test(p)) break;
  const t = tag === 'ul'
    ? [...p.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(m => text(m[1])).filter(Boolean).join('; ') + '.'
    : text(p).replace(/\s*\b\d+ pages\.?\s*$/i, '');
  if (!t || t === '.' || /published by|free downloadable audio|free audio downloads|link to the page|free-downloads/i.test(t + p)) continue;
  if (paras.length && paras.join(' ').length + t.length > 600) break;
  if (tag === 'ul' && paras.length && paras[paras.length - 1].endsWith(':')) paras[paras.length - 1] += ' ' + t;
  else paras.push(t);
}
// A paragraph left ending in a colon (its list didn't fit) reads as cut off, so drop it.
if (paras.length > 1 && paras[paras.length - 1].endsWith(':')) paras.pop();
const shortDesc = paras.join(' ').length < 300;

// Sample pages: the book page's extra images after the cover.
const thumbs = page.match(/<div class="book-thumbs">([\s\S]*?)<\/div>/)?.[1] || '';
const samples = [...thumbs.matchAll(/<a href="([^"]+)"/g)].map(m => fileUrl(decode(m[1]))).slice(0, 3);

// Tunes: everything after the "Songs included" heading, one tune per line. Lines look like
// "Name - DAD Tuning", "Name - Composed by: ...", "Name (Capo 4)" or plain "Name"; the name is the part
// before " - ". Key headings ("D Tunes") are skipped, and "D tunes: A, B, C" lines are split.
const listAt = descHtml.search(/(Songs|Tunes) included/i);
const tunes = [];
if (listAt >= 0) {
  const lines = descHtml.slice(listAt).split(/<br\s*\/?>|<\/p>|<\/li>/i)
    .map(l => decode(l.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(l => l && !/(songs|tunes) included/i.test(l) && !/^(?:[A-G](?: minor)?|two-key) tunes:?$/i.test(l));
  for (const line of lines) {
    const group = line.match(/^(?:[A-G](?: minor)?|two-key) tunes:\s*(.+)$/i);
    for (const entry of group ? group[1].split(/,\s*/) : [line]) {
      const [name, ...rest] = entry.split(/\s+[-–]\s+/);
      const tuning = rest.join(' ').match(/\b([A-G][A-Ga-g#]{2,3})\s+Tuning\b/)?.[1] || '';
      if (name.trim()) tunes.push({ name: name.trim(), tuning });
    }
  }
}
// "All in DAD tuning" only when every tune names the same tuning.
const tunings = [...new Set(tunes.map(t => t.tuning))];
const oneTuning = tunings.length === 1 && tunings[0] ? tunings[0] : null;
// Count melody/harmony parts or easy/hard versions of one tune once.
const tuneCount = new Set(tunes.map(t => t.name.replace(/\s*\([^)]*\)\s*$/g, '').toLowerCase())).size;
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

// ---- Shared pieces ---------------------------------------------------------------------------

const logo = pathToFileURL(join(ROOT, 'images', 'fingers-of-steel-logo.png')).href;
const bookUrl = `fingersofsteel.com/books/${slug}/`;
const printUrl = pick(/class="buy buy-print" href="([^"]+)"/);
const pdfUrl = pick(/class="buy buy-pdf" href="([^"]+)"/);
const many = shown.length > 40;

const facts = [
  isbn && ['ISBN', isbn],
  pages && ['Pages', pages],
  tunes.length && ['Tunes', `${tuneCount}${oneTuning ? `, all in ${oneTuning} tuning` : ''}`],
  hasAudio && ['Audio', 'Free demonstration tracks to download'],
  ['Publisher', 'Fingers Of Steel®'],
].filter(Boolean);
const factsDl = `<dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const chips = [
  tunes.length && `${tuneCount} tunes`,
  oneTuning && `${oneTuning} tuning`,
  pages && `${pages} pages`,
  hasAudio && 'Free demo audio',
].filter(Boolean);
const coverImg = cover ? `<img class="cover" src="${esc(cover)}" alt="Cover">` : '';
const descBlock = `<div class="desc">${paras.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
const tuneList = shown.length ? `
    <h2>Tunes in this book <span>(${tuneCount})</span></h2>
    <ol>${shown.map(t => `<li>${esc(t.name)}${!oneTuning && t.tuning ? ` <span class="tuning">(${esc(t.tuning)})</span>` : ''}</li>`).join('')}</ol>
    ${tunes.length > shown.length ? `<p class="more">…and ${tunes.length - shown.length} more.</p>` : ''}` : '';
const where = [
  printUrl && ['Printed book', 'folkcraft.com'],
  pdfUrl && ['PDF download', 'dulcimerdownloads.com'],
  ['More about this book', bookUrl],
].filter(Boolean);
const barcode = isbn ? ean13Svg(isbn) : '';
// Long web addresses may wrap, but only after a slash.
const url = s => esc(s).replace(/\//g, '/<wbr>');

// Every design is a letter-size page laid out with its own padding (no printer margins),
// so the PNG preview and the PDF match.
const base = `
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { width: 8.5in; height: 11in; position: relative; overflow: hidden; color: #222;
         font-family: Georgia, "Times New Roman", serif; font-size: 10.5pt; line-height: 1.4;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1, h2, p { margin: 0; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; }
  .facts dt { color: #666; }
  .facts dd { margin: 0; }
  ol { margin: 0; }
  li { break-inside: avoid; }
  .tuning, .more { color: #666; }
`;

const designs = {
  // A. Clean white page with green rules.
  classic: () => ({
    css: `
      body { padding: 0.5in; }
      .head { display: flex; align-items: center; gap: 14px; padding-bottom: 10px; border-bottom: 3px solid #1f4e79; }
      .head img { height: 0.85in; }
      .head .imprint { font-size: 17pt; letter-spacing: 0.02em; }
      .head .sub { font-size: 9.5pt; color: #666; }
      .main { display: grid; grid-template-columns: 2.7in 1fr; gap: 0.3in; margin-top: 0.25in; }
      .cover { width: 100%; border: 1px solid #ccc; }
      h1 { font-size: 22pt; font-weight: normal; line-height: 1.15; }
      .author { font-size: 13pt; color: #555; margin: 4px 0 12px; }
      .desc p { margin-bottom: 8px; }
      .facts { margin: 12px 0; font-size: 10pt; }
      .barcode { width: 1.75in; display: block; margin-top: 6px; }
      .tunes { margin-top: 0.25in; border-top: 1px solid #ddd; padding-top: 10px; }
      .tunes h2 { font-size: 12pt; margin-bottom: 6px; }
      .tunes h2 span { font-weight: normal; color: #666; font-size: 10pt; }
      .tunes ol { columns: ${many ? 4 : 3}; column-gap: 0.25in; padding-left: 1.6em; font-size: ${many ? 8.5 : 10.5}pt; line-height: ${many ? 1.35 : 1.55}; }
      .foot { position: absolute; bottom: 0.5in; left: 0.5in; right: 0.5in; border-top: 3px solid #1f4e79; padding-top: 8px; font-size: 9pt; display: flex; justify-content: space-between; gap: 16px; }
      .foot strong { display: block; color: #1f4e79; }`,
    body: `
      <header class="head">
        <img src="${logo}" alt="Fingers Of Steel logo">
        <div><div class="imprint">Fingers Of Steel® Publications</div><div class="sub">Mountain dulcimer books from Folkcraft® Instruments</div></div>
      </header>
      <section class="main">
        <div>${coverImg}</div>
        <div>
          <h1>${esc(title)}</h1>
          ${author ? `<p class="author">by ${esc(author)}</p>` : ''}
          ${descBlock}${factsDl}${barcode}
        </div>
      </section>
      ${tuneList ? `<section class="tunes">${tuneList}</section>` : ''}
      <footer class="foot">${where.map(([k, v]) => `<div><strong>${esc(k)}</strong>${url(v)}</div>`).join('')}</footer>`,
  }),

  // B. Full-width green banner, big cover, tinted tune panel and a bottom strip for ISBN and ordering.
  banner: () => ({
    css: `
      .band { background: #1f4e79; color: #fff; padding: 0.4in 0.5in 0.35in; display: flex; align-items: center; gap: 0.3in; }
      .band img { height: 1.15in; border: 4px solid #fff; background: #fff; }
      .band .imprint { font-family: "Segoe UI", Arial, sans-serif; font-size: 9pt; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0.85; }
      .band h1 { font-size: 30pt; font-weight: normal; line-height: 1.1; margin-top: 4px; }
      .band .author { font-size: 14pt; opacity: 0.9; margin-top: 4px; }
      .main { display: grid; grid-template-columns: ${shown.length || samples.length ? 2.5 : 3.4}in 1fr; gap: 0.35in; padding: 0.3in 0.5in 0; }
      .cover { width: 100%; box-shadow: 0 6px 18px rgba(0,0,0,0.35); }
      .desc { font-size: ${shortDesc ? 14 : 12.5}pt; line-height: 1.5; }
      .desc p { margin-bottom: 10px; }
      .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
      .chips span { font-family: "Segoe UI", Arial, sans-serif; font-size: 9.5pt; font-weight: 600; color: #1f4e79; border: 1.5px solid #1f4e79; border-radius: 999px; padding: 4px 12px; }
      /* The page is a column: banner, cover and description, then the tunes or sample pages take whatever
         height is left above the bottom strip (the fit script below shrinks a long tune list to match). */
      body { display: flex; flex-direction: column; }
      .tunes, .inside { margin: 0.25in 0.5in 0.2in; background: #f3f1ea; border-radius: 8px; padding: 14px 18px; flex: 0 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
      .tunes h2, .inside h2 { font-family: "Segoe UI", Arial, sans-serif; font-size: 10pt; letter-spacing: 0.15em; text-transform: uppercase; color: #1f4e79; margin-bottom: 8px; }
      .tunes h2 span { color: #777; letter-spacing: 0; }
      .inside .pages { display: flex; justify-content: center; gap: 0.25in; flex: 1 1 auto; min-height: 0; }
      .inside img { height: 100%; max-height: 3in; max-width: ${samples.length > 2 ? 2.3 : 3.4}in; object-fit: contain; background: #fff; border: 1px solid #ccc; box-shadow: 0 3px 10px rgba(0,0,0,0.2); }
      .tunes ol { flex: 0 0 auto; columns: ${many ? 4 : 3}; column-gap: 0.25in; padding-left: 1.7em; font-size: ${many ? 8.5 : 10}pt; line-height: ${many ? 1.3 : 1.45}; }
      .strip { margin-top: auto; flex: 0 0 auto; background: #f3f1ea; border-top: 4px solid #1f4e79; padding: 0.2in 0.5in 0.3in; display: flex; align-items: center; justify-content: space-between; gap: 0.3in; }
      .strip .isbn { display: flex; align-items: center; gap: 14px; font-size: 9.5pt; flex: 0 0 auto; }
      .strip .isbn strong { white-space: nowrap; }
      .strip .barcode { width: 1.6in; background: #fff; padding: 4px; }
      .strip .buy { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 9pt; }
      .strip .buy strong { white-space: nowrap; }
      .strip .buy strong { color: #1f4e79; }`,
    body: `
      <header class="band">
        <img src="${logo}" alt="Fingers Of Steel logo">
        <div>
          <div class="imprint">Fingers Of Steel® Publications</div>
          <h1>${esc(title)}</h1>
          ${author ? `<p class="author">by ${esc(author)}</p>` : ''}
        </div>
      </header>
      <section class="main">
        <div>${coverImg}</div>
        <div>${descBlock}<div class="chips">${chips.map(c => `<span>${esc(c)}</span>`).join('')}</div></div>
      </section>
      ${tuneList ? `<section class="tunes">${tuneList}</section>`
        : samples.length ? `<section class="inside"><h2>Inside the book</h2><div class="pages">${samples.map((s, i) => `<img src="${esc(s)}" alt="Sample page ${i + 1}">`).join('')}</div></section>` : ''}
      <footer class="strip">
        <div class="isbn">${barcode}<div>${isbn ? `<strong>ISBN ${esc(isbn)}</strong><br>` : ''}Published by<br>Fingers Of Steel®</div></div>
        <div class="buy">${where.map(([k, v]) => `<strong>${esc(k)}</strong><span>${url(v)}</span>`).join('')}</div>
      </footer>`,
  }),

  // C. Bookstore sell sheet: tinted sidebar with cover, specs, barcode and ordering; title and tunes on the right.
  trade: () => ({
    css: `
      body { display: grid; grid-template-columns: 2.85in 1fr; }
      .side { background: #f3f1ea; padding: 0.45in 0.3in 0.4in; display: flex; flex-direction: column; gap: 14px; border-right: 4px solid #1f4e79; }
      .brand { display: flex; align-items: center; gap: 10px; font-size: 10pt; line-height: 1.25; }
      .brand img { height: 0.7in; }
      .cover { width: 100%; border: 1px solid #ccc; box-shadow: 0 3px 10px rgba(0,0,0,0.2); }
      .side h3 { font-family: "Segoe UI", Arial, sans-serif; font-size: 8.5pt; letter-spacing: 0.15em; text-transform: uppercase; color: #1f4e79; margin: 0 0 4px; }
      .facts { font-size: 9.5pt; gap: 2px 10px; }
      .barcode { width: 1.7in; background: #fff; padding: 5px; }
      .order { font-size: 9.5pt; line-height: 1.45; margin-top: auto; }
      .order div { margin-bottom: 4px; }
      .order strong { display: block; }
      .content { padding: 0.5in 0.5in 0.4in 0.4in; display: flex; flex-direction: column; }
      .kicker { font-family: "Segoe UI", Arial, sans-serif; font-size: 9pt; letter-spacing: 0.2em; text-transform: uppercase; color: #1f4e79; }
      h1 { font-size: 24pt; font-weight: normal; line-height: 1.12; margin-top: 6px; }
      .author { font-size: 14pt; color: #555; margin-top: 6px; padding-bottom: 14px; border-bottom: 2px solid #1f4e79; }
      .order span { font-size: 8.5pt; }
      .desc { font-size: 11.5pt; line-height: 1.5; margin-top: 14px; }
      .desc p { margin-bottom: 8px; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 6px 0 0; font-family: "Segoe UI", Arial, sans-serif; font-size: 9.5pt; font-weight: 600; color: #1f4e79; }
      .chips span::before { content: "\\25B8\\00a0"; }
      .tunes { margin-top: 18px; }
      .tunes h2 { font-size: 13pt; margin-bottom: 6px; }
      .tunes h2 span { font-weight: normal; color: #666; font-size: 10pt; }
      .tunes ol { columns: ${many ? 3 : 2}; column-gap: 0.3in; padding-left: 1.7em; font-size: ${many ? 8.5 : 11}pt; line-height: ${many ? 1.3 : 1.62}; }`,
    body: `
      <aside class="side">
        <div class="brand"><img src="${logo}" alt="Fingers Of Steel logo"><div>Fingers Of Steel®<br>Publications</div></div>
        ${coverImg}
        <div><h3>Details</h3>${factsDl}</div>
        ${barcode}
        <div class="order"><h3>Where to buy</h3>${where.map(([k, v]) => `<div><strong>${esc(k)}</strong><span>${url(v)}</span></div>`).join('')}</div>
      </aside>
      <main class="content">
        <div class="kicker">Mountain dulcimer</div>
        <h1>${esc(title)}</h1>
        ${author ? `<p class="author">by ${esc(author)}</p>` : ''}
        ${descBlock}
        <div class="chips">${chips.map(c => `<span>${esc(c)}</span>`).join('')}</div>
        ${tuneList ? `<section class="tunes">${tuneList}</section>` : ''}
      </main>`,
  }),
};

if (!designs[design]) throw new Error(`Unknown design "${design}". Choose: ${Object.keys(designs).join(', ')}`);
const { css, body } = designs[design]();
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} – Fingers Of Steel® one-sheet</title>
<style>${base}${css}</style>
</head>
<body>${body}
<script>
  // Fit the tune list into the space it has: shrink the text down to a readable minimum, then drop
  // tunes from the end and say how many more there are. Runs after images load, since the cover's
  // height decides how much room is left.
  window.addEventListener('load', function () {
    const box = document.querySelector('.tunes');
    if (!box) return;
    const ol = box.querySelector('ol');
    const fits = () => box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1;
    let size = parseFloat(getComputedStyle(ol).fontSize);
    while (!fits() && size > 10) { size -= 0.25; ol.style.fontSize = size + 'px'; ol.style.lineHeight = '1.3'; }
    let more = box.querySelector('.more');
    let hidden = ${tunes.length - shown.length};
    while (!fits() && ol.children.length > 1) {
      ol.lastElementChild.remove();
      hidden++;
      if (!more) { more = document.createElement('p'); more.className = 'more'; box.appendChild(more); }
      more.textContent = '\\u2026and ' + hidden + ' more.';
    }
  });
</script>
</body>
</html>`;

// ---- Render with Edge ------------------------------------------------------------------------

if (!EDGE) throw new Error('Microsoft Edge not found; it is used to turn the sheet into a PDF.');
const work = join(tmpdir(), `one-sheet-${slug}-${design}`);
await mkdir(work, { recursive: true });
const htmlPath = join(work, 'sheet.html');
await writeFile(htmlPath, html);
const edge = extra => execFileSync(EDGE, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-pdf-header-footer', '--virtual-time-budget=15000',
  `--user-data-dir=${join(work, 'profile')}`, ...extra, pathToFileURL(htmlPath).href,
], { stdio: 'ignore' });

const dir = outDir || join(ROOT, 'one-sheets');
await mkdir(dir, { recursive: true });
const name = outDir ? `${slug}-${design}` : slug;
// Edge can return before it has finished writing the file, so wait for a complete, freshly written file
// (and fail loudly if none appears) before the working folder it renders from is removed.
const { statSync } = await import('node:fs');
async function edgeWrite(file, extra) {
  await rm(file, { force: true });
  edge(extra);
  let last = -1;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    const size = existsSync(file) ? statSync(file).size : -1;
    if (size > 0 && size === last) return;
    last = size;
  }
  throw new Error(`Edge did not write ${file}`);
}
await edgeWrite(join(dir, `${name}.pdf`), [`--print-to-pdf=${join(dir, `${name}.pdf`)}`]);
if (outDir) await edgeWrite(join(dir, `${name}.png`), ['--window-size=816,1056', `--screenshot=${join(dir, `${name}.png`)}`]);
await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
console.log(`Wrote ${join(dir, `${name}.pdf`)} (${design}; ${tunes.length} tunes, ${shown.length} shown)`);
