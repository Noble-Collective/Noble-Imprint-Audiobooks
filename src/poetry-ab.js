/**
 * poetry-ab.js — A/B audio for the poetry-couplet change, published for judgment.
 *
 * Renders WHOLE CHAPTERS twice with the BSB audiobook voice/settings, using the REAL
 * production path (parseUsfmBook → chapterToMarkdown WITH the H1 chapter title →
 * preprocessSession → buildNaturalGenerations → ElevenLabs TTS → concat with real
 * silence → loudness-normalize). Rendering full chapters (not excerpts) is deliberate:
 * this voice runs at stability 0.50, where the section strategy packs each heading-span
 * into a long ~1,000-2,000-char generation; a short isolated generation paces
 * differently, so only a full-chapter render reflects how a real re-render will sound.
 *   A = current shipped rules  (poetry grouped into a flowing stanza)
 *   B = poetry_couplets on      (one couplet per block → a natural pause per couplet)
 *
 * Publishes each chapter to GCS voice-test/{slug}/ as a.mp3 + b.mp3 + a manifest in the
 * voice-compare shape, so the website serves an A/B page at /voice-test/{slug} with NO
 * website changes. A "voice" here is a rule-set (A / B), not a different narrator.
 *
 * Env:
 *   ELEVENLABS_API_KEY   (required unless DRY_RUN)
 *   GCS_BUCKET           (default: noble-imprint-audiobooks)
 *   RESOURCES_PATH       (default: ../Noble-Imprint-Resources) — checked-out content repo
 *   DRY_RUN=true         preprocess + print the A/B stats, no TTS/upload/spend
 *   FORCE=true           re-render even if a.mp3/b.mp3 already exist in GCS
 *
 * The generation/concat/loudness helpers are COPIED VERBATIM from src/generate.js
 * (which exports none of them). Keep in sync.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';
import { parseUsfmBook, chapterToMarkdown } from './usfm-to-markdown.js';
import { preprocessSession } from './preprocess-tts.js';

const API_BASE = 'https://api.elevenlabs.io/v1';
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';
const TX = 'bsb';

// ---- pipeline constants copied from generate.js ----
const MAX_GENERATION = 2000;
const LIGHT_SEAM_SECONDS = 0.4;
const HEADING_GAP = { h1: 2.0, h2: 1.5, h3: 1.0, h4: 1.0, h5: 1.0, h6: 1.0 };
const FORCE_SPLIT_TYPES = new Set(['h1', 'h2', 'h3']);
const TARGET_LUFS = -20, TARGET_TP = -1.5, TARGET_LRA = 11, LOUDNESS_TOLERANCE = 2;

// ---- the A/B chapters (whole chapters, rendered exactly as production would) ----
// Isaiah 40 is the strongest stress test: the couplet change turns 11 blocks into 51
// (+40 pause points) — the most of any candidate — across a full chapter of sustained
// Hebrew parallelism.
const SNIPPETS = [
  { slug: 'poetry-isa40', file: '23ISABSB.SFM', ch: 40,
    title: 'Isaiah 40 — full chapter (production-accurate A/B)' },
];

// Stale short-excerpt slugs from the first (invalid) pass — deleted so only the valid
// full-chapter page remains.
const STALE_SLUGS = ['poetry-2tim2', 'poetry-psalm1', 'poetry-prov3', 'poetry-prov10'];

// Parse a whole chapter and serialize it to session markdown WITH the H1 chapter title,
// exactly as the production converter does (chapterToMarkdown) — so the section chunker
// produces the real generations.
function chapterMarkdown(usfm, ch, couplets) {
  const parsed = parseUsfmBook(usfm, { poetryCouplets: couplets });
  const chap = parsed.chapters.find(c => c.num === ch);
  if (!chap) throw new Error(`chapter ${ch} not found`);
  return { md: chapterToMarkdown(parsed.bookName, chap), blocks: chap.blocks, bookName: parsed.bookName };
}
// Display blocks for the page. Poetry blocks (tagPoetry) get a gold left-accent so the
// couplet lines — every point where B inserts a pause — stand out; prose stays plain.
// Verse <sup> kept. The template renders block text raw (<%- %>), so inline HTML is safe.
const ACCENT = '#c8a04a';
function poeSpan(t) {
  return `<span style="display:block;border-left:3px solid ${ACCENT};padding:0.1rem 0 0.1rem 0.8rem;` +
    `margin:0.15rem 0;background:rgba(200,160,74,0.10);border-radius:0 5px 5px 0;">${t}</span>`;
}
function displayBlocks(bookName, ch, blocks) {
  const out = [{ type: 'h1', text: `${bookName} ${ch}` }];
  out.push({ type: 'p', text:
    `<span style="display:block;font-size:0.85rem;opacity:0.75;font-family:'DM Sans',sans-serif;` +
    `padding:0.55rem 0.8rem;background:rgba(200,160,74,0.10);border-left:3px solid ${ACCENT};border-radius:0 5px 5px 0;">` +
    `Each <b>gold-barred line</b> is couplet poetry — a point where <b>B</b> inserts a pause. Plain lines are prose. ` +
    `In Isaiah 40 every one of the 31 verses is this style (only the connector “A voice of one calling:” is prose) — ` +
    `which is exactly why it is the hardest test of the change.</span>` });
  for (const b of blocks) {
    if (b.type === 'h2' || b.type === 'h3') { out.push({ type: 'h2', text: b.text }); continue; }
    out.push({ type: 'p', text: b.poetry ? poeSpan(b.text) : b.text });
  }
  return out;
}

// ================= copied verbatim from generate.js =================
function splitSentences(text) {
  const parts = text.match(/[^.!?]*[.!?]+["'”’)\]]*(?:\s+|$)/g);
  return parts ? parts.map(x => x.trim()).filter(Boolean) : [text];
}
function splitLongBlocks(blocks, target) {
  const out = [];
  for (const b of blocks) {
    const text = b.nodes[0].text;
    if (b.sub_type !== 'p' || text.length <= target) { out.push(b); continue; }
    let cur = ''; let piece = 0;
    const push = t => { out.push({ ...b, nodes: [{ ...b.nodes[0], text: t }], _splitCont: piece > 0 }); piece++; };
    for (const sname of splitSentences(text)) {
      if (cur && cur.length + 1 + sname.length > target) { push(cur); cur = sname; }
      else { cur = cur ? cur + ' ' + sname : sname; }
    }
    if (cur) push(cur);
  }
  return out;
}
function buildNaturalGenerations(blocks, maxGeneration = MAX_GENERATION) {
  const isHeading = b => HEADING_GAP[b.sub_type] !== undefined;
  const isBoundary = b => FORCE_SPLIT_TYPES.has(b.sub_type);
  const sections = []; let cur = []; let lastWasBoundary = false;
  for (const b of blocks) {
    const boundary = isBoundary(b);
    if (boundary && cur.length > 0 && !lastWasBoundary) { sections.push(cur); cur = []; }
    cur.push(b); lastWasBoundary = boundary;
  }
  if (cur.length) sections.push(cur);
  const renderBlocks = group => group.map(b => {
    let t = b.nodes[0].text.replace(/<break[^>]*\/>/g, '').trim();
    if (!t) return '';
    if (isHeading(b)) { if (!/[.!?:…—]$/.test(t)) t += '.'; t += `<break time="${HEADING_GAP[b.sub_type]}s"/>`; }
    return t;
  }).filter(Boolean).join('\n\n');
  const texts = [], gaps = [], continuations = [];
  sections.forEach((sec, si) => {
    const firstBoundary = sec.find(isBoundary);
    const sectionGap = si === 0 ? 0 : (firstBoundary ? HEADING_GAP[firstBoundary.sub_type] : 0);
    const secBlocks = splitLongBlocks(sec, maxGeneration);
    const subs = []; let group = []; let len = 0;
    for (const b of secBlocks) {
      const bl = b.nodes[0].text.length;
      if (group.length && len + bl + 2 > maxGeneration) { subs.push(group); group = []; len = 0; }
      len += group.length ? bl + 2 : bl; group.push(b);
    }
    if (group.length) subs.push(group);
    subs.forEach((sub, subi) => {
      const txt = renderBlocks(sub);
      if (!txt) return;
      texts.push(txt); gaps.push(subi === 0 ? sectionGap : LIGHT_SEAM_SECONDS); continuations.push(subi > 0);
    });
  });
  return { texts, gaps, continuations };
}
async function generateChunk(text, voiceId, modelId, voiceSettings, outputFormat, previousText, nextText, previousRequestIds) {
  const body = { text, model_id: modelId || 'eleven_multilingual_v2', voice_settings: voiceSettings };
  if (previousText) body.previous_text = previousText;
  if (nextText) body.next_text = nextText;
  if (previousRequestIds && previousRequestIds.length) body.previous_request_ids = previousRequestIds.slice(-3);
  const res = await fetch(`${API_BASE}/text-to-speech/${voiceId}/with-timestamps?output_format=${outputFormat || 'mp3_44100_128'}`,
    { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const b = await res.text();
    const err = new Error(`TTS failed (status=${res.status}): ${b || '(empty)'}`);
    err.status = b.includes('quota_exceeded') ? 'quota' : res.status;
    throw err;
  }
  const requestId = res.headers.get('request-id') || null;
  const data = await res.json();
  return { audio: Buffer.from(data.audio_base64, 'base64'), requestId };
}
async function generateWithRetry(text, ...rest) {
  const RETRYABLE = new Set([429, 500, 502, 503]);
  for (let i = 0; i < 5; i++) {
    try { return await generateChunk(text, ...rest); }
    catch (err) {
      const retry = RETRYABLE.has(err.status) || err.status === 'quota';
      if (retry && i < 4) { const wait = (err.status === 'quota' ? 60 : 4) * (i + 1); console.warn(`    retry ${i + 1} in ${wait}s (${err.status})`); await new Promise(r => setTimeout(r, wait * 1000)); continue; }
      throw err;
    }
  }
}
function concatenateChunks(chunkPaths, outputPath, gaps) {
  gaps = gaps || chunkPaths.map(() => 0);
  if (chunkPaths.length === 1) { copyFileSync(chunkPaths[0], outputPath); return; }
  let sr = 44100, chn = 1;
  try {
    const pr = execSync(`ffprobe -v quiet -select_streams a:0 -show_entries stream=sample_rate,channels -of csv=p=0 "${chunkPaths[0]}"`, { encoding: 'utf-8' }).trim().split(',');
    if (pr[0]) sr = parseInt(pr[0], 10);
    if (pr[1]) chn = parseInt(pr[1], 10);
  } catch { /* defaults */ }
  const cl = chn === 1 ? 'mono' : 'stereo';
  const inputs = [], labels = []; let idx = 0;
  for (let i = 0; i < chunkPaths.length; i++) {
    const g = i > 0 ? (gaps[i] || 0) : 0;
    if (g > 0) { inputs.push(`-f lavfi -t ${g} -i anullsrc=r=${sr}:cl=${cl}`); labels.push(`[${idx}:a]`); idx++; }
    inputs.push(`-i "${chunkPaths[i]}"`); labels.push(`[${idx}:a]`); idx++;
  }
  const filter = `${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`;
  execSync(`ffmpeg ${inputs.join(' ')} -filter_complex "${filter}" -map "[out]" -c:a libmp3lame -b:a 128k "${outputPath}" -y`, { stdio: 'pipe' });
}
function measureLoudness(path) {
  try {
    const out = execSync(`ffmpeg -hide_banner -i "${path}" -af loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json -f null - 2>&1`,
      { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
    const j = JSON.parse(out.slice(out.lastIndexOf('{'), out.lastIndexOf('}') + 1));
    return { input_i: parseFloat(j.input_i), input_tp: parseFloat(j.input_tp), input_lra: parseFloat(j.input_lra), input_thresh: parseFloat(j.input_thresh), target_offset: parseFloat(j.target_offset) };
  } catch { return null; }
}
function normalizeLoudness(path) {
  const m = measureLoudness(path);
  if (!m || !isFinite(m.input_i)) return;
  if (Math.abs(m.input_i - TARGET_LUFS) <= LOUDNESS_TOLERANCE) return;
  const tmp = path + '.norm.mp3';
  const filter = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  execSync(`ffmpeg -hide_banner -i "${path}" -af "${filter}" -ar 44100 -b:a 128k "${tmp}" -y`, { stdio: 'pipe' });
  renameSync(tmp, path);
}
// ====================================================================

// Render one mode (couplets on/off) → a single mp3 at outPath. Returns spoken char count.
async function renderMode(md, couplets, ab, outPath, tmpDir, tag) {
  const pre = preprocessSession(md, ab.voice_id, 'en', ab.language_normalization === true, { poetryCouplets: couplets });
  const gen = buildNaturalGenerations(pre.blocks, ab.max_generation || MAX_GENERATION);
  const spokenChars = gen.texts.join('').replace(/<break[^>]*\/>/g, '').length;
  console.log(`    [${tag}] generations=${gen.texts.length} gaps=[${gen.gaps.join(',')}] spokenChars=${spokenChars}`);
  if (DRY_RUN) return spokenChars;
  const chunkPaths = []; const requestIds = [];
  for (let i = 0; i < gen.texts.length; i++) {
    const prevText = (gen.continuations[i] && i > 0) ? gen.texts[i - 1] : undefined;
    const nextText = (i + 1 < gen.texts.length && gen.continuations[i + 1]) ? gen.texts[i + 1] : undefined;
    const r = await generateWithRetry(gen.texts[i], ab.voice_id, ab.model_id, ab.voice_settings, 'mp3_44100_128', prevText, nextText, requestIds.slice());
    if (r.requestId) requestIds.push(r.requestId);
    const cp = join(tmpDir, `${tag}_${i}.mp3`);
    writeFileSync(cp, r.audio); chunkPaths.push(cp);
  }
  concatenateChunks(chunkPaths, outPath, gen.gaps);
  normalizeLoudness(outPath);
  return spokenChars;
}

async function main() {
  if (!DRY_RUN && !process.env.ELEVENLABS_API_KEY) { console.error('Set ELEVENLABS_API_KEY (or DRY_RUN=true)'); process.exit(1); }
  const meta = JSON.parse(readFileSync(join(RESOURCES_PATH, 'bibles', TX, 'meta.json'), 'utf-8'));
  const ab = meta.audiobook;
  console.log(`Voice: ${ab.voice_id}  model: ${ab.model_id}  stability: ${ab.voice_settings?.stability}  DRY_RUN=${DRY_RUN}\n`);

  const storage = DRY_RUN ? null : new Storage();
  const bucket = DRY_RUN ? null : storage.bucket(GCS_BUCKET);
  mkdirSync('poetry-ab-output', { recursive: true });

  // Remove the stale short-excerpt pages from the first (invalid) pass.
  if (!DRY_RUN) {
    for (const slug of STALE_SLUGS) {
      try { await bucket.deleteFiles({ prefix: `voice-test/${slug}/` }); console.log(`cleaned stale voice-test/${slug}/`); }
      catch (e) { console.warn(`  (couldn't clean ${slug}: ${e.message})`); }
    }
  }

  let totalChars = 0;
  for (const s of SNIPPETS) {
    const gcsDir = `voice-test/${s.slug}`;
    console.log(`\n=== ${s.title}  →  /voice-test/${s.slug} ===`);

    // Reuse existing audio unless FORCE — but ALWAYS rebuild the manifest (cheap, no
    // credits), so display/legend tweaks can be republished without re-rendering TTS.
    let needAudio = FORCE;
    if (!DRY_RUN && !FORCE) {
      const [aEx] = await bucket.file(`${gcsDir}/a.mp3`).exists();
      const [bEx] = await bucket.file(`${gcsDir}/b.mp3`).exists();
      needAudio = !(aEx && bEx);
      if (!needAudio) console.log('  reusing existing a.mp3 + b.mp3 — rebuilding manifest only (no TTS)');
    }

    const usfm = readFileSync(join(RESOURCES_PATH, 'bibles', TX, 'content', s.file), 'utf-8');
    const A = chapterMarkdown(usfm, s.ch, false);
    const B = chapterMarkdown(usfm, s.ch, true);
    // Tagged parse (poetry flag per block) for the standout display.
    const dispBlocks = parseUsfmBook(usfm, { poetryCouplets: true, tagPoetry: true }).chapters.find(c => c.num === s.ch).blocks;
    const tmpDir = join('poetry-ab-output', s.slug);
    mkdirSync(tmpDir, { recursive: true });
    const aPath = join(tmpDir, 'a.mp3');
    const bPath = join(tmpDir, 'b.mp3');

    if (needAudio || DRY_RUN) {
      totalChars += await renderMode(A.md, false, ab, aPath, tmpDir, 'A');
      totalChars += await renderMode(B.md, true, ab, bPath, tmpDir, 'B');
    }

    if (DRY_RUN) continue;

    if (needAudio) {
      await bucket.upload(aPath, { destination: `${gcsDir}/a.mp3` });
      await bucket.upload(bPath, { destination: `${gcsDir}/b.mp3` });
    }

    const manifest = {
      slug: s.slug,
      title: s.title,
      translation: 'Berean Standard Bible',
      blocks: displayBlocks(B.bookName, s.ch, dispBlocks),
      voices: [
        { name: 'A — current rules', accent: 'A', blurb: 'poetry grouped into a flowing stanza (as shipped)', file: 'a.mp3' },
        { name: 'B — couplet fix', accent: 'B', blurb: 'one couplet per line, with a natural pause between', file: 'b.mp3' },
      ],
    };
    const mPath = join(tmpDir, 'manifest.json');
    writeFileSync(mPath, JSON.stringify(manifest, null, 2));
    await bucket.upload(mPath, { destination: `${gcsDir}/manifest.json` });
    console.log(`  published gs://${GCS_BUCKET}/${gcsDir}/ (a.mp3, b.mp3, manifest.json)`);
  }

  const cost = (totalChars / 10000 * 1.65).toFixed(2);
  console.log(`\nDone. spokenChars(rendered)=${totalChars}  ≈ ${totalChars} credits  ≈ $${cost}${DRY_RUN ? '  (DRY_RUN — nothing spent)' : ''}`);
  if (!DRY_RUN) console.log('Listen at https://resources.noblecollective.org/voice-test/poetry-isa40');
}

main().catch(err => { console.error('poetry-ab failed:', err); process.exit(1); });
