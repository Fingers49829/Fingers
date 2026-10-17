// Makes a one-sheet PDF for every book, a few at a time.
//   node tools/build-all-one-sheets.mjs
// Then run tools/build-site.mjs so each book page links to its one-sheet.

import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const slugs = (await readdir(join(ROOT, 'books'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);

let next = 0, done = 0;
const failed = [];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < slugs.length) {
    const slug = slugs[next++];
    try {
      await run(process.execPath, [join(ROOT, 'tools', 'build-one-sheet.mjs'), slug], { cwd: ROOT });
    } catch (e) {
      failed.push(`${slug}: ${(e.stderr || e.message).trim().split('\n').pop()}`);
    }
    if (++done % 10 === 0) console.log(`${done}/${slugs.length}`);
  }
}));
console.log(`Made ${slugs.length - failed.length} of ${slugs.length} one-sheets`);
for (const f of failed) console.log(`  failed: ${f}`);
