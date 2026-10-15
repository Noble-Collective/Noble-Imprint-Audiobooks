/**
 * model-ab.js — whole-chapter A/B of the Bible narration, published for listening at
 * /voice-test/{slug} (no website change: the voice-compare manifest shape).
 *
 * Versions of each chapter:
 *   A  — the LIVE audio as shipped (copied from audio/bible/…, 0 credits)
 *   B  — today's model (eleven_multilingual_v2, same voice + settings) with the text fixes
 *   C  — eleven_v4, same voice, same text fixes, v4 pause tags, at v4's natural pace
 *   C2 — C slowed to 0.90 after rendering (v4 has no speed setting; ffmpeg atempo,
 *        pitch-preserving, timestamps scaled to match) — 0 credits
 * B vs A = what the text fixes are worth; B vs C = the model difference on identical text.
 *
 * Text fixes (narrationOptions, all opt-in): spell_numbers, clean_terminal_punctuation, and
 * the pause style for the model (pauses.js).
 *
 * Everything goes through the REAL production functions (preprocessSession →
 * buildNaturalGenerations → generateWithRetry → concatenateChunks → normalizeLoudness →
 * buildTimestampsFromAlignments, incl. its validation guard). Whole chapters on purpose: at
 * stability 0.50 short excerpts pace differently from production-size generations
 * (plans/2026-08-12-poetry-couplet-fix.md).
 *
 * Writes only under GCS voice-test/{slug}/. Also writes metrics.json there (duration,
 * per-generation pacing, timestamp coverage, credits) for the write-up.
 *
 * Env:
 *   ELEVENLABS_API_KEY (unless DRY_RUN)   RESOURCES_PATH (default ../Noble-Imprint-Resources)
 *   CHAPTERS   "NUM:1,ACT:27"             VARIANTS "B,C" (A and C2 are free, always made)
 *   DRY_RUN=true  print the spoken text of every version, no TTS/upload
 *   FORCE=true    re-render variants whose MP3 already exists in GCS
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';
import { parseUsfmBook, chapterToMarkdown, findBookFile } from './usfm-to-markdown.js';
import { preprocessSession, narrationOptions } from './preprocess-tts.js';
import {
  buildNaturalGenerations, generateWithRetry, concatenateChunks, normalizeLoudness,
  buildTimestampsFromAlignments, serializeTimestamps, getCredits,
} from './generate.js';
import { stripPauses } from './pauses.js';

const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';
const TX = 'bsb';
const CHAPTERS = (process.env.CHAPTERS || 'NUM:1,ACT:27').split(',').map(s => {
  const [code, ch] = s.trim().split(':');
  return { code: code.toUpperCase(), ch: parseInt(ch, 10) };
});
const VARIANTS = (process.env.VARIANTS || 'B,C').split(',').map(s => s.trim().toUpperCase());
const SLOW_TEMPO = 0.9;   // C2: the Bible's v2 speed setting, applied after rendering

const FIXES = { spell_numbers: true, clean_terminal_punctuation: true };

// The two rendered versions. Voice + v2 settings come from the live BSB config.
function variantConfigs(ab) {
  return {
    B: {
      file: 'b-v2-fixed.mp3', model: ab.model_id || 'eleven_multilingual_v2',
      settings: ab.voice_settings,
      opts: narrationOptions({ ...FIXES, model_id: ab.model_id }),
      name: 'B — today’s model, text fixed',
      blurb: 'Same model, voice and settings as the live Bible (multilingual v2), with the three fixes: numbers read as words, no stray periods, named pauses.',
    },
    C: {
      file: 'c-v4.mp3', model: 'eleven_v4',
      // v4 takes only stability + similarity (speed/style are accepted but ignored — v4 probe).
      settings: { stability: ab.voice_settings?.stability ?? 0.5, similarity_boost: ab.voice_settings?.similarity_boost ?? 0.5 },
      opts: narrationOptions({ ...FIXES, model_id: 'eleven_v4' }),
      name: 'C — Eleven v4, natural pace',
      blurb: 'The new v4 model, same voice and the same text fixes. Pauses use v4’s [long pause]/[short pause] tags. v4 has no speed setting, so this is its natural pace.',
    },
  };
}

const slugify = s => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const probeDuration = p => parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: 'utf-8' }).trim());

// Articulation rate (letters/s, per-letter time capped at 0.22s so pauses don't count) over
// each fifth of a generation — the within-generation slowdown shows as a falling sequence.
function pacing(alignment) {
  if (!alignment) return null;
  const ch = alignment.characters, st = alignment.character_start_times_seconds, en = alignment.character_end_times_seconds;
  const text = ch.join('');
  const markup = new Array(ch.length).fill(false);
  for (const m of text.matchAll(/<break[^>]*\/>|\[(?:short |long )?pause\]/g)) for (let i = m.index; i < m.index + m[0].length; i++) markup[i] = true;
  const durs = [];
  for (let i = 0; i < ch.length; i++) if (!markup[i] && /\p{L}/u.test(ch[i])) durs.push(Math.min(en[i] - st[i], 0.22));
  const fifths = [];
  for (let k = 0; k < 5; k++) {
    const sl = durs.slice(Math.floor(k * durs.length / 5), Math.floor((k + 1) * durs.length / 5));
    fifths.push(+(sl.length / sl.reduce((a, b) => a + b, 0)).toFixed(1));
  }
  return { overall: +(durs.length / durs.reduce((a, b) => a + b, 0)).toFixed(1), fifths };
}

async function renderVariant(md, ab, v, outPath, tmpDir, tag) {
  const pre = preprocessSession(md, ab.voice_id, 'en', ab.language_normalization === true, v.opts);
  const gen = buildNaturalGenerations(pre.blocks, ab.max_generation || 2000, v.opts.pauseStyle);
  const spokenChars = stripPauses(gen.texts.join('')).length;
  console.log(`  [${tag}] ${v.model}  generations=${gen.texts.length} (${gen.texts.map(t => t.length).join('/')})  gaps=[${gen.gaps.join(',')}]  spokenChars=${spokenChars}`);
  if (DRY_RUN) {
    gen.texts.forEach((t, i) => console.log(`\n  ----- [${tag}] generation ${i + 1} -----\n${t}`));
    return { spokenChars };
  }
  const chunkPaths = [], aligns = [], requestIds = [];
  for (let i = 0; i < gen.texts.length; i++) {
    const prevText = gen.continuations[i] ? gen.texts[i - 1].slice(-200) : undefined;
    const nextText = gen.continuations[i + 1] ? gen.texts[i + 1].slice(0, 200) : undefined;
    const r = await generateWithRetry(gen.texts[i], ab.voice_id, v.model, v.settings, 'mp3_44100_128',
      prevText, nextText, requestIds.slice());
    if (r.requestId) requestIds.push(r.requestId);
    const cp = join(tmpDir, `${tag}_${i}.mp3`);
    writeFileSync(cp, r.audio);
    chunkPaths.push(cp);
    aligns.push(r.alignment);
  }
  const gaps = concatenateChunks(chunkPaths, outPath, tmpDir, gen.gaps);
  normalizeLoudness(outPath);
  const stats = { matched: 0, estimated: 0 };
  const ts = buildTimestampsFromAlignments(aligns, gen.texts, chunkPaths.map(probeDuration), pre.sentences, gaps, { stats, words: true });
  return {
    spokenChars, stats, ts,
    duration: +probeDuration(outPath).toFixed(1),
    pacing: aligns.map(pacing),
    alignmentConsistent: aligns.map((a, i) => !!a && a.characters.length === gen.texts[i].length),
  };
}

function slowDown(inPath, outPath, ts) {
  execSync(`ffmpeg -hide_banner -i "${inPath}" -af atempo=${SLOW_TEMPO} -b:a 128k "${outPath}" -y`, { stdio: 'pipe' });
  const k = 1 / SLOW_TEMPO, r = t => Math.round(t * k * 100) / 100;
  return { segments: ts.segments.map(s => ({ ...s, start: r(s.start), end: r(s.end),
    ...(s.words ? { words: s.words.map(([a, b, w]) => [r(a), r(b), w]) } : {}) })) };
}

function displayBlocks(bookName, ch, blocks) {
  const note = '<span style="display:block;font-size:0.85rem;opacity:0.8;font-family:\'DM Sans\',sans-serif;' +
    'padding:0.55rem 0.8rem;background:rgba(200,160,74,0.10);border-left:3px solid #c8a04a;border-radius:0 5px 5px 0;">' +
    '<b>A</b> is the audio live today. <b>B</b> is the same model with the text fixes. <b>C</b> is Eleven v4 with the same fixes; ' +
    '<b>C2</b> is C slowed to the Bible’s usual 0.90 pace. Listen for the large numbers, the slowing toward the end of long sections, and the pauses at headings.</span>';
  const out = [{ type: 'h1', text: `${bookName} ${ch}` }, { type: 'p', text: note }];
  for (const b of blocks) out.push({ type: b.type === 'p' ? 'p' : 'h2', text: b.text });
  return out;
}

async function main() {
  if (!DRY_RUN && !process.env.ELEVENLABS_API_KEY) { console.error('Set ELEVENLABS_API_KEY (or DRY_RUN=true)'); process.exit(1); }
  const meta = JSON.parse(readFileSync(join(RESOURCES_PATH, 'bibles', TX, 'meta.json'), 'utf-8'));
  const ab = meta.audiobook;
  const configs = variantConfigs(ab);
  console.log(`Voice ${ab.voice_id}  live model ${ab.model_id}  settings ${JSON.stringify(ab.voice_settings)}  DRY_RUN=${DRY_RUN}`);
  const bucket = DRY_RUN ? null : new Storage().bucket(GCS_BUCKET);
  const creditsBefore = DRY_RUN ? null : await getCredits();
  let total = 0;

  for (const { code, ch } of CHAPTERS) {
    const usfm = readFileSync(findBookFile(join(RESOURCES_PATH, 'bibles', TX, 'content'), TX, code), 'utf-8');
    const parsed = parseUsfmBook(usfm);
    const chap = parsed.chapters.find(c => c.num === ch);
    if (!chap) throw new Error(`${code} ${ch} not found`);
    const md = chapterToMarkdown(parsed.bookName, chap);
    const bookSlug = slugify(parsed.bookName);
    const slug = `ab-${bookSlug}-${ch}`;
    const gcsDir = `voice-test/${slug}`;
    const nnn = String(ch).padStart(3, '0');
    const tmpDir = join('model-ab-output', slug);
    mkdirSync(tmpDir, { recursive: true });
    console.log(`\n=== ${parsed.bookName} ${ch} → /voice-test/${slug} ===`);

    const metrics = { chapter: `${parsed.bookName} ${ch}`, generatedAt: new Date().toISOString(), variants: {} };
    const exists = async f => !DRY_RUN && (await bucket.file(`${gcsDir}/${f}`).exists())[0];

    // A — the live chapter, copied as-is.
    if (!DRY_RUN && (FORCE || !(await exists('a-live.mp3')))) {
      await bucket.file(`audio/bible/${TX}/${bookSlug}/${nnn}.mp3`).copy(bucket.file(`${gcsDir}/a-live.mp3`));
      console.log('  [A] copied live audio');
    }

    for (const key of VARIANTS) {
      const v = configs[key];
      if (!v) throw new Error(`unknown variant ${key}`);
      if (!FORCE && await exists(v.file)) { console.log(`  [${key}] exists — skipped (FORCE=true to re-render)`); continue; }
      const outPath = join(tmpDir, v.file);
      const r = await renderVariant(md, ab, v, outPath, tmpDir, key);
      total += r.spokenChars;
      if (DRY_RUN) continue;
      console.log(`  [${key}] ${r.duration}s  timestamps matched ${r.stats.matched}/${r.stats.matched + r.stats.estimated}  pacing ${JSON.stringify(r.pacing.map(p => p && p.fifths))}`);
      metrics.variants[key] = { model: v.model, settings: v.settings, duration: r.duration, spokenChars: r.spokenChars,
        timestamps: r.stats, pacing: r.pacing, alignmentConsistent: r.alignmentConsistent };
      await bucket.upload(outPath, { destination: `${gcsDir}/${v.file}` });
      const tsPath = join(tmpDir, v.file.replace('.mp3', '.timestamps.json'));
      writeFileSync(tsPath, serializeTimestamps(r.ts));
      await bucket.upload(tsPath, { destination: `${gcsDir}/${v.file.replace('.mp3', '.timestamps.json')}` });
      if (key === 'C') {
        const c2 = join(tmpDir, 'c2-v4-slowed.mp3');
        const ts2 = slowDown(outPath, c2, r.ts);
        await bucket.upload(c2, { destination: `${gcsDir}/c2-v4-slowed.mp3` });
        const ts2Path = join(tmpDir, 'c2-v4-slowed.timestamps.json');
        writeFileSync(ts2Path, serializeTimestamps(ts2));
        await bucket.upload(ts2Path, { destination: `${gcsDir}/c2-v4-slowed.timestamps.json` });
        metrics.variants.C2 = { derivedFrom: 'C', tempo: SLOW_TEMPO, duration: +probeDuration(c2).toFixed(1) };
        console.log(`  [C2] slowed to ${SLOW_TEMPO}: ${metrics.variants.C2.duration}s`);
      }
    }
    if (DRY_RUN) continue;

    // Merge with any metrics from an earlier run (variants skipped this time keep theirs).
    try {
      const [prev] = await bucket.file(`${gcsDir}/metrics.json`).download();
      const old = JSON.parse(prev.toString());
      metrics.variants = { ...old.variants, ...metrics.variants };
    } catch { /* first run */ }
    metrics.variants.A = { live: `audio/bible/${TX}/${bookSlug}/${nnn}.mp3` };
    const mPath = join(tmpDir, 'metrics.json');
    writeFileSync(mPath, JSON.stringify(metrics, null, 2));
    await bucket.upload(mPath, { destination: `${gcsDir}/metrics.json` });

    const voices = [
      { name: 'A — live today', accent: 'A', blurb: 'The audio currently published (multilingual v2, digits read as written).', file: 'a-live.mp3' },
      { name: configs.B.name, accent: 'B', blurb: configs.B.blurb, file: configs.B.file },
      { name: configs.C.name, accent: 'C', blurb: configs.C.blurb, file: configs.C.file },
      { name: 'C2 — Eleven v4, slowed to 0.90', accent: 'C2', blurb: 'C slowed after rendering to the Bible’s usual 0.90 pace (v4 has no speed setting; pitch is preserved).', file: 'c2-v4-slowed.mp3' },
    ];
    const present = [];
    for (const vv of voices) if ((await bucket.file(`${gcsDir}/${vv.file}`).exists())[0]) present.push(vv);
    const manifest = { slug, title: `${parsed.bookName} ${ch} — narration A/B`, translation: 'Berean Standard Bible',
      blocks: displayBlocks(parsed.bookName, ch, chap.blocks), voices: present };
    const manPath = join(tmpDir, 'manifest.json');
    writeFileSync(manPath, JSON.stringify(manifest, null, 2));
    await bucket.upload(manPath, { destination: `${gcsDir}/manifest.json` });
    console.log(`  published gs://${GCS_BUCKET}/${gcsDir}/ (${present.map(p => p.accent).join(', ')})`);
  }

  const creditsAfter = DRY_RUN ? null : await getCredits();
  const used = creditsBefore && creditsAfter ? creditsBefore.remaining - creditsAfter.remaining : null;
  console.log(`\nDone. spoken chars ${total}  ≈ ${Math.round(total * 0.587)} billed credits at our ~0.587 rate (≈ $${(total * 0.587 / 10000 * 1.65).toFixed(2)})` +
    (used != null ? `  | measured: ${used} credits` : '') + (DRY_RUN ? '  (DRY_RUN — nothing spent)' : ''));
}

main().catch(err => { console.error('model-ab failed:', err); process.exit(1); });
