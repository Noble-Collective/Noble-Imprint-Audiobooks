/**
 * voice-compare.js — Generate one full audio sample of a passage in several
 * voices and publish them to GCS for side-by-side comparison on the website.
 *
 * Unlike voice-test.js (which takes snippets of a series/ book and emits GitHub
 * artifacts), this reads a standalone sample markdown file, renders the WHOLE
 * passage in each voice, uploads the MP3s + a manifest to GCS, and the resource
 * website serves them at /voice-test.
 *
 * Env:
 *   ELEVENLABS_API_KEY  (required)
 *   GCS_BUCKET          (default: noble-imprint-audiobooks)
 *   SAMPLE_FILE         (default: samples/psalm-1-2.md)
 *   SLUG                (default: psalm-1-2)   → GCS prefix voice-test/{SLUG}/
 *   TITLE               (default: "Psalm 1 & 2")
 *   DRY_RUN             ("true" = preprocess + resolve voices, no TTS/upload/spend)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { preprocessSession } from './preprocess-tts.js';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const SAMPLE_FILE = process.env.SAMPLE_FILE || 'samples/psalm-1-2.md';
const SLUG = process.env.SLUG || 'psalm-1-2';
const TITLE = process.env.TITLE || 'Psalm 1 & 2';
const DRY_RUN = process.env.DRY_RUN === 'true';
// By default, skip voices whose MP3 already exists in GCS so re-runs only spend
// on newly-added voices. FORCE=true regenerates every voice in the slate.
const FORCE = process.env.FORCE === 'true';

// Scripture read profile — a hair slower than prose (0.90 vs 0.92).
const VOICE_SETTINGS = { stability: 0.71, similarity_boost: 0.5, style: 0.0, speed: 0.90 };
const MODEL_ID = 'eleven_multilingual_v2';

// The comparison slate. Premade voices carry a known id (always usable). Library
// voices are resolved by name (workspace first, then shared library, adding to
// the workspace if needed).
const VOICES = [
  { name: 'George',         id: 'JBFqnCBsd6RMkjVDRZzb', accent: 'British',  blurb: 'Warm, calm, pastoral' },
  { name: 'Brian',          id: 'nPczCjzI2devNBz1zQrb', accent: 'American', blurb: 'Deep, resonant — classic audio-Bible' },
  { name: 'Daniel',         id: 'onwK4e9ZLuTAKqWW03F9', accent: 'British',  blurb: 'Authoritative, broadcast gravitas' },
  { name: 'Bill L. Oxley',  id: null,                   accent: 'American', blurb: 'Mature, sophisticated literary narrator' },
  { name: 'Matthew Schmitz', id: null,                  accent: 'American', blurb: 'Scripture / religious-reading specialist' },
  // Middle Eastern (Arabic-native) narrators reading the English text — accented
  // delivery for an authentic setting. Judge English intelligibility too.
  { name: 'Ali',            id: 'MI88rOZjXbH22N8KHXUo', accent: 'Middle Eastern', blurb: 'Calm, deep Arabic (Saudi) narrator' },
  { name: 'Marco Nady',     id: null,                   accent: 'Middle Eastern', blurb: 'Confident, calm, deep, warm' },
  { name: 'Haytham',        id: null,                   accent: 'Middle Eastern', blurb: 'Warm, expressive Arab male' },
  // Broader Middle East / Hebrew spread (all reading the English text).
  { name: 'Hebrew (Israeli)', id: null, accent: 'Hebrew',   blurb: 'Native Israeli / Hebrew accent',
    query: { gender: 'male', language: 'he' }, searchFallback: ['Hebrew', 'Israeli'] },
  { name: 'Persian (Farsi)', id: null, accent: 'Persian',   blurb: 'Persian / Farsi accent',
    query: { gender: 'male', language: 'fa' }, searchFallback: ['Persian', 'Farsi', 'Amir'] },
  { name: 'Ali Alpagu',     id: null,                   accent: 'Turkish',  blurb: 'Turkish — mature, wise, authoritative' },
  { name: 'Mamdoh',         id: null,                   accent: 'Egyptian', blurb: 'Egyptian — deep, clear' },
  { name: 'Fadi',           id: null,                   accent: 'Lebanese', blurb: 'Lebanese / Levantine — natural, close' },
];

function slugifyVoice(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function el(pathAndQuery, opts = {}) {
  const res = await fetch(`https://api.elevenlabs.io${pathAndQuery}`, {
    ...opts,
    headers: { 'xi-api-key': API_KEY, ...(opts.headers || {}) },
  });
  return res;
}

// Workspace name prefix for voices we add, so repeat runs find and reuse them
// instead of adding duplicates.
const WS_PREFIX = 'vt:';

async function workspaceVoices() {
  const r = await el('/v1/voices');
  return r.ok ? ((await r.json()).voices || []) : [];
}

// Resolve a voice to a usable voice_id. Order: explicit id → already in
// workspace → shared library (by name, or by accent/language query), added to
// the workspace so TTS can address it. Idempotent across runs.
async function resolveVoice(v) {
  if (v.id) return { ...v, resolvedId: v.id, source: 'premade' };

  const stableName = `${WS_PREFIX} ${v.name}`;
  const ws = await workspaceVoices();
  const existing = ws.find(x => x.name === stableName)                       // added by us before
    || ws.find(x => x.name.toLowerCase() === v.name.toLowerCase());          // legacy add / premade name
  if (existing) return { ...v, resolvedId: existing.voice_id, source: 'workspace' };

  // Find a candidate in the shared library.
  let cand;
  if (v.query) {
    const qs = new URLSearchParams({ page_size: '30', ...v.query }).toString();
    const sr = await el(`/v1/shared-voices?${qs}`);
    if (!sr.ok) throw new Error(`shared-voices query failed for "${v.name}" (${sr.status})`);
    let list = (await sr.json()).voices || [];
    // Fallback: some accents don't surface via the language filter — retry as
    // keyword search(es), stopping at the first that returns results.
    if (!list.length && v.searchFallback) {
      for (const term of [].concat(v.searchFallback)) {
        const fr = await el(`/v1/shared-voices?page_size=30&gender=male&search=${encodeURIComponent(term)}`);
        if (fr.ok) list = (await fr.json()).voices || [];
        if (list.length) break;
      }
    }
    // Prefer a male narration/storytelling voice when several match.
    cand = list.find(x => /narrat|story/i.test(JSON.stringify(x.labels || {})))
        || list.find(x => (x.labels || {}).gender === 'male')
        || list[0];
  } else {
    const sr = await el(`/v1/shared-voices?page_size=20&search=${encodeURIComponent(v.name)}`);
    if (!sr.ok) throw new Error(`shared-voices search failed for "${v.name}" (${sr.status})`);
    const list = (await sr.json()).voices || [];
    cand = list.find(x => x.name.toLowerCase() === v.name.toLowerCase()) || list[0];
  }
  if (!cand) throw new Error(`No library voice matched "${v.name}"`);

  // Add to workspace under our stable name so TTS can address it.
  const addRes = await el(`/v1/voices/add/${cand.public_owner_id}/${cand.voice_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_name: stableName }),
  });
  if (!addRes.ok) throw new Error(`Failed to add "${v.name}" (${addRes.status}): ${await addRes.text()}`);
  const added = await addRes.json();
  return { ...v, resolvedId: added.voice_id || cand.voice_id, source: `added:${cand.name}`, accent: v.accent };
}

async function generate(text, voiceId) {
  const res = await el(`/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS }),
  });
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// Parse the sample markdown into lightweight display blocks for the web page.
// Verse numbers stay as <sup> (visible on screen, already silent in the audio).
function displayBlocks(markdown) {
  const blocks = [];
  for (const raw of markdown.split(/\n{2,}/)) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('## ')) blocks.push({ type: 'h2', text: t.slice(3).trim() });
    else if (t.startsWith('# ')) blocks.push({ type: 'h1', text: t.slice(2).trim() });
    else blocks.push({ type: 'p', text: t.replace(/\n/g, ' ') });
  }
  return blocks;
}

async function main() {
  if (!API_KEY) { console.error('Set ELEVENLABS_API_KEY'); process.exit(1); }

  const markdown = readFileSync(SAMPLE_FILE, 'utf-8');
  const chapter = preprocessSession(markdown, 'compare');
  const spoken = chapter.plainText;

  console.log(`Sample: ${SAMPLE_FILE}  (slug: ${SLUG})`);
  console.log(`Spoken characters: ${spoken.length}\n`);
  console.log('--- Spoken text (SSML break tags create the heading pauses) ---');
  console.log(spoken);
  console.log('---------------------------------------------------------------\n');

  mkdirSync('voice-compare-output', { recursive: true });
  const storage = new Storage();
  const bucket = storage.bucket(GCS_BUCKET);
  const gcsDir = `voice-test/${SLUG}`;

  // Load the existing manifest so already-published voices are reused verbatim —
  // no re-resolving, no duplicate workspace adds, no re-spend.
  const existingByFile = {};
  try {
    const [buf] = await bucket.file(`${gcsDir}/manifest.json`).download();
    for (const e of (JSON.parse(buf.toString()).voices || [])) existingByFile[e.file] = e;
  } catch { /* no manifest yet */ }

  // Plan: decide per voice whether to reuse or (re)generate. Only new voices are
  // resolved/added. A resolve failure skips that voice instead of aborting.
  console.log('Planning voices...');
  const plan = [];
  for (const v of VOICES) {
    const file = `${slugifyVoice(v.name)}.mp3`;
    const [exists] = await bucket.file(`${gcsDir}/${file}`).exists();
    if (exists && !FORCE) {
      const prior = existingByFile[file] || { name: v.name, accent: v.accent, blurb: v.blurb, file };
      plan.push({ entry: prior, generate: false });
      console.log(`  ${v.name.padEnd(18)} reuse (already published)`);
      continue;
    }
    let r;
    try { r = await resolveVoice(v); }
    catch (err) { console.error(`  ${v.name.padEnd(18)} SKIP — ${err.message}`); continue; }
    console.log(`  ${v.name.padEnd(18)} ${r.resolvedId}  (${r.source}, ${r.accent})`);
    plan.push({
      entry: { name: v.name, accent: v.accent, blurb: v.blurb, voiceId: r.resolvedId, file },
      generate: true, resolvedId: r.resolvedId,
    });
  }

  const nGen = plan.filter(p => p.generate).length;
  console.log(`\n${nGen} to generate  ≈  ${nGen * spoken.length} credits  ≈  $${(nGen * spoken.length / 10000 * 1.65).toFixed(2)}`);

  if (DRY_RUN) {
    console.log('\nDRY_RUN — stopping before any TTS generation or upload.');
    return;
  }

  const manifestVoices = [];
  for (const p of plan) {
    if (!p.generate) { manifestVoices.push(p.entry); continue; }
    const localPath = `voice-compare-output/${p.entry.file}`;
    console.log(`\nGenerating ${p.entry.name}...`);
    const buf = await generate(spoken, p.resolvedId);
    writeFileSync(localPath, buf);
    console.log(`  ${(buf.length / 1024).toFixed(0)} KB`);
    await bucket.upload(localPath, { destination: `${gcsDir}/${p.entry.file}` });
    console.log(`  Uploaded gs://${GCS_BUCKET}/${gcsDir}/${p.entry.file}`);
    manifestVoices.push(p.entry);
    await new Promise(r => setTimeout(r, 400));
  }

  const manifest = {
    slug: SLUG,
    title: TITLE,
    translation: 'Berean Standard Bible',
    spokenChars: spoken.length,
    blocks: displayBlocks(markdown),
    voices: manifestVoices,
  };
  const manifestPath = 'voice-compare-output/manifest.json';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await bucket.upload(manifestPath, { destination: `${gcsDir}/manifest.json` });
  console.log(`\nUploaded manifest gs://${GCS_BUCKET}/${gcsDir}/manifest.json`);
  console.log(`Done. ${manifestVoices.length} voices published under ${gcsDir}/`);
}

main().catch(err => { console.error('voice-compare failed:', err); process.exit(1); });
