// One-off audit: does the scripture chapter-title transform (spokenChapterTitle) match
// any heading in the EXISTING audiobook session files? Any match means that heading's
// spoken form (and content hash) would change on the next regeneration.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spokenChapterTitle } from '../src/languages.js';

const SERIES = 'C:/Users/Steve/Dev/Noble-Imprint-Resources/series';

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Map each sessions/*.md to its book's audiobook.enabled flag.
function bookEnabled(mdPath) {
  let dir = mdPath;
  for (let i = 0; i < 6; i++) {
    dir = join(dir, '..');
    const meta = join(dir, 'meta.json');
    if (existsSync(meta)) {
      try { const m = JSON.parse(readFileSync(meta, 'utf-8')); if (m.audiobook) return !!m.audiobook.enabled; } catch {}
    }
  }
  return false;
}

const files = walk(SERIES).filter(f => f.includes('sessions'));
let matches = 0, filesScanned = 0, headings = 0;
for (const f of files) {
  filesScanned++;
  const lines = readFileSync(f, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    headings++;
    const spoken = spokenChapterTitle(m[2], 'en');
    if (spoken) {
      matches++;
      console.log(`MATCH  enabled=${bookEnabled(f)}  "${m[2]}" -> "${spoken}"`);
      console.log(`       ${f.replace(SERIES, 'series')}`);
    }
  }
}
console.log(`\nScanned ${filesScanned} session files, ${headings} headings — ${matches} would be transformed.`);
