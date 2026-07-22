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

// Resolve a voice name to a usable voice_id, adding it to the workspace if it
// only exists in the shared library.
async function resolveVoice(v) {
  if (v.id) return { ...v, resolvedId: v.id, source: 'premade' };

  // 1) Workspace (already added) — matches premade + previously added library voices.
  const wsRes = await el('/v1/voices');
  if (wsRes.ok) {
    const ws = await wsRes.json();
    const match = (ws.voices || []).find(x => x.name.toLowerCase() === v.name.toLowerCase())
      || (ws.voices || []).find(x => x.name.toLowerCase().includes(v.name.toLowerCase()));
    if (match) return { ...v, resolvedId: match.voice_id, source: 'workspace' };
  }

  // 2) Shared library search.
  const sr = await el(`/v1/shared-voices?page_size=20&search=${encodeURIComponent(v.name)}`);
  if (!sr.ok) throw new Error(`shared-voices search failed for "${v.name}" (${sr.status})`);
  const shared = (await sr.json()).voices || [];
  const hit = shared.find(x => x.name.toLowerCase() === v.name.toLowerCase()) || shared[0];
  if (!hit) throw new Error(`Voice not found in library: "${v.name}"`);

  // 3) Add to workspace so TTS can address it.
  const addRes = await el(`/v1/voices/add/${hit.public_owner_id}/${hit.voice_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_name: hit.name }),
  });
  if (!addRes.ok) throw new Error(`Failed to add "${v.name}" to workspace (${addRes.status}): ${await addRes.text()}`);
  const added = await addRes.json();
  return { ...v, resolvedId: added.voice_id || hit.voice_id, source: 'library-added',
           accent: v.accent || hit.labels?.accent };
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
  console.log(`Spoken characters: ${spoken.length}  ×  ${VOICES.length} voices  =  ${spoken.length * VOICES.length} credits`);
  console.log(`Est. cost: $${((spoken.length * VOICES.length) / 10000 * 1.65).toFixed(2)}\n`);
  console.log('--- Spoken text (SSML break tags create the heading pauses) ---');
  console.log(spoken);
  console.log('---------------------------------------------------------------\n');

  console.log('Resolving voices...');
  const resolved = [];
  for (const v of VOICES) {
    const r = await resolveVoice(v);
    console.log(`  ${r.name.padEnd(16)} ${r.resolvedId}  (${r.source}, ${r.accent})`);
    resolved.push(r);
  }

  if (DRY_RUN) {
    console.log('\nDRY_RUN — stopping before any TTS generation or upload.');
    return;
  }

  mkdirSync('voice-compare-output', { recursive: true });
  const storage = new Storage();
  const bucket = storage.bucket(GCS_BUCKET);
  const gcsDir = `voice-test/${SLUG}`;

  const manifestVoices = [];
  for (const v of resolved) {
    const fileSlug = slugifyVoice(v.name);
    const dest = `${gcsDir}/${fileSlug}.mp3`;
    const manifestEntry = {
      name: v.name, accent: v.accent, blurb: v.blurb,
      voiceId: v.resolvedId, file: `${fileSlug}.mp3`,
    };

    // Skip voices already published (no re-spend) unless FORCE.
    const [exists] = await bucket.file(dest).exists();
    if (exists && !FORCE) {
      console.log(`\n${v.name}: already in GCS, skipping generation.`);
      manifestVoices.push(manifestEntry);
      continue;
    }

    const localPath = `voice-compare-output/${fileSlug}.mp3`;
    console.log(`\nGenerating ${v.name}...`);
    const buf = await generate(spoken, v.resolvedId);
    writeFileSync(localPath, buf);
    console.log(`  ${(buf.length / 1024).toFixed(0)} KB`);
    await bucket.upload(localPath, { destination: dest });
    console.log(`  Uploaded gs://${GCS_BUCKET}/${dest}`);
    manifestVoices.push(manifestEntry);
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
