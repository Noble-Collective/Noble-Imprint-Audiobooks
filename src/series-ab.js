/**
 * series-ab.js — the same passage of a SERIES book read by one voice on two models, published for
 * listening at /voice-test/{slug} (the voice-compare manifest shape; no website change).
 *
 * Versions:
 *   A  — eleven_multilingual_v2 with the book config exactly as series books ship today
 *        (linear ~800-char chunks, SSML <break> pauses, stability 0.71, speed 0.92)
 *   B  — eleven_v4, same voice, same chunking, v4 pause tags, stability/similarity 0.5 (the Bible's
 *        v4 settings; v4 ignores speed/style), at v4's natural pace
 *   B2 — B slowed after rendering to the series speed (ffmpeg atempo, pitch-preserving) — 0 credits
 *
 * Everything goes through the production functions (preprocessSession → buildChunks →
 * generateWithRetry → concatenateChunks → normalizeLoudness → buildTimestampsFromAlignments).
 * Writes only under GCS voice-test/{slug}/.
 *
 * Env:
 *   ELEVENLABS_API_KEY (unless DRY_RUN)   RESOURCES_PATH (default ../Noble-Imprint-Resources)
 *   SESSION   repo path of the session file (under RESOURCES_PATH)
 *   FROM      exact heading line where the passage starts (e.g. "## - First Day of Advent")
 *   UNTIL     exact heading line where it stops (excluded); empty = end of file
 *   PREFIX    markdown put before the passage (e.g. the session's H1), default none
 *   SLUG, TITLE, SUBTITLE   page slug + heading + subheading
 *   VOICE_ID  default Ollie (jRAAK67SEFE9m7ci5DhD)
 *   VARIANTS  "A,B,B2" (default)
 *   DRY_RUN=true  print the spoken text of every version, no TTS/upload
 *   FORCE=true    re-render versions whose MP3 already exists in GCS
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { preprocessSession, narrationOptions } from './preprocess-tts.js';
import {
  buildChunks, generateWithRetry, concatenateChunks, normalizeLoudness,
  buildTimestampsFromAlignments, serializeTimestamps, getCredits,
} from './generate.js';
import { stripPauses } from './pauses.js';

const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';
const SESSION = process.env.SESSION;
const FROM = process.env.FROM || '';
const UNTIL = process.env.UNTIL || '';
const PREFIX = process.env.PREFIX || '';
const SLUG = (process.env.SLUG || 'series-ab').toLowerCase().replace(/[^a-z0-9-]/g, '');
const TITLE = process.env.TITLE || 'Narration A/B';
const SUBTITLE = process.env.SUBTITLE || 'v2 vs v4';
const VOICE_ID = process.env.VOICE_ID || 'jRAAK67SEFE9m7ci5DhD';
const VARIANTS = (process.env.VARIANTS || 'A,B,B2').split(',').map(s => s.trim().toUpperCase());

// The series books' shipped config (series meta.json audiobook blocks, 2026-11).
const SERIES = {
  model_id: 'eleven_multilingual_v2',
  voice_settings: { stability: 0.71, similarity_boost: 0.5, style: 0.0, speed: 0.92 },
};
const SLOW_TEMPO = SERIES.voice_settings.speed;

const CONFIGS = {
  A: {
    file: 'a-v2.mp3', model: SERIES.model_id, settings: SERIES.voice_settings,
    name: 'A — today’s model (v2)',
    blurb: 'Eleven multilingual v2 with the settings every series audiobook uses today (HomeStead, Oration II, The Call of Christ).',
  },
  B: {
    file: 'b-v4.mp3', model: 'eleven_v4', settings: { stability: 0.5, similarity_boost: 0.5 },
    name: 'B — Eleven v4, natural pace',
    blurb: 'The newer, more expressive v4 model, same voice and text. v4 has no speed setting, so this is its own pace.',
  },
  B2: {
    file: 'b2-v4-slowed.mp3', derivedFrom: 'B',
    name: `B2 — Eleven v4, slowed to ${SLOW_TEMPO}`,
    blurb: `B slowed after rendering to the series books’ usual ${SLOW_TEMPO} pace (pitch is preserved).`,
  },
};

const probeDuration = p => parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: 'utf-8' }).trim());

function passageMarkdown() {
  if (!SESSION) throw new Error('Set SESSION');
  const lines = readFileSync(join(RESOURCES_PATH, SESSION), 'utf-8').split(/\r?\n/);
  const start = FROM ? lines.findIndex(l => l.trim() === FROM.trim()) : 0;
  if (start < 0) throw new Error(`FROM heading not found: ${FROM}`);
  let end = UNTIL ? lines.findIndex((l, i) => i > start && l.trim() === UNTIL.trim()) : lines.length;
  if (end < 0) throw new Error(`UNTIL heading not found: ${UNTIL}`);
  return (PREFIX ? PREFIX + '\n\n' : '') + lines.slice(start, end).join('\n').trim() + '\n';
}

async function render(md, v, outPath, tmpDir, tag) {
  const opts = narrationOptions({ model_id: v.model });
  const pre = preprocessSession(md, VOICE_ID, 'en', false, opts);
  const { chunks, chunkGaps } = buildChunks(pre.blocks, pre.plainText, 'linear', undefined, opts.pauseStyle);
  const spokenChars = stripPauses(chunks.join('')).length;
  console.log(`  [${tag}] ${v.model}  chunks=${chunks.length} (${chunks.map(t => t.length).join('/')})  spokenChars=${spokenChars}`);
  if (DRY_RUN) {
    chunks.forEach((t, i) => console.log(`\n  ----- [${tag}] chunk ${i + 1} -----\n${t}`));
    return { spokenChars, pre };
  }
  const paths = [], aligns = [], ids = [];
  for (let i = 0; i < chunks.length; i++) {
    const prevText = i > 0 ? chunks[i - 1].slice(-200) : undefined;
    const nextText = i < chunks.length - 1 ? chunks[i + 1].slice(0, 200) : undefined;
    const r = await generateWithRetry(chunks[i], VOICE_ID, v.model, v.settings, 'mp3_44100_128', prevText, nextText, ids.slice());
    if (r.requestId) ids.push(r.requestId);
    const cp = join(tmpDir, `${tag}_${i}.mp3`);
    writeFileSync(cp, r.audio);
    paths.push(cp);
    aligns.push(r.alignment);
  }
  const gaps = concatenateChunks(paths, outPath, tmpDir, chunkGaps);
  normalizeLoudness(outPath);
  const stats = { matched: 0, estimated: 0 };
  const ts = buildTimestampsFromAlignments(aligns, chunks, paths.map(probeDuration), pre.sentences, gaps, { stats });
  return { spokenChars, pre, stats, ts, duration: +probeDuration(outPath).toFixed(1) };
}

function slowDown(inPath, outPath) {
  execSync(`ffmpeg -hide_banner -i "${inPath}" -af atempo=${SLOW_TEMPO} -b:a 128k "${outPath}" -y`, { stdio: 'pipe' });
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function displayBlocks(md) {
  const note = '<span style="display:block;font-size:0.85rem;opacity:0.8;font-family:\'DM Sans\',sans-serif;' +
    'padding:0.55rem 0.8rem;background:rgba(200,160,74,0.10);border-left:3px solid #c8a04a;border-radius:0 5px 5px 0;">' +
    'The same reading in the same voice (Ollie). <b>A</b> is the model all our series audiobooks use today. ' +
    '<b>B</b> is the newer, more expressive Eleven v4 at its own pace; <b>B2</b> is B slowed to our usual pace. ' +
    'Listen for warmth and expression, the pace, how the hymn and poem are read, and the pauses at headings.</span>';
  const out = [{ type: 'p', text: note }];
  for (const raw of md.split(/\n\s*\n/)) {
    const t = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!t) continue;
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ type: h[1].length <= 3 ? 'h1' : 'h2', text: esc(h[2].replace(/^-\s*/, '')) }); continue; }
    const body = t.replace(/^>\s?/gm, '').replace(/^<<\s*/, '— ');
    out.push({ type: 'p', text: esc(body).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/\n/g, '<br>') });
  }
  return out;
}

async function main() {
  if (!DRY_RUN && !process.env.ELEVENLABS_API_KEY) { console.error('Set ELEVENLABS_API_KEY (or DRY_RUN=true)'); process.exit(1); }
  const md = passageMarkdown();
  const gcsDir = `voice-test/${SLUG}`;
  const tmpDir = join('series-ab-output', SLUG);
  mkdirSync(tmpDir, { recursive: true });
  console.log(`Voice ${VOICE_ID}  slug ${SLUG}  variants ${VARIANTS.join(',')}  DRY_RUN=${DRY_RUN}`);

  let bucket = null;
  if (!DRY_RUN) {
    const { Storage } = await import('@google-cloud/storage');
    bucket = new Storage().bucket(GCS_BUCKET);
  }
  const exists = async f => !DRY_RUN && (await bucket.file(`${gcsDir}/${f}`).exists())[0];
  const creditsBefore = DRY_RUN ? null : await getCredits();
  const metrics = { slug: SLUG, session: SESSION, from: FROM, until: UNTIL, voice: VOICE_ID, generatedAt: new Date().toISOString(), variants: {} };
  let total = 0;

  for (const key of VARIANTS.filter(k => k !== 'B2')) {
    const v = CONFIGS[key];
    if (!v) throw new Error(`unknown variant ${key}`);
    const outPath = join(tmpDir, v.file);
    if (!FORCE && await exists(v.file)) {
      console.log(`  [${key}] exists — skipped (FORCE=true to re-render)`);
      if (key === 'B' && VARIANTS.includes('B2') && !(await exists(CONFIGS.B2.file))) {
        await bucket.file(`${gcsDir}/${v.file}`).download({ destination: outPath });
        slowDown(outPath, join(tmpDir, CONFIGS.B2.file));
        await bucket.upload(join(tmpDir, CONFIGS.B2.file), { destination: `${gcsDir}/${CONFIGS.B2.file}` });
      }
      continue;
    }
    const r = await render(md, v, outPath, tmpDir, key);
    total += r.spokenChars;
    if (DRY_RUN) continue;
    console.log(`  [${key}] ${r.duration}s  timestamps matched ${r.stats.matched}/${r.stats.matched + r.stats.estimated}`);
    metrics.variants[key] = { model: v.model, settings: v.settings, duration: r.duration, spokenChars: r.spokenChars, timestamps: r.stats };
    await bucket.upload(outPath, { destination: `${gcsDir}/${v.file}` });
    const tsPath = join(tmpDir, v.file.replace('.mp3', '.timestamps.json'));
    writeFileSync(tsPath, serializeTimestamps(r.ts));
    await bucket.upload(tsPath, { destination: `${gcsDir}/${v.file.replace('.mp3', '.timestamps.json')}` });
    if (key === 'B' && VARIANTS.includes('B2')) {
      const b2 = join(tmpDir, CONFIGS.B2.file);
      slowDown(outPath, b2);
      await bucket.upload(b2, { destination: `${gcsDir}/${CONFIGS.B2.file}` });
      metrics.variants.B2 = { derivedFrom: 'B', tempo: SLOW_TEMPO, duration: +probeDuration(b2).toFixed(1) };
      console.log(`  [B2] slowed to ${SLOW_TEMPO}: ${metrics.variants.B2.duration}s`);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — spoken chars ${total} (≈ ${Math.round(total * 0.587)} v2-rate credits; v4 bills ~0.475/char). Nothing spent.`);
    return;
  }

  try {
    const [prev] = await bucket.file(`${gcsDir}/metrics.json`).download();
    metrics.variants = { ...JSON.parse(prev.toString()).variants, ...metrics.variants };
  } catch { /* first run */ }
  const mPath = join(tmpDir, 'metrics.json');
  writeFileSync(mPath, JSON.stringify(metrics, null, 2));
  await bucket.upload(mPath, { destination: `${gcsDir}/metrics.json` });

  const fmt = s => s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '';
  const present = [];
  for (const key of ['A', 'B', 'B2']) {
    const v = CONFIGS[key];
    if (!VARIANTS.includes(key) || !(await exists(v.file))) continue;
    const d = metrics.variants[key]?.duration;
    present.push({ name: v.name, accent: d ? fmt(d) : '', blurb: v.blurb, file: v.file });
  }
  const manifest = { slug: SLUG, title: TITLE, translation: SUBTITLE, blocks: displayBlocks(md), voices: present };
  const manPath = join(tmpDir, 'manifest.json');
  writeFileSync(manPath, JSON.stringify(manifest, null, 2));
  await bucket.upload(manPath, { destination: `${gcsDir}/manifest.json` });

  const creditsAfter = await getCredits();
  const used = creditsBefore && creditsAfter ? creditsBefore.remaining - creditsAfter.remaining : null;
  console.log(`\nPublished gs://${GCS_BUCKET}/${gcsDir}/ (${present.map(p => p.name.split(' ')[0]).join(', ')})`);
  console.log(`Spoken chars ${total}` + (used != null ? `  | measured: ${used} credits` : ''));
}

main().catch(err => { console.error('series-ab failed:', err); process.exit(1); });
