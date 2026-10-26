/**
 * accent-exp.js — accent-drift experiment for the Bible narration on Eleven v4.
 *
 * Eleven v4 doesn't carry a voice's accent into another language ("Ali" is an Arabic-language
 * library voice reading English), and it decides per request: some sections come out in a
 * North American voice (plans/2026-10-26-accent-drift.md). This renders a few sections that
 * drifted in the live audio several times each under different settings, so the takes can be
 * scored (scripts/accent-check/score.py) and listened to.
 *
 * A section = one production generation (buildNaturalGenerations, same text, same pause tags,
 * no request stitching = how the first section of every chapter is made). Writes ONLY to the
 * local OUT_DIR (the workflow uploads it as an Actions artifact). Nothing goes to GCS.
 *
 * Env:
 *   ELEVENLABS_API_KEY (unless DRY_RUN)   RESOURCES_PATH (default ../Noble-Imprint-Resources)
 *   SECTIONS  "COL:3:1,PSA:24:1"  BOOK:chapter:generation (1-based)
 *   VARIANTS  "base,sim,tag,tagsim,stabsim"  (see VARIANT_DEFS)
 *   TAKES     3        renders per section × variant
 *   ACCENT_TAG "[Saudi Arabic accent]"
 *   OUT_DIR   accent-exp-output
 *   DRY_RUN=true  print each section's text + the planned spend, no TTS
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseUsfmBook, chapterToMarkdown, findBookFile } from './usfm-to-markdown.js';
import { preprocessSession, narrationOptions } from './preprocess-tts.js';
import { buildNaturalGenerations, generateWithRetry, getCredits } from './generate.js';
import { stripPauses } from './pauses.js';

const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const OUT_DIR = process.env.OUT_DIR || 'accent-exp-output';
const DRY_RUN = process.env.DRY_RUN === 'true';
const TAKES = parseInt(process.env.TAKES || '3', 10);
const ACCENT_TAG = process.env.ACCENT_TAG || '[Saudi Arabic accent]';
const SECTIONS = (process.env.SECTIONS || 'COL:3:1').split(',').map(s => {
  const [code, ch, gen] = s.trim().split(':');
  return { code: code.toUpperCase(), ch: parseInt(ch, 10), gen: parseInt(gen || '1', 10) };
});
const VARIANTS = (process.env.VARIANTS || 'base,sim,tag,tagsim,stabsim').split(',').map(s => s.trim());

// Live BSB settings: stability 0.50, similarity_boost 0.5.
const VARIANT_DEFS = {
  base:    { label: 'Live settings',                     settings: { stability: 0.5,  similarity_boost: 0.5 }, tag: false },
  sim:     { label: 'Similarity 0.9',                    settings: { stability: 0.5,  similarity_boost: 0.9 }, tag: false },
  tag:     { label: 'Accent tag',                        settings: { stability: 0.5,  similarity_boost: 0.5 }, tag: true },
  tagsim:  { label: 'Accent tag + similarity 0.9',       settings: { stability: 0.5,  similarity_boost: 0.9 }, tag: true },
  stabsim: { label: 'Stability 0.75 + similarity 0.9',   settings: { stability: 0.75, similarity_boost: 0.9 }, tag: false },
};

// Seconds the model spent on the tag's own characters (≈0 = not spoken aloud).
function tagSeconds(alignment, tagLen) {
  if (!alignment || !tagLen) return null;
  const s = alignment.character_start_times_seconds, e = alignment.character_end_times_seconds;
  return +(e[tagLen - 1] - s[0]).toFixed(2);
}

async function main() {
  if (!DRY_RUN && !process.env.ELEVENLABS_API_KEY) { console.error('Set ELEVENLABS_API_KEY (or DRY_RUN=true)'); process.exit(1); }
  for (const v of VARIANTS) if (!VARIANT_DEFS[v]) throw new Error(`unknown variant ${v}`);
  const meta = JSON.parse(readFileSync(join(RESOURCES_PATH, 'bibles', 'bsb', 'meta.json'), 'utf-8'));
  const ab = meta.audiobook;
  const opts = narrationOptions(ab);
  mkdirSync(OUT_DIR, { recursive: true });

  const sections = SECTIONS.map(({ code, ch, gen }) => {
    const parsed = parseUsfmBook(readFileSync(findBookFile(join(RESOURCES_PATH, 'bibles', 'bsb', 'content'), 'bsb', code), 'utf-8'));
    const chap = parsed.chapters.find(c => c.num === ch);
    if (!chap) throw new Error(`${code} ${ch} not found`);
    const pre = preprocessSession(chapterToMarkdown(parsed.bookName, chap), ab.voice_id, 'en', ab.language_normalization === true, opts);
    const g = buildNaturalGenerations(pre.blocks, ab.max_generation || 2000, opts.pauseStyle);
    const text = g.texts[gen - 1];
    if (!text) throw new Error(`${code} ${ch}: no generation ${gen} (has ${g.texts.length})`);
    return { id: `${code}${ch}-g${gen}`, ref: `${parsed.bookName} ${ch}`, gen, of: g.texts.length, text };
  });

  const spoken = sections.reduce((n, s) => n + stripPauses(s.text).length, 0) * VARIANTS.length * TAKES;
  console.log(`Voice ${ab.voice_id}  model ${ab.model_id}  takes ${TAKES}  variants ${VARIANTS.join(',')}  tag "${ACCENT_TAG}"`);
  for (const s of sections) console.log(`\n--- ${s.id} (${s.ref}, generation ${s.gen} of ${s.of}, ${s.text.length} chars) ---\n${DRY_RUN ? s.text : s.text.slice(0, 160) + '…'}`);
  console.log(`\nPlanned: ${sections.length} sections × ${VARIANTS.length} variants × ${TAKES} takes = ${spoken} spoken chars ≈ ${Math.round(spoken * 0.475)} credits (v4 ~0.475/char) ≈ $${(spoken * 0.475 / 10000 * 1.65).toFixed(2)}`);
  if (DRY_RUN) return;

  const before = await getCredits();
  const runs = [];
  for (const s of sections) {
    for (const vk of VARIANTS) {
      const v = VARIANT_DEFS[vk];
      const prefix = v.tag ? `${ACCENT_TAG} ` : '';
      for (let t = 1; t <= TAKES; t++) {
        const file = `${s.id}__${vk}__t${t}.mp3`;
        const r = await generateWithRetry(prefix + s.text, ab.voice_id, ab.model_id, v.settings, 'mp3_44100_128');
        writeFileSync(join(OUT_DIR, file), r.audio);
        const row = { file, section: s.id, ref: s.ref, variant: vk, label: v.label, take: t, settings: v.settings,
          tag: v.tag ? ACCENT_TAG : null, tagSeconds: tagSeconds(r.alignment, prefix.length), requestId: r.requestId || null };
        runs.push(row);
        console.log(`  ${file}${row.tagSeconds != null ? `  tag ${row.tagSeconds}s` : ''}`);
      }
    }
  }
  const after = await getCredits();
  const used = before && after ? before.remaining - after.remaining : null;
  writeFileSync(join(OUT_DIR, 'runs.json'), JSON.stringify({ accentTag: ACCENT_TAG, model: ab.model_id, voice: ab.voice_id,
    sections: sections.map(({ text, ...s }) => ({ ...s, text })), runs, creditsUsed: used }, null, 2));
  console.log(`\nDone. ${runs.length} takes, credits used ${used ?? 'unknown'}`);
}

main().catch(err => { console.error('accent-exp failed:', err); process.exit(1); });
