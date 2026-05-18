/**
 * voice-test.js — Generate short voice test samples for A/B comparison.
 *
 * Searches ElevenLabs for voices by name, preprocesses a snippet of each
 * session, and generates a short MP3 sample with each voice. Outputs to
 * voice-test-output/ for download as workflow artifacts.
 *
 * Environment:
 *   ELEVENLABS_API_KEY - ElevenLabs API key
 *   RESOURCES_PATH - path to checked-out Resources repo
 *   BOOK_PATH - book path within series/ (e.g., "Narrative Journey Series/Foundations/L'Appel du Christ")
 *   SESSIONS - comma-separated session filenames
 *   VOICES - comma-separated voice search names
 *   MAX_CHARS - max characters per sample (default 1000 ≈ 1 minute)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { preprocessSession } from './preprocess-tts.js';

const API_KEY = process.env.ELEVENLABS_API_KEY;
const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const BOOK_PATH = process.env.BOOK_PATH;
const SESSIONS = (process.env.SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean);
const VOICE_NAMES = (process.env.VOICES || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_CHARS = parseInt(process.env.MAX_CHARS || '1000', 10);

if (!API_KEY) { console.error('Set ELEVENLABS_API_KEY'); process.exit(1); }
if (!BOOK_PATH) { console.error('Set BOOK_PATH'); process.exit(1); }
if (SESSIONS.length === 0) { console.error('Set SESSIONS'); process.exit(1); }
if (VOICE_NAMES.length === 0) { console.error('Set VOICES'); process.exit(1); }

const OUTPUT_DIR = 'voice-test-output';
mkdirSync(OUTPUT_DIR, { recursive: true });

async function searchVoice(name) {
  // First check workspace voices
  const wsRes = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': API_KEY },
  });
  if (wsRes.ok) {
    const ws = await wsRes.json();
    const match = ws.voices.find(v =>
      v.name.toLowerCase().includes(name.toLowerCase())
    );
    if (match) return match;
  }

  // Search shared library
  const url = `https://api.elevenlabs.io/v1/shared-voices?page_size=10&search=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { 'xi-api-key': API_KEY } });
  if (!res.ok) return null;
  const data = await res.json();
  return (data.voices || [])[0] || null;
}

async function generateSample(text, voiceId, outputPath) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.71, similarity_boost: 0.5, style: 0.0, speed: 0.92 },
      }),
    }
  );
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(outputPath, buffer);
  return buffer.length;
}

async function main() {
  console.log(`Book: ${BOOK_PATH}`);
  console.log(`Sessions: ${SESSIONS.join(', ')}`);
  console.log(`Voices: ${VOICE_NAMES.join(', ')}`);
  console.log(`Max chars per sample: ${MAX_CHARS}\n`);

  // Resolve voice IDs
  const voices = [];
  for (const name of VOICE_NAMES) {
    console.log(`Searching for voice: "${name}"...`);
    const voice = await searchVoice(name);
    if (!voice) {
      console.error(`  Voice not found: "${name}"`);
      continue;
    }
    const labels = voice.labels || {};
    console.log(`  Found: ${voice.name} (${voice.voice_id}) — ${labels.accent || labels.language || '?'}, ${labels.gender || '?'}`);
    voices.push({ name: voice.name, id: voice.voice_id });
  }

  if (voices.length === 0) {
    console.error('No voices found!');
    process.exit(1);
  }

  // Process each session
  const sessionsDir = join(RESOURCES_PATH, 'series', BOOK_PATH, 'sessions');

  for (let si = 0; si < SESSIONS.length; si++) {
    const sessionFile = SESSIONS[si];
    const mdPath = join(sessionsDir, sessionFile);

    if (!existsSync(mdPath)) {
      console.error(`\nSession file not found: ${mdPath}`);
      continue;
    }

    const markdown = readFileSync(mdPath, 'utf-8');
    const chapter = preprocessSession(markdown, 'test');

    // Take the first MAX_CHARS of plain text
    let snippet = '';
    for (const block of chapter.blocks) {
      const blockText = block.nodes[0].text;
      if (snippet.length + blockText.length + 2 > MAX_CHARS && snippet.length > 0) break;
      snippet += (snippet ? '\n\n' : '') + blockText;
    }

    const sessionSlug = sessionFile.replace('.md', '');
    console.log(`\n${sessionFile}: ${snippet.length} chars (${chapter.blocks.length} total blocks)`);
    console.log(`  Snippet preview: "${snippet.substring(0, 80)}..."`);

    // Generate with each voice
    const voiceIdx = si % voices.length;
    const voice = voices[voiceIdx];

    console.log(`  Generating with ${voice.name}...`);
    const outPath = join(OUTPUT_DIR, `${sessionSlug}--${voice.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`);
    try {
      const size = await generateSample(snippet, voice.id, outPath);
      console.log(`  Saved: ${outPath} (${(size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
    }

    // Small delay between API calls
    await new Promise(r => setTimeout(r, 500));
  }

  // Also generate all 3 voices for Session 1 so you can compare the same text
  if (SESSIONS.length > 0 && voices.length > 1) {
    const sessionFile = SESSIONS[0];
    const mdPath = join(sessionsDir, sessionFile);
    if (existsSync(mdPath)) {
      const markdown = readFileSync(mdPath, 'utf-8');
      const chapter = preprocessSession(markdown, 'test');
      let snippet = '';
      for (const block of chapter.blocks) {
        const blockText = block.nodes[0].text;
        if (snippet.length + blockText.length + 2 > MAX_CHARS && snippet.length > 0) break;
        snippet += (snippet ? '\n\n' : '') + blockText;
      }
      const sessionSlug = SESSIONS[0].replace('.md', '');

      console.log(`\n--- All voices on ${SESSIONS[0]} for comparison ---`);
      for (const voice of voices) {
        console.log(`  Generating with ${voice.name}...`);
        const outPath = join(OUTPUT_DIR, `${sessionSlug}--${voice.name.replace(/[^a-zA-Z0-9]/g, '_')}.mp3`);
        if (existsSync(outPath)) {
          console.log(`  Already exists, skipping.`);
          continue;
        }
        try {
          const size = await generateSample(snippet, voice.id, outPath);
          console.log(`  Saved: ${outPath} (${(size / 1024).toFixed(0)} KB)`);
        } catch (err) {
          console.error(`  Failed: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  console.log('\nDone! Check voice-test-output/ for samples.');
}

main().catch(err => {
  console.error('Voice test failed:', err);
  process.exit(1);
});
