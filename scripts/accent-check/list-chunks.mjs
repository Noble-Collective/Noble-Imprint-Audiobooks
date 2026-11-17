/**
 * list-chunks.mjs — every stored generation (chunk) of a Bible translation, in reading order,
 * for the accent-drift scan (.github/workflows/accent-scan.yml). Read-only: manifests + .tts.json.
 *
 * Each row: { book, code, chapter, session, chunk (1-based), of, file, gcs, chars, tagged, start }
 *   start = the first words the narrator says in that chunk (usually the section heading).
 *
 * Env: GCS_BUCKET (default noble-imprint-audiobooks), TRANSLATION (bsb), BOOK_FILTER (slug
 *      substring, optional), OUT (chunks.json), SHARDS (split into N shard lists, default 1)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { buildChunks } from '../../src/generate.js';
import { resolveChunkHashes } from '../../src/accent.js';
import { stripPauses } from '../../src/pauses.js';

const BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const TX = process.env.TRANSLATION || 'bsb';
const FILTER = process.env.BOOK_FILTER || '';
const OUT = process.env.OUT || 'chunks.json';
const SHARDS = parseInt(process.env.SHARDS || '1', 10);
const bucket = new Storage().bucket(BUCKET);

async function json(path) {
  for (let a = 1; ; a++) {
    try { const [b] = await bucket.file(path).download(); return JSON.parse(b.toString('utf-8')); }
    catch (e) { if (a >= 4 || e.code === 404) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** a)); }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

const [files] = await bucket.getFiles({ prefix: `audio/bible/${TX}/`, matchGlob: '**/manifest.json' });
const books = files.map(f => f.name.slice('audio/'.length, -'/manifest.json'.length)).filter(b => !FILTER || b.includes(FILTER));
console.log(`${books.length} book(s)`);

const rows = [], problems = [];
for (const book of books) {
  const m = await json(`audio/${book}/manifest.json`);
  const code = (m.bookPath || '').split('/').pop();
  const per = await pool(m.sessions || [], 12, async s => {
    if (!s.ttsFile || !s.hashToFile) return { problem: 'no tts/hashToFile' };
    const tts = await json(`audio/${book}/${s.ttsFile}`);
    const want = new Set(Object.keys(s.hashToFile));
    const b = buildChunks(tts.blocks, tts.plainText, s.chunkingStrategy || 'section', undefined, s.pauseStyle || 'ssml');
    const r = resolveChunkHashes(b.chunks, s.chunkKey || '', want, s.accentTag || '');
    if (!r) return { problem: 'chunks do not hash to the manifest' };
    const slug = s.audioFile.replace(/\.mp3$/, '');
    return {
      rows: r.hashes.map((h, i) => ({
        book, code, chapter: parseInt(s.sessionFile, 10), session: s.sessionFile, chunk: i + 1, of: r.hashes.length,
        file: s.hashToFile[h], gcs: `gs://${BUCKET}/audio/${book}/chunks/${slug}/${s.hashToFile[h]}.mp3`,
        chars: stripPauses(r.chunks[i]).length, tagged: r.chunks[i] !== b.chunks[i],
        start: stripPauses(b.chunks[i]).replace(/\s+/g, ' ').trim().slice(0, 70),
      })),
    };
  });
  per.forEach((p, i) => { if (p.problem) problems.push(`${book} ${m.sessions[i].sessionFile}: ${p.problem}`); else rows.push(...p.rows); });
  console.log(`${book}: ${m.sessions.length} chapter(s)`);
}

writeFileSync(OUT, JSON.stringify(rows));
console.log(`${rows.length} chunks, ${rows.reduce((n, r) => n + r.chars, 0).toLocaleString()} spoken chars → ${OUT}`);
if (problems.length) { console.log(`${problems.length} chapter(s) not listed:`); problems.forEach(p => console.log(`  ${p}`)); }

// Shard lists for the matrix: balanced by characters (≈ audio length), as gs:// URL lists.
if (SHARDS > 1) {
  mkdirSync('shards', { recursive: true });
  const load = Array(SHARDS).fill(0), lists = Array.from({ length: SHARDS }, () => []);
  for (const r of [...rows].sort((a, b) => b.chars - a.chars)) {
    const k = load.indexOf(Math.min(...load)); load[k] += r.chars; lists[k].push(r.gcs);
  }
  lists.forEach((l, k) => writeFileSync(`shards/${k}.txt`, l.join('\n') + '\n'));
  console.log(`${SHARDS} shards`);
}
