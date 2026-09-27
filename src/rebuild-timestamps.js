/**
 * rebuild-timestamps.js — Timestamps-ONLY rebuild from the cached ElevenLabs alignments.
 * NO TTS, NO credits, NO audio change: reads each session's stored .tts.json, the per-chunk
 * .align.json + chunk .mp3 (for its duration) already in GCS, and rewrites only
 * <slug>.timestamps.json. See plans/2026-09-27-timestamp-title-fix.md.
 *
 * Fixes (current buildTimestampsFromAlignments): chapter titles read differently from their
 * display text ("Genesis 28" read "Genesis, Chapter 28") are timed from their audio instead
 * of guessed; leftover markdown stripped from segment text; Bible segments gain `words`.
 *
 * SAFETY — a session is rewritten only when ALL of these hold:
 *   1. the chunks rebuilt from .tts.json hash to exactly the manifest's hashToFile (the same
 *      text that was narrated);
 *   2. the OLD algorithm run on the rebuilt inputs reproduces the PUBLISHED timestamps
 *      (every start/end/blockIndex/sentenceIndex/text) — proves chunks, durations and gaps;
 *   3. the NEW result differs in time ONLY on headings read differently from their display
 *      text; segment count/order/indices unchanged.
 * Anything else is SKIPPED and reported. Originals are copied to BACKUP_PREFIX first.
 *
 * Env:
 *   MODE=dry-run|write     (default dry-run — reads only)
 *   SOURCE=gcs|api         (api = read-only via the public audio API, for local spot checks)
 *   BOOK_FILTER            substring of the book slug path (e.g. "bible/bsb/genesis")
 *   SESSION_FILTER         exact session file (e.g. "028.md")
 *   BOOKS                  (api source) comma list of book slug paths to read
 *   BACKUP_PREFIX          default audio/_backup/2026-09-27-timestamps
 *   REPORT                 report path (default rebuild-report.json)
 *   OUT_DIR                also save every rebuilt file here (inspection; any mode)
 */

import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { buildChunks, hashChunk, buildTimestampsFromAlignments, serializeTimestamps } from './generate.js';
import { buildSentenceIndex } from './preprocess-tts.js';

const MODE = process.env.MODE || 'dry-run';
const SOURCE = process.env.SOURCE || 'gcs';
const BOOK_FILTER = process.env.BOOK_FILTER || '';
const SESSION_FILTER = process.env.SESSION_FILTER || '';
const BACKUP_PREFIX = process.env.BACKUP_PREFIX || 'audio/_backup/2026-09-27-timestamps';
const REPORT = process.env.REPORT || 'rebuild-report.json';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8', 10);
const API = process.env.AUDIO_API || 'https://resources.noblecollective.org';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const OUT_DIR = process.env.OUT_DIR || '';   // also save each rebuilt file here (inspection)
const TOL = 0.011; // both sides are rounded to 0.01 s

if (!['dry-run', 'write'].includes(MODE)) throw new Error(`MODE must be dry-run|write, got ${MODE}`);
if (MODE === 'write' && SOURCE !== 'gcs') throw new Error('write mode needs SOURCE=gcs');

// ── Storage sources ────────────────────────────────────────────────────────────────────
async function gcsSource() {
  const { Storage } = await import('@google-cloud/storage');
  const bucket = new Storage().bucket(process.env.GCS_BUCKET || 'noble-imprint-audiobooks');
  const retry = async (fn, label) => {
    for (let a = 1; ; a++) {
      try { return await fn(); } catch (e) {
        if (e.code === 404 || a >= 4) throw e;
        console.warn(`  retry ${label} (${a}): ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * 2 ** a));
      }
    }
  };
  return {
    async listBooks() {
      const [files] = await bucket.getFiles({ prefix: 'audio/', matchGlob: '**/manifest.json' });
      return files.map(f => f.name)
        .filter(n => !n.startsWith('audio/_backup/') && !n.startsWith('audio/voice-test/'))
        .map(n => n.slice('audio/'.length, -'/manifest.json'.length));
    },
    async readJson(path) {
      const [buf] = await retry(() => bucket.file(path).download(), path);
      return { json: JSON.parse(buf.toString('utf-8')), bytes: buf.length };
    },
    async download(path, local) { await retry(() => bucket.file(path).download({ destination: local }), path); },
    async exists(path) { const [e] = await bucket.file(path).exists(); return e; },
    async copy(from, to) { await retry(() => bucket.file(from).copy(bucket.file(to)), `copy ${from}`); },
    async writeText(path, text) {
      await retry(() => bucket.file(path).save(text, { contentType: 'application/json', resumable: false }), `save ${path}`);
    },
  };
}

function apiSource() {
  const split = path => { // audio/<book>/<rel> — book = the BOOKS entry it starts with
    const p = path.slice('audio/'.length);
    const book = BOOKS.find(b => p.startsWith(b + '/'));
    return { book, rel: p.slice(book.length + 1) };
  };
  const signed = async path => {
    const { book, rel } = split(path);
    const r = await fetch(`${API}/api/audio/url/${book}/${rel.split('/').map(encodeURIComponent).join('/')}`);
    if (!r.ok) { const e = new Error(`sign ${path}: ${r.status}`); e.code = r.status; throw e; }
    return (await r.json()).url;
  };
  const get = async path => {
    const r = await fetch(await signed(path));
    if (!r.ok) { const e = new Error(`get ${path}: ${r.status}`); e.code = r.status; throw e; }
    return Buffer.from(await r.arrayBuffer());
  };
  const BOOKS = (process.env.BOOKS || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    async listBooks() { return BOOKS; },
    async readJson(path) {
      if (path.endsWith('/manifest.json')) {
        const book = path.slice('audio/'.length, -'/manifest.json'.length);
        const r = await fetch(`${API}/api/audio/manifest/${book}`);
        const buf = Buffer.from(await r.arrayBuffer());
        return { json: JSON.parse(buf.toString('utf-8')), bytes: buf.length };
      }
      const buf = await get(path);
      return { json: JSON.parse(buf.toString('utf-8')), bytes: buf.length };
    },
    async download(path, local) { writeFileSync(local, await get(path)); },
    async exists() { return false; },
    async copy() { throw new Error('read-only source'); },
    async writeText() { throw new Error('read-only source'); },
  };
}

function probeDuration(local) {
  const out = execSync(`"${FFPROBE}" -v quiet -show_entries format=duration -of csv=p=0 "${local}"`, { encoding: 'utf-8' });
  return parseFloat(out.trim());
}

// ── One session ────────────────────────────────────────────────────────────────────────
const near = (a, b) => Math.abs(a - b) <= TOL;
const quiet = fn => { // buildTimestampsFromAlignments logs per-file warnings; keep the run readable
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
};

function firstDiff(a, b, timesOnly = false) {
  if (a.length !== b.length) return `segment count ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!near(x.start, y.start) || !near(x.end, y.end)) return `#${i} time ${x.start}-${x.end} vs ${y.start}-${y.end} ${JSON.stringify((y.text || '').slice(0, 50))}`;
    if (x.blockIndex !== y.blockIndex || x.sentenceIndex !== y.sentenceIndex) return `#${i} index ${x.blockIndex}/${x.sentenceIndex} vs ${y.blockIndex}/${y.sentenceIndex}`;
    if (!timesOnly && x.text !== y.text) return `#${i} text ${JSON.stringify(x.text.slice(0, 50))} vs ${JSON.stringify(y.text.slice(0, 50))}`;
  }
  return null;
}

async function processSession(src, bookSlugPath, s, workDir) {
  const r = { book: bookSlugPath, session: s.sessionFile };
  const base = `audio/${bookSlugPath}`;
  const bible = bookSlugPath.startsWith('bible/');
  const slug = s.audioFile.replace(/\.mp3$/, '');
  if (!s.timestampsFile || !s.ttsFile || !s.hashToFile) return { ...r, status: 'skip', reason: 'manifest entry lacks timestamps/tts/hashToFile' };

  const { json: tts } = await src.readJson(`${base}/${s.ttsFile}`);
  const { json: published, bytes: oldBytes } = await src.readJson(`${base}/${s.timestampsFile}`);

  // 1. Chunks must hash to exactly what was narrated.
  const want = new Set(Object.keys(s.hashToFile));
  let built = null;
  for (const strategy of [...new Set([s.chunkingStrategy, 'section', 'linear'].filter(Boolean))]) {
    const b = buildChunks(tts.blocks, tts.plainText, strategy);
    const hs = b.chunks.map(hashChunk);
    if (hs.length === (s.chunkCount ?? hs.length) && hs.every(h => want.has(h)) && new Set(hs).size === want.size) {
      built = { ...b, hashes: hs, strategy }; break;
    }
  }
  if (!built) return { ...r, status: 'skip', reason: 'chunks rebuilt from tts.json do not hash to the manifest' };

  // Inputs exactly as generate.js had them: alignments, probed chunk durations, real gaps.
  const aligns = [], durs = [];
  for (const h of built.hashes) {
    const file = s.hashToFile[h];
    try { aligns.push((await src.readJson(`${base}/chunks/${slug}/${file}.align.json`)).json); }
    catch (e) { if (e.code === 404) aligns.push(null); else throw e; }
    const local = join(workDir, `${slug}-${file}.mp3`);
    await src.download(`${base}/chunks/${slug}/${file}.mp3`, local);
    durs.push(probeDuration(local));
    rmSync(local, { force: true });
  }
  const gaps = built.chunks.length === 1 ? built.chunks.map(() => 0)
    : built.chunkGaps.map((g, i) => (i > 0 && g > 0 ? g : 0));
  const sentences = buildSentenceIndex(tts.blocks);

  const oldSentences = sentences.map(({ matchText, ...rest }) => rest);
  const pubSegs = published.segments || [];

  // Chunk offsets. ffprobe's MP3 duration can differ by a frame (~0.026 s) between ffmpeg
  // builds, which shifts every later chunk. So each chunk's start is SOLVED from the
  // published file: every segment matched inside chunk c pins its offset to within the
  // 0.01 s rounding (published = round(offset + alignment time)); the intervals must
  // intersect, and the chosen offset must agree with ffprobe within 0.1 s.
  let calib;
  try {
    const probe = quiet(() => buildTimestampsFromAlignments(aligns, built.chunks, durs, oldSentences, gaps, { trace: true })).segments;
    const n = built.chunks.length, E = 0.00501;
    const lo = Array(n).fill(-Infinity), hi = Array(n).fill(Infinity);
    probe.forEach((seg, i) => {
      const t = seg.trace, p = pubSegs[i];
      if (!t || !p) return;
      lo[t.chunk] = Math.max(lo[t.chunk], p.start - t.relStart - E, p.end - t.relEnd - E);
      hi[t.chunk] = Math.min(hi[t.chunk], p.start - t.relStart + E, p.end - t.relEnd + E);
    });
    const expected = []; let acc = 0;
    for (let c = 0; c < n; c++) { acc += gaps[c]; expected.push(acc); acc += durs[c]; }
    const offs = []; let carry = 0, worst = 0;
    for (let c = 0; c < n; c++) {
      if (lo[c] > hi[c]) return { ...r, status: 'skip', reason: `chunk ${c} offsets inconsistent with published` };
      let off = expected[c] + carry;
      if (c === 0) off = 0;
      else if (Number.isFinite(lo[c])) off = Math.min(Math.max(off, lo[c]), hi[c]);
      if (c === 0 && (lo[0] > E || hi[0] < -E)) return { ...r, status: 'skip', reason: 'chunk 0 does not start at 0' };
      // Per-chunk correction (this chunk's duration vs ffprobe's) — a frame or two at most.
      worst = Math.max(worst, Math.abs((off - expected[c]) - carry));
      carry = off - expected[c];
      offs.push(off);
    }
    if (worst > 0.06) return { ...r, status: 'skip', reason: `a solved chunk duration differs from ffprobe by ${worst.toFixed(3)} s` };
    for (let c = 0; c + 1 < n; c++) durs[c] = offs[c + 1] - offs[c] - gaps[c + 1];
    calib = worst;
  } catch (e) { return { ...r, status: 'skip', reason: `rebuild threw: ${e.message}` }; }

  // 2. The OLD algorithm (headings matched by display text) must reproduce what's published.
  let reproduced;
  try { reproduced = quiet(() => buildTimestampsFromAlignments(aligns, built.chunks, durs, oldSentences, gaps)).segments; }
  catch (e) { return { ...r, status: 'skip', reason: `rebuild threw: ${e.message}` }; }
  const cleanedPub = pubSegs.map(p => ({ ...p })); // compare times + indices; text below
  const d1 = firstDiff(reproduced, cleanedPub, true);
  if (d1) return { ...r, status: 'skip', reason: `does not reproduce published: ${d1}` };
  const textMismatch = pubSegs.findIndex((p, i) => p.text !== oldSentences[i].text);
  if (textMismatch >= 0) return { ...r, status: 'skip', reason: `published text differs from sentence index at #${textMismatch}` };

  // 3. NEW result: time changes only on headings read differently.
  const next = quiet(() => buildTimestampsFromAlignments(aligns, built.chunks, durs, sentences, gaps, { words: bible })).segments;
  if (next.length !== reproduced.length) return { ...r, status: 'skip', reason: 'segment count changed' };
  const timeChanges = [], textChanges = [];
  for (let i = 0; i < next.length; i++) {
    const a = reproduced[i], b = next[i];
    if (a.blockIndex !== b.blockIndex || a.sentenceIndex !== b.sentenceIndex) return { ...r, status: 'skip', reason: `index changed at #${i}` };
    if (!near(a.start, b.start) || !near(a.end, b.end)) {
      if (!sentences[i].matchText) return { ...r, status: 'skip', reason: `unexpected time change at #${i} (${a.start}-${a.end} → ${b.start}-${b.end}) ${JSON.stringify(b.text.slice(0, 40))}` };
      timeChanges.push({ i, text: b.text, old: [a.start, a.end], new: [b.start, b.end] });
    }
    if (pubSegs[i].text !== b.text) textChanges.push({ i, old: pubSegs[i].text.slice(0, 80), new: b.text.slice(0, 80) });
  }
  const overlapsBefore = pubSegs.filter((p, i) => i + 1 < pubSegs.length && p.end > pubSegs[i + 1].start + 0.3).length;
  const overlapsAfter = next.filter((p, i) => i + 1 < next.length && p.end > next[i + 1].start + 0.3).length;
  const withWords = next.filter(n => n.words).length;

  const body = serializeTimestamps({ segments: next });
  const changed = timeChanges.length > 0 || textChanges.length > 0 || withWords > 0;
  const out = {
    ...r, status: changed ? 'change' : 'unchanged', strategy: built.strategy, chunks: built.chunks.length, calib,
    segments: next.length, timeChanges, textChanges, withWords, overlapsBefore, overlapsAfter,
    bytesOld: oldBytes, bytesNew: Buffer.byteLength(body),
  };
  if (changed && OUT_DIR) { // dry-run inspection copy
    const f = join(OUT_DIR, bookSlugPath.replace(/\//g, '__') + '__' + s.timestampsFile);
    writeFileSync(f, body);
  }
  if (changed && MODE === 'write') {
    const target = `${base}/${s.timestampsFile}`;
    const backup = `${BACKUP_PREFIX}/${bookSlugPath}/${s.timestampsFile}`;
    if (!(await src.exists(backup))) await src.copy(target, backup);  // never overwrite the first backup
    await src.writeText(target, body);
    out.written = true;
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────────────
async function main() {
  const src = SOURCE === 'api' ? apiSource() : await gcsSource();
  const workDir = join(tmpdir(), 'rebuild-timestamps');
  mkdirSync(workDir, { recursive: true });
  if (OUT_DIR) mkdirSync(OUT_DIR, { recursive: true });
  const books = (await src.listBooks()).filter(b => !BOOK_FILTER || b.includes(BOOK_FILTER)).sort();
  console.log(`[rebuild] MODE=${MODE} SOURCE=${SOURCE} — ${books.length} book(s)`);

  const jobs = [];
  for (const book of books) {
    const { json: manifest } = await src.readJson(`audio/${book}/manifest.json`);
    for (const s of manifest.sessions || []) {
      if (SESSION_FILTER && s.sessionFile !== SESSION_FILTER) continue;
      jobs.push({ book, s });
    }
  }
  console.log(`[rebuild] ${jobs.length} session(s)`);

  const results = [];
  let next = 0, done = 0;
  async function worker() {
    while (next < jobs.length) {
      const { book, s } = jobs[next++];
      let res;
      try { res = await processSession(src, book, s, workDir); }
      catch (e) { res = { book, session: s.sessionFile, status: 'error', reason: e.message }; }
      results.push(res);
      if (++done % 50 === 0 || res.status !== 'change') {
        console.log(`  [${done}/${jobs.length}] ${book}/${s.sessionFile} ${res.status}${res.reason ? ' — ' + res.reason : ''}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => (a.book + a.session).localeCompare(b.book + b.session));

  const count = st => results.filter(x => x.status === st).length;
  const changes = results.filter(x => x.status === 'change');
  const sum = k => changes.reduce((n, x) => n + (typeof x[k] === 'number' ? x[k] : x[k].length), 0);
  const summary = {
    mode: MODE, sessions: results.length,
    change: count('change'), unchanged: count('unchanged'), skip: count('skip'), error: count('error'),
    written: results.filter(x => x.written).length,
    headingTimeChanges: sum('timeChanges'), textChanges: sum('textChanges'), segmentsWithWords: sum('withWords'),
    overlapsBefore: results.reduce((n, x) => n + (x.overlapsBefore || 0), 0),
    overlapsAfter: results.reduce((n, x) => n + (x.overlapsAfter || 0), 0),
    bytesOld: sum('bytesOld'), bytesNew: sum('bytesNew'),
  };
  writeFileSync(REPORT, JSON.stringify({ summary, results }, null, 1));

  const lines = [
    `## Timestamps rebuild — ${MODE}`, '',
    '| | |', '|---|---|',
    ...Object.entries(summary).map(([k, v]) => `| ${k} | ${v} |`), '',
    '### Skipped / errors', '',
    ...results.filter(x => x.status === 'skip' || x.status === 'error').slice(0, 200)
      .map(x => `- \`${x.book}/${x.session}\` **${x.status}** — ${x.reason}`), '',
    '### Sample title changes', '',
    ...changes.filter(x => x.timeChanges.length).slice(0, 15)
      .map(x => `- \`${x.book}/${x.session}\` ${x.timeChanges.map(t => `"${t.text}" ${t.old.join('–')} → ${t.new.join('–')}`).join('; ')}`), '',
    '### Text changes', '',
    ...changes.flatMap(x => x.textChanges.map(t => `- \`${x.book}/${x.session}\` #${t.i}: ${JSON.stringify(t.old)} → ${JSON.stringify(t.new)}`)).slice(0, 60),
  ];
  console.log('\n' + lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  if (summary.error > 0) process.exitCode = 1;
}

main().catch(e => { console.error('Rebuild failed:', e); process.exit(1); });
