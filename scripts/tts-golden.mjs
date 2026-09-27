// tts-golden.mjs — fingerprint EVERYTHING that decides what ElevenLabs is asked to say
// (and therefore every chunk hash / contentHash) for the whole library, so a change to
// the timestamp code can prove it never alters narrated text. Writes
// tests/fixtures/tts-golden.json; tests/tts-stability.test.mjs recomputes and compares.
//   node scripts/tts-golden.mjs            (RESOURCES_PATH defaults to ../Noble-Imprint-Resources)
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { preprocessSession } from '../src/preprocess-tts.js';
import { usfmBookToChapters } from '../src/usfm-to-markdown.js';

export const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 20);

function findBooks(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (existsSync(join(dir, r, 'meta.json')) && existsSync(join(dir, r, 'sessions'))) out.push(r);
    else out.push(...findBooks(dir, r));
  }
  return out;
}

function fingerprint(pre) {
  return {
    plainText: sha(pre.plainText),
    blocks: sha(JSON.stringify(pre.blocks.map(b => [b.sub_type, b.nodes[0].text]))),
    sentences: sha(JSON.stringify(pre.sentences.map(s => [s.blockIndex, s.sentenceIndex, s.text]))),
  };
}

export function computeGolden(root = RESOURCES_PATH) {
  const out = {};
  const bibleDir = join(root, 'bibles', 'bsb', 'content');
  const bmeta = JSON.parse(readFileSync(join(root, 'bibles', 'bsb', 'meta.json'), 'utf-8'));
  const ab = bmeta.audiobook || {};
  for (const f of readdirSync(bibleDir).filter(f => /\.(SFM|usfm)$/i.test(f)).sort()) {
    for (const ch of usfmBookToChapters(readFileSync(join(bibleDir, f), 'utf-8'))) {
      const pre = preprocessSession(ch.markdown, ab.voice_id || 'default', bmeta.language || 'en', ab.language_normalization === true);
      out[`bible/${f}/${ch.chapter}`] = fingerprint(pre);
    }
  }
  const seriesDir = join(root, 'series');
  for (const book of findBooks(seriesDir)) {
    const meta = JSON.parse(readFileSync(join(seriesDir, book, 'meta.json'), 'utf-8'));
    if (!meta.audiobook?.enabled) continue;
    const sd = join(seriesDir, book, 'sessions');
    for (const file of readdirSync(sd).filter(f => f.endsWith('.md')).sort()) {
      const pre = preprocessSession(readFileSync(join(sd, file), 'utf-8'), meta.audiobook.voice_id || 'default',
        meta.language || 'en', meta.audiobook.language_normalization === true);
      out[`series/${book}/${file}`] = fingerprint(pre);
    }
  }
  return out;
}

export function resourcesHead(root = RESOURCES_PATH) {
  try { return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' }).trim(); } catch { return null; }
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const golden = { resourcesHead: resourcesHead(), sessions: computeGolden() };
  writeFileSync(new URL('../tests/fixtures/tts-golden.json', import.meta.url), JSON.stringify(golden, null, 1));
  console.log(`wrote ${Object.keys(golden.sessions).length} sessions @ resources ${golden.resourcesHead}`);
}
