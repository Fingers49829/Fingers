// Builds the site from Folkcraft.com and DulcimerDownloads.com:
//   index.html             - the Fingers Of Steel page from Folkcraft, with covers linking to book pages here
//   books/<slug>/index.html - one page per book, with links to buy it at Folkcraft (print) and DulcimerDownloads (PDF)
// Run from the repo root:  node tools/build-site.mjs

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOLKCRAFT = 'https://folkcraft.com';
const DD = 'https://dulcimerdownloads.com';
const SITE = 'https://fingersofsteel.com';

async function getText(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.text();
    if (attempt >= 5 || (res.status !== 429 && res.status < 500)) throw new Error(`${res.status} fetching ${url}`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * attempt;
    await new Promise(r => setTimeout(r, wait));
  }
}
const getJson = async url => JSON.parse(await getText(url));

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const norm = s => decode(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const slugify = s => decode(s).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const plain = html => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Store titles look like "Author - Book Title".
function splitTitle(full) {
  const i = full.indexOf(' - ');
  return i < 0 ? { author: '', title: full } : { author: full.slice(0, i).trim(), title: full.slice(i + 3).trim() };
}

// Shopify image URL at a given width.
function sized(src, width) {
  const u = new URL(src.startsWith('//') ? 'https:' + src : src);
  u.searchParams.set('width', width);
  return u.toString();
}

// Product images are served from this site, not the stores' CDN. Each store image is downloaded once per
// width into images/books/ (named after the store's file) and reused on later builds. The store's version
// stamp (?v=) for each file is kept in images/image-versions.json, so an image replaced in the store under
// the same filename is downloaded again.
const IMAGES = join(ROOT, 'images', 'books');
await mkdir(IMAGES, { recursive: true });
const VERSIONS = join(ROOT, 'images', 'image-versions.json');
const FRAME_VERSION = 'b1';
const versions = JSON.parse(await readFile(VERSIONS, 'utf8').catch(() => '{}'));
const usedImages = new Set();
const downloads = new Map();
const downloaded = [];
const toJpeg = new Set();
const nameOwner = new Map();
let active = 0;
const waiting = [];

// Local file name for a store image at a width: the store's file name without the random suffix Shopify adds
// to re-uploads ("_4076a7fa", "_e7c37737-aff2-4788-9e3f-dbfac01c4cad"), with hyphens for underscores. PNGs
// are kept as JPEG (they're photos and page scans, at a fraction of the size). If two store files would get
// the same name, the second keeps its suffix.
function localName(storeFile, width) {
  const ext = /\.png$/i.test(storeFile) ? '.jpg' : storeFile.match(/\.\w+$/)[0].toLowerCase();
  const base = storeFile.replace(/\.\w+$/, '');
  const clean = base
    .replace(/_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|_[0-9a-f]{8}$/i, '')
    .replace(/-1-12-Fret/g, '-1-1-2-Fret')
    .replace(/_/g, '-').replace(/-{2,}/g, '-');
  for (const name of [`${clean}-${width}${ext}`, `${base.replace(/_/g, '-')}-${width}${ext}`]) {
    if (!nameOwner.has(name) || nameOwner.get(name) === storeFile) { nameOwner.set(name, storeFile); return name; }
  }
  return `${base}-${width}${ext}`;
}

async function localImage(src, width) {
  const u = new URL(decode(src).startsWith('//') ? 'https:' + decode(src) : decode(src));
  const storeFile = decodeURIComponent(u.pathname.split('/').pop());
  const file = localName(storeFile, width);
  usedImages.add(file);
  const dest = join(IMAGES, file);
  // A PNG from the store is downloaded as .png and converted to dest (.jpg) at the end of the build.
  const work = /\.png$/i.test(storeFile) ? dest.replace(/\.jpg$/, '.png') : dest;
  // Files saved under the old naming scheme (the store's exact name) are moved rather than downloaded again.
  const legacy = storeFile.replace(/(\.\w+)$/, `-${width}$1`);
  if (!existsSync(dest) && !existsSync(work) && existsSync(join(IMAGES, legacy)) && !downloads.has(file)) {
    renameSync(join(IMAGES, legacy), work);
    versions[file] ??= versions[legacy];
  }
  if (work !== dest && existsSync(work)) toJpeg.add(work);
  const have = existsSync(dest) || existsSync(work);
  const version = u.searchParams.get('v') || '';
  const stale = have && versions[file] && version && versions[file] !== version;
  if (!have || !versions[file]) versions[file] = version;
  if ((!have || stale) && !downloads.has(file)) {
    downloads.set(file, (async () => {
      if (active >= 8) await new Promise(r => waiting.push(r));
      active++;
      try {
        const res = await fetch(sized(u.toString(), width));
        if (!res.ok) throw new Error(`${res.status} downloading ${u}`);
        await writeFile(work, Buffer.from(await res.arrayBuffer()));
        versions[file] = version;
        downloaded.push(work);
        if (work !== dest) toJpeg.add(work);
      } catch (e) {
        console.warn(`! Image not downloaded, left on the store's CDN: ${e.message}`);
      } finally {
        active--;
        waiting.shift()?.();
      }
    })());
  }
  await downloads.get(file);
  if (!existsSync(dest) && !existsSync(work)) { usedImages.delete(file); return sized(u.toString(), width); }
  // The ?v= tag changes whenever the store's image or our frame treatment changes, so browsers never show a
  // stale cached copy. (Bump FRAME_VERSION if reframe-images.ps1 changes how images look.)
  return `/images/books/${file}?v=${versions[file] || '0'}-${FRAME_VERSION}`;
}

// Swaps every store-hosted <img> in a chunk of HTML for a local copy.
async function localizeImgs(html, defaultWidth) {
  const found = [...new Set([...html.matchAll(/src="((?:https?:)?\/\/cdn\.shopify\.com\/[^"]+)"/g)].map(m => m[1]))];
  const local = await Promise.all(found.map(src => localImage(src, Number(new URL(decode(src).replace(/^\/\//, 'https://')).searchParams.get('width')) || defaultWidth)));
  found.forEach((src, i) => { html = html.split(`src="${src}"`).join(`src="${local[i]}"`); });
  return html;
}

// Pixel size of a local image (/images/...), read from the file header; null for remote or unreadable files.
// A PNG still waiting to become JPEG is read from its .png copy (same size).
function imageSize(url) {
  if (!url.startsWith('/images/')) return null;
  const path = join(ROOT, decodeURIComponent(url.split(/[?#]/)[0]));
  const file = existsSync(path) ? path : path.replace(/\.jpg$/, '.png');
  if (!existsSync(file)) return null;
  const b = readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 8;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Gives every local <img> a width and height, so the browser reserves its space before it loads (no layout
// shift). A width already set is kept as the display width, with the height to match.
function addImageSizes(html) {
  return html.replace(/<img\b[^>]*>/gi, tag => {
    const src = (tag.match(/\ssrc="([^"]+)"/) || [])[1];
    if (!src || /\sheight=/.test(tag) || /\swidth="(?!\d+")/.test(tag)) return tag;
    const size = imageSize(decode(src));
    if (!size) return tag;
    const width = Number((tag.match(/\swidth="(\d+)"/) || [])[1]) || size[0];
    const height = Math.round(width * size[1] / size[0]);
    return tag.replace(/\swidth="\d+"/, '').replace(/^<img/, `<img width="${width}" height="${height}"`);
  });
}

// Keeps the store description's content but drops markup that doesn't belong on a static page.
function cleanDescription(html) {
  return (html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|form|button|input|select)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(meta|link|input)[^>]*>/gi, '')
    .replace(/\s(style|class|id|data-[\w-]+)="[^"]*"/gi, '')
    .replace(/<span>([\s\S]*?)<\/span>/gi, '$1')
    // Drop the store's "This book is published by Folkcraft® Instruments, under the Fingers Of Steel® imprint." line.
    .replace(/<p[^>]*>(?:(?!<\/p>)[\s\S])*published by Folkcraft(?:(?!<\/p>)[\s\S])*<\/p>/gi, '')
    .replace(/href="\//g, `href="${FOLKCRAFT}/`)
    // Links to Fingers Of Steel pages on Folkcraft stay on this site instead.
    .replace(/href="https?:\/\/(?:www\.)?folkcraft\.com\/pages\/fingers-of-steel(?:-catalog)?\/?"/g, 'href="/"')
    .replace(/href="https?:\/\/(?:www\.)?folkcraft\.com\/(?:collections\/[^/"]+\/)?products\/([^"#?/]+)[^"]*"/g,
      (m, handle) => slugByUrl.has(`${FOLKCRAFT}/products/${handle}`) ? `href="/books/${slugByUrl.get(`${FOLKCRAFT}/products/${handle}`)}/"` : m)
    .replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>')
    // "46 pages. Songs included:" often runs together, or has only a single line break between them;
    // leave a blank line before the song list.
    .replace(/(?<=[^>\s]|<br\s*\/?>)(?:\s|&nbsp;|<br\s*\/?>)*(?=<(?:strong|b)>\s*(?:Songs|Tunes) included)/gi, '<br><br>')
    .trim();
}

// The song list from a store description: from the bold "Songs included" heading to the end, without the
// store's closing boilerplate (publisher line, page count).
function storeSongList(html) {
  const at = (html || '').search(/<(strong|b)\b[^>]*>\s*(?:<[^>]+>\s*)*(Songs|Tunes) included/i);
  if (at < 0) return '';
  // When the heading sits mid-paragraph ("46 pages. <strong>Songs included"), reopen the paragraph at the heading.
  const before = html.slice(0, at);
  const inParagraph = before.lastIndexOf('<p') > before.lastIndexOf('</p>');
  return ((inParagraph ? '<p>' : '') + html.slice(at))
    .replace(/<p[^>]*>(?:(?!<\/p>)[\s\S])*published by(?:(?!<\/p>)[\s\S])*<\/p>/gi, '')
    .replace(/<p[^>]*>\s*\d+ pages\.?\s*<\/p>/gi, '')
    .trim();
}

// Removes the element that starts with openTag (e.g. '<div class="x">'), including everything nested in it.
function removeElement(html, openTag) {
  const start = html.indexOf(openTag);
  if (start < 0) return html;
  const tag = openTag.match(/^<(\w+)/)[1];
  let depth = 0;
  for (const m of html.slice(start).matchAll(new RegExp(`<(/?)${tag}\\b`, 'g'))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(html.indexOf('>', start + m.index) + 1);
  }
  return html;
}

// ---- 1. The Folkcraft page body --------------------------------------------------------------

// The catalog lives on an unlisted Folkcraft page (folkcraft.com/pages/fingers-of-steel now redirects here).
const pageHtml = await getText(`${FOLKCRAFT}/pages/fingers-of-steel-catalog`);
const sectionAt = pageHtml.indexOf('__main" class="shopify-section');
const start = pageHtml.indexOf('<div class="rte">', sectionAt);
if (sectionAt < 0 || start < 0) throw new Error("Couldn't find the page content on Folkcraft");
let depth = 0, end = -1;
for (const m of pageHtml.slice(start).matchAll(/<(\/?)div\b/g)) {
  depth += m[1] ? -1 : 1;
  if (depth === 0) { end = pageHtml.indexOf('>', start + m.index) + 1; break; }
}
let body = pageHtml.slice(start, end)
  .replace(/href="\//g, `href="${FOLKCRAFT}/`)
  .replace(/src="[^"]*FingersOfSteel_K_WhiteBorder[^"]*"/g, 'src="/images/fingers-of-steel-logo.png"')
  // The catalog's own styles use Folkcraft green; this site's theme color is blue.
  .replace(/--fos-green:\s*#[0-9a-f]{3,6}/i, '--fos-green:#1f4e79')
  // This site's own intro line in place of Folkcraft's "publishing imprint" sentence.
  .replace(/<p><strong>Fingers Of Steel®<\/strong>[^<]*publishing imprint[^<]*<\/p>/,
    "<p><strong>Fingers Of Steel®</strong> is the world's leading publisher of music books for the Appalachian mountain dulcimer.</p>");
if (!body.includes("world's leading publisher")) console.warn('! Homepage intro sentence not found on Folkcraft; left unchanged');
// Drop Folkcraft's "Every title is printed and shipped by Folkcraft..." and "Prefer a PDF?..." lines.
body = body.replace(/\s*<p>Every title is printed[^<]*<\/p>/, '');
body = body.replace(/\s*<p class="fos-pdf">[\s\S]*?<\/p>/, '');

// ISBNs from the page's ISBN table, keyed by normalized "author title".
const isbnByKey = new Map();
for (const m of body.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([\d-]{10,})<\/td>\s*<\/tr>/g)) {
  isbnByKey.set(norm(m[1] + m[2]), m[3]);
}

// ---- 2. Product data from both stores ----------------------------------------------------------

const folkcraftHandles = [...new Set([...body.matchAll(/href="https:\/\/folkcraft\.com\/products\/([^"#?]+)"/g)].map(m => m[1]))];
const ddOnlyHandles = [...new Set([...body.matchAll(/href="https:\/\/dulcimerdownloads\.com\/products\/([^"#?]+)"/g)].map(m => m[1]))];

// A store's whole catalog, 250 products per request.
async function catalog(store) {
  const all = [];
  for (let page = 1; page < 100; page++) {
    const { products } = await getJson(`${store}/products.json?limit=250&page=${page}`);
    if (!products.length) break;
    all.push(...products);
  }
  return all;
}

const ddProducts = await catalog(DD);
const ddBySku = new Map(), ddByTitle = new Map(), ddByHandle = new Map();
for (const p of ddProducts) {
  ddByHandle.set(p.handle, p);
  ddByTitle.set(norm(p.title), p);
  for (const v of p.variants) if (v.sku) ddBySku.set(String(v.sku).trim(), p);
}

// The homepage cards carry the short display title and author, e.g. "Baker's Dozen #9: My First Dulcimer Book".
const cardByUrl = new Map();
for (const m of body.matchAll(/<a class="fos-card" href="([^"]+)">[\s\S]*?<span class="fos-t">([^<]*)<\/span><span class="fos-a">([^<]*)<\/span>/g)) {
  cardByUrl.set(m[1], { title: decode(m[2]).trim(), author: decode(m[3]).trim() });
}

// Finds the DulcimerDownloads PDF for a book: same SKU, same full title, or a DD title containing the book's title and author.
function findPdf(sku, fullTitle, { title, author }) {
  if (sku && ddBySku.has(sku)) return ddBySku.get(sku);
  if (ddByTitle.has(norm(fullTitle))) return ddByTitle.get(norm(fullTitle));
  const t = norm(title), a = norm(author.split(/ and /i)[0]);
  const hits = ddProducts.filter(p => norm(p.title).includes(t) && (!a || norm(p.title + p.vendor + p.tags.join()).includes(a)));
  return hits.length === 1 ? hits[0] : null;
}

// Price and stock of a store product's first variant, for the book page's structured data (both stores sell in USD).
const offerOf = p => ({ price: p.variants?.[0]?.price, available: p.variants?.some(v => v.available) });

const folkcraftByHandle = new Map((await catalog(FOLKCRAFT)).map(p => [p.handle, p]));

const books = [];
for (const h of folkcraftHandles) {
  const p = folkcraftByHandle.get(h);
  if (!p) { console.warn(`! Folkcraft product not found: ${h}`); continue; }
  const sku = String(p.variants?.[0]?.sku || '').trim();
  const card = cardByUrl.get(`${FOLKCRAFT}/products/${p.handle}`) || splitTitle(p.title);
  const dd = findPdf(sku, p.title, card);
  books.push({
    full: p.title,
    ...card,
    description: p.body_html,
    images: p.images.map(i => i.src),
    folkcraftUrl: `${FOLKCRAFT}/products/${p.handle}`,
    ddUrl: dd ? `${DD}/products/${dd.handle}` : null,
    print: offerOf(p),
    pdf: dd ? offerOf(dd) : null,
  });
}
for (const h of ddOnlyHandles) {
  const p = ddByHandle.get(h);
  if (!p) { console.warn(`! DulcimerDownloads product not found: ${h}`); continue; }
  books.push({
    full: p.title,
    ...(cardByUrl.get(`${DD}/products/${h}`) || splitTitle(p.title)),
    description: p.body_html,
    images: p.images.map(i => i.src),
    folkcraftUrl: null,
    ddUrl: `${DD}/products/${p.handle}`,
    print: null,
    pdf: offerOf(p),
  });
}

const usedSlugs = new Set();
for (const b of books) {
  b.title = b.title.replace(/\s*\(PDF Download\)\s*$/i, '');
  let slug = slugify(`${b.author} ${b.title}`);
  for (let n = 2; usedSlugs.has(slug); n++) slug = `${slugify(`${b.author} ${b.title}`)}-${n}`;
  usedSlugs.add(slug);
  b.slug = slug;
  b.isbn = isbnByKey.get(norm(b.author + b.title)) || null;
  // A file in descriptions/<slug>.html replaces the store's description with copy written for this site.
  // Where it has <!--STORE-SONGS-->, the store's current song list goes in.
  const custom = await readFile(join(ROOT, 'descriptions', `${slug}.html`), 'utf8').catch(() => null);
  if (custom) {
    const songs = storeSongList(b.description);
    if (custom.includes('<!--STORE-SONGS-->') && !songs) console.warn(`! ${slug}: no song list found in the store description`);
    b.description = custom.replace(/\r\n/g, '\n').replace('<!--STORE-SONGS-->', songs);
  }
  // One-sheets are made separately by tools/build-one-sheet.mjs.
  b.oneSheet = existsSync(join(ROOT, 'one-sheets', `${slug}.pdf`));
}
const slugByUrl = new Map(books.flatMap(b => [b.folkcraftUrl, b.ddUrl].filter(Boolean).map(u => [u, b.slug])));

// ---- 3. Book pages ---------------------------------------------------------------------------

const template = await readFile(join(ROOT, 'tools', 'page-template.html'), 'utf8');

const abs = u => (u.startsWith('/') ? SITE + u : u);
const PUBLISHER = { '@type': 'Organization', name: 'Fingers Of Steel', url: `${SITE}/`, logo: `${SITE}/images/fingers-of-steel-logo.png` };

// Open Graph and Twitter tags, so links shared on social sites and in messages show the page's image.
function socialTags({ type, title, description, url, image, alt, card = 'summary_large_image' }) {
  const size = image ? imageSize(image) : null;
  return [
    ['og:site_name', 'Fingers Of Steel® Publications'], ['og:type', type], ['og:title', title],
    ['og:description', description], ['og:url', url],
    ...(image ? [['og:image', abs(image)], ...(size ? [['og:image:width', size[0]], ['og:image:height', size[1]]] : []), ['og:image:alt', alt]] : []),
  ].map(([k, v]) => `\n  <meta property="${k}" content="${esc(v)}">`).join('') +
    `\n  <meta name="twitter:card" content="${image ? card : 'summary'}">`;
}

// Structured data for search engines.
const jsonLd = data => `\n  <script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

// Header bar shared by every page. On the homepage the site name is the page's <h1>.
const masthead = nameTag => `
  <header class="masthead"><div class="masthead-inner">
    <a class="brand" href="/"><img src="/images/fingers-of-steel-logo.png" alt="" width="44" height="64"><span><${nameTag} class="name">Fingers Of Steel® Publications</${nameTag}><span class="tag">Publisher of Appalachian mountain dulcimer sheet music</span></span></a>
    <nav><a class="primary" href="/">All books</a><a href="/#fos-tab-author">By author</a></nav>
  </div></header>`;
const MASTHEAD = masthead('span');

// Page titles name what people search for: "Mountain Dulcimer Tab Book", or just "Tab Book" when the
// book title already says dulcimer. Books that aren't dulcimer tab keep the imprint name instead.
const NOT_TAB = /cajon|ukulele|dulcilele|dulciflute|dulciwhistle|staff paper|fret position|traditional musician/i;
const pageTitle = (title, byline) =>
  `${byline} – ${NOT_TAB.test(title) ? 'Fingers Of Steel®' : /dulci/i.test(title) ? 'Tab Book' : 'Mountain Dulcimer Tab Book'}`;

async function bookPage(b) {
  const title = `${b.title}${b.author ? ` by ${b.author}` : ''}`;
  const summary = plain(b.description).slice(0, 155).replace(/\s+\S*$/, '') + '…';
  const [main, ...more] = b.images;
  // Cover shown at 700px and thumbnails at 200px; both open a 1200px copy.
  b.large = await Promise.all(b.images.map(src => localImage(src, 1200)));
  const gallery = main ? `
      <div class="book-gallery">
        <a href="${esc(b.large[0])}"><img class="book-cover" src="${esc(await localImage(main, 700))}" alt="${esc(b.title)} cover" width="700"></a>
        ${more.length ? `<div class="book-thumbs">${(await Promise.all(more.map(async (src, i) =>
          `<a href="${esc(b.large[i + 1])}"><img src="${esc(await localImage(src, 200))}" alt="${esc(b.title)}, image ${i + 2}" loading="lazy" width="200"></a>`))).join('')}</div>` : ''}
      </div>` : '';
  const buy = [
    b.folkcraftUrl && `<a class="buy buy-print" href="${esc(b.folkcraftUrl)}"><strong>Printed book</strong><span>Buy at Folkcraft.com</span></a>`,
    b.ddUrl && `<a class="buy buy-pdf" href="${esc(b.ddUrl)}"><strong>PDF download</strong><span>Buy at DulcimerDownloads.com</span></a>`,
  ].filter(Boolean).join('\n          ');

  const content = `
    <article class="book">
      ${gallery}
      <div class="book-info">
        <h1 class="book-title">${esc(b.title)}</h1>
        ${b.author ? `<p class="book-author">by ${esc(b.author)}</p>` : ''}
        <div class="buy-links">
          ${buy}
        </div>
        ${b.isbn || b.oneSheet ? `<p class="book-isbn">${[
          b.isbn && `ISBN ${esc(b.isbn)}`,
          b.oneSheet && `<a href="/one-sheets/${b.slug}.pdf">Download one-sheet (PDF)</a>`,
        ].filter(Boolean).join(' &middot; ')}</p>` : ''}
        <div class="book-desc">${await localizeImgs(cleanDescription(b.description), 900)}</div>
      </div>
    </article>`;

  const url = `${SITE}/books/${b.slug}/`;
  const images = b.large.map(abs);
  const offer = (o, link, name, seller) => o && o.price && {
    '@type': 'Offer', name, url: link, price: o.price, priceCurrency: 'USD',
    availability: `https://schema.org/${o.available ? 'InStock' : 'OutOfStock'}`,
    seller: { '@type': 'Organization', name: seller },
  };
  const book = {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: b.title,
    ...(b.author && { author: { '@type': 'Person', name: b.author } }),
    url,
    ...(images.length && { image: images }),
    description: summary,
    ...(b.isbn && { isbn: b.isbn }),
    inLanguage: 'en',
    publisher: PUBLISHER,
    offers: [
      offer(b.print, b.folkcraftUrl, 'Printed book', 'Folkcraft Instruments'),
      offer(b.pdf, b.ddUrl, 'PDF download', 'DulcimerDownloads.com'),
    ].filter(Boolean),
  };
  const pageTitleText = pageTitle(b.title, title);

  return addImageSizes(template
    .replace('<title>Fingers Of Steel® Publications</title>', `<title>${esc(pageTitleText)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(summary)}">`)
    .replace('<link rel="canonical" href="https://fingersofsteel.com/">', `<link rel="canonical" href="${url}">` +
      socialTags({ type: 'book', title: pageTitleText, description: summary, url, image: b.large[0], alt: `${b.title} cover` }) +
      jsonLd(book))
    .replace(/\s*<h1>Fingers Of Steel® Publications<\/h1>/, '')
    .replace('<body>', `<body>${MASTHEAD}`)
    .replace('<!--FOS-BODY-->', content));
}

await Promise.all(books.map(async b => {
  const dir = join(ROOT, 'books', b.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), await bookPage(b));
}));
// Remove pages for books no longer on the Folkcraft page. (Pages are overwritten in place, not wiped
// and rewritten, because Dropbox briefly locks folders it is syncing.)
for (const name of await readdir(join(ROOT, 'books'))) {
  if (!usedSlugs.has(name)) await rm(join(ROOT, 'books', name), { recursive: true, force: true, maxRetries: 5 });
}

// ---- 4. Homepage: covers and author links point to the book pages --------------------------

body = body.replace(/href="(https:\/\/(?:folkcraft|dulcimerdownloads)\.com\/products\/[^"#?]+)"/g,
  (m, url) => slugByUrl.has(url) ? `href="/books/${slugByUrl.get(url)}/"` : m);
// Card covers come from each book's own listing (the Folkcraft page's image links can go stale).
const bookBySlug = new Map(books.map(b => [b.slug, b]));
const cards = [...body.matchAll(/<a class="fos-card" href="\/books\/([^"/]+)\/"><img src="([^"]+)"/g)];
for (const [whole, slug, src] of cards) {
  const cover = bookBySlug.get(slug)?.images[0];
  if (cover) body = body.replace(whole, whole.replace(`src="${src}"`, `src="${await localImage(cover, 300)}"`));
}
body = await localizeImgs(body, 300);
// Drop the "New to the dulcimer? Start here" section, and call the category tab "Browse by genre".
body = removeElement(body, '<div class="fos-start">');
body = body.replace('>Browse by what you need</label>', '>Browse by genre</label>');
if (body.includes('<div class="fos-start">') || !body.includes('Browse by genre')) console.warn('! Homepage section edits did not apply; check the Folkcraft page markup');

// The header carries the logo, so the intro's own copy of it goes.
body = body.replace(/<img src="\/images\/fingers-of-steel-logo\.png"[^>]*>/, '');
const homeDescription = decode(template.match(/<meta name="description" content="([^"]*)">/)[1]);
await writeFile(join(ROOT, 'index.html'), addImageSizes(template
  .replace('<link rel="canonical" href="https://fingersofsteel.com/">', m => m +
    socialTags({ type: 'website', title: 'Fingers Of Steel® Publications', description: homeDescription, url: `${SITE}/`,
      image: '/images/fingers-of-steel-logo.png', alt: 'Fingers Of Steel logo', card: 'summary' }) +
    jsonLd({ '@context': 'https://schema.org', ...PUBLISHER, description: homeDescription }))
  .replace(/\s*<h1>Fingers Of Steel® Publications<\/h1>/, '')
  .replace('<body>', `<body>${masthead('h1')}`)
  .replace('<!--FOS-BODY-->', body)));

// Sitemap with every page and its book images, and robots.txt pointing to it. The descriptions/ and tools/
// folders are build inputs, not pages, so search engines are asked to skip them.
const xml = s => esc(s).replace(/'/g, '&apos;');
await writeFile(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>${SITE}/</loc></url>
${books.map(b => `  <url>
    <loc>${SITE}/books/${b.slug}/</loc>
${(b.large || []).map(u => `    <image:image><image:loc>${xml(abs(u))}</image:loc></image:image>`).join('\n')}
  </url>`).join('\n')}
</urlset>
`.replace(/\n\n/g, '\n'));
await writeFile(join(ROOT, 'robots.txt'), `User-agent: *
Disallow: /descriptions/
Disallow: /tools/

Sitemap: ${SITE}/sitemap.xml
`);

// Newly downloaded images get the site's blue frame in place of the store's green (or red) one.
if (downloaded.length) {
  const list = join(tmpdir(), `fos-reframe-${process.pid}.txt`);
  await writeFile(list, downloaded.join('\n'));
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'reframe-images.ps1'), '-ListFile', list], { stdio: 'inherit' });
  await rm(list, { force: true });
}

// Store PNGs become JPEGs (after reframing, so the new frame is in the JPEG).
if (toJpeg.size) {
  const list = join(tmpdir(), `fos-jpeg-${process.pid}.txt`);
  await writeFile(list, [...toJpeg].join('\n'));
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'png-to-jpeg.ps1'), '-ListFile', list], { stdio: 'inherit' });
  await rm(list, { force: true });
}

// Remove downloaded images no page uses any more, and record the versions of the ones in use.
for (const name of await readdir(IMAGES)) {
  if (!usedImages.has(name)) await rm(join(IMAGES, name), { force: true, maxRetries: 5 });
}
await writeFile(VERSIONS, JSON.stringify(Object.fromEntries([...usedImages].sort().map(f => [f, versions[f] || ''])), null, 1) + '\n');

// ---- Report ----------------------------------------------------------------------------------

const noPdf = books.filter(b => !b.ddUrl), noPrint = books.filter(b => !b.folkcraftUrl), noIsbn = books.filter(b => !b.isbn);
console.log(`Built ${books.length} book pages and index.html`);
console.log(`  no PDF match on DulcimerDownloads (${noPdf.length}): ${noPdf.map(b => b.full).join('; ') || 'none'}`);
console.log(`  PDF only, no Folkcraft page (${noPrint.length}): ${noPrint.map(b => b.full).join('; ') || 'none'}`);
console.log(`  no ISBN found (${noIsbn.length}): ${noIsbn.map(b => b.full).join('; ') || 'none'}`);
