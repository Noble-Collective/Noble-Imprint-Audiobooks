// pad-chapter-tail.mjs — add the chapter-end silence (pauses.js chapterEnd, 2 s) to chapters
// that were rendered before it existed. 0 ElevenLabs credits: each chapter MP3 is rebuilt from
// its stored chunk MP3s exactly as generate.js built it (same chunks, same section gaps, same
// single encode + loudness step) with the tail appended. Timestamps are not touched — the
// silence is after the last word, so no time moves.
//
// Safety: a chapter is replaced only if its chunks rebuild from the stored .tts.json to the
// manifest's hashes AND the rebuilt file is the published duration + the tail (±0.05 s) —
// i.e. the same audio with silence added. Originals are copied to
// audio/_backup/2026-10-15-pre-tail/… first (never overwriting an earlier backup).
//
//   BOOK=bible/bsb/matthew MODE=dry-run|write node scripts/pad-chapter-tail.mjs
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';
import { buildChunks, hashChunk, concatenateChunks, normalizeLoudness } from '../src/generate.js';
import { PAUSES } from '../src/pauses.js';

const BOOK = process.env.BOOK;
const MODE = process.env.MODE || 'dry-run';
const BACKUP = 'audio/_backup/2026-10-15-pre-tail';
const TAIL = PAUSES.chapterEnd.seconds;
if (!BOOK) { console.error('Set BOOK, e.g. bible/bsb/matthew'); process.exit(1); }

const bucket = new Storage().bucket(process.env.GCS_BUCKET || 'noble-imprint-audiobooks');
const base = `audio/${BOOK}`;
const probe = p => parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: 'utf-8' }).trim());
const readJson = async p => JSON.parse((await bucket.file(p).download())[0].toString());

async function main() {
  const work = join(tmpdir(), 'pad-tail', BOOK.replace(/\//g, '_'));
  mkdirSync(work, { recursive: true });
  const manifest = await readJson(`${base}/manifest.json`);
  console.log(`[pad] ${BOOK}: ${manifest.sessions.length} chapter(s), tail ${TAIL}s, MODE=${MODE}`);
  const done = {};
  let ok = 0, skipped = 0, already = 0;

  for (const s of manifest.sessions) {
    const slug = s.audioFile.replace(/\.mp3$/, '');
    if (s.tailSilenceSeconds) { already++; continue; }
    const tts = await readJson(`${base}/${s.ttsFile}`);
    const b = buildChunks(tts.blocks, tts.plainText, s.chunkingStrategy || 'section', undefined, s.pauseStyle || 'ssml');
    const hashes = b.chunks.map(c => hashChunk(c, s.chunkKey || ''));
    if (!hashes.every(h => s.hashToFile[h]) || hashes.length !== s.chunkCount) {
      console.log(`  ${slug} SKIP — chunks don't rebuild to the manifest hashes`); skipped++; continue;
    }
    const paths = [];
    for (const h of hashes) {
      const p = join(work, `${slug}-${h}.mp3`);
      await bucket.file(`${base}/chunks/${slug}/${s.hashToFile[h]}.mp3`).download({ destination: p });
      paths.push(p);
    }
    const published = join(work, `${slug}.published.mp3`);
    await bucket.file(`${base}/${s.audioFile}`).download({ destination: published });
    const before = probe(published);

    const out = join(work, `${slug}.mp3`);
    const gaps = b.chunks.length === 1 ? [0] : b.chunkGaps;
    concatenateChunks(paths, out, work, gaps, TAIL);
    normalizeLoudness(out);
    const after = probe(out);
    const delta = after - before;
    if (Math.abs(delta - TAIL) > 0.05) {
      console.log(`  ${slug} SKIP — rebuilt ${after.toFixed(2)}s vs published ${before.toFixed(2)}s (Δ ${delta.toFixed(3)}, want ${TAIL})`); skipped++; continue;
    }
    console.log(`  ${slug} ok — ${before.toFixed(2)}s → ${after.toFixed(2)}s`);
    ok++;
    if (MODE !== 'write') continue;
    const bak = bucket.file(`${BACKUP}/${BOOK}/${s.audioFile}`);
    if (!(await bak.exists())[0]) await bucket.file(`${base}/${s.audioFile}`).copy(bak);
    await bucket.upload(out, { destination: `${base}/${s.audioFile}` });
    done[s.sessionFile] = { durationSeconds: Math.round(after), tailSilenceSeconds: TAIL, generatedAt: new Date().toISOString() };
  }

  if (MODE === 'write' && Object.keys(done).length) {
    // Re-read so a concurrent change to other sessions isn't lost; patch only ours.
    const fresh = await readJson(`${base}/manifest.json`);
    for (const s of fresh.sessions) if (done[s.sessionFile]) Object.assign(s, done[s.sessionFile]);
    fresh.totalDurationSeconds = fresh.sessions.reduce((a, s) => a + (s.durationSeconds || 0), 0);
    const mp = join(work, 'manifest.json');
    writeFileSync(mp, JSON.stringify(fresh, null, 2));
    await bucket.upload(mp, { destination: `${base}/manifest.json` });
    console.log(`[pad] manifest updated (${Object.keys(done).length} chapter(s))`);
  }
  console.log(`[pad] ok ${ok}, skipped ${skipped}, already padded ${already}${MODE === 'write' ? '' : ' (dry-run: nothing written)'}`);
  if (skipped) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
