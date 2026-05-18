/**
 * align.js — Generate sentence-level timestamps via Whisper transcription.
 *
 * Runs OpenAI Whisper (tiny.en model) on each chapter MP3 to get accurate
 * word/sentence-level timestamps. Uploads .timestamps.json to GCS.
 *
 * Environment:
 *   GCS_BUCKET - GCS bucket name
 *   WORK_FILE - path to changed_sessions.json from detect-changes.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';

const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

/**
 * Install Whisper if not already available.
 */
function ensureWhisper() {
  try {
    execSync('whisper --help', { stdio: 'pipe' });
    console.log('[align] Whisper already installed');
    return true;
  } catch {
    console.log('[align] Installing Whisper...');
    try {
      execSync('pip install -q openai-whisper', { stdio: 'inherit', timeout: 120000 });
      console.log('[align] Whisper installed');
      return true;
    } catch (err) {
      console.error('[align] Failed to install Whisper:', err.message);
      return false;
    }
  }
}

/**
 * Run Whisper on an audio file and return segments with timestamps.
 */
function runWhisper(mp3Path, outputDir) {
  const baseName = mp3Path.replace(/\.[^.]+$/, '');

  try {
    // Run whisper with tiny.en model for speed — outputs JSON with timestamps
    execSync(
      `whisper "${mp3Path}" --model tiny.en --output_format json --output_dir "${outputDir}" --language en --word_timestamps True`,
      { stdio: 'inherit', timeout: 600000 } // 10 min timeout per chapter
    );

    // Find the output JSON file
    const jsonFiles = readdirSync(outputDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.timestamps.json'));

    if (jsonFiles.length === 0) {
      console.warn('[align] No Whisper output JSON found');
      return null;
    }

    const whisperOut = JSON.parse(readFileSync(join(outputDir, jsonFiles[jsonFiles.length - 1]), 'utf-8'));
    return whisperOut;
  } catch (err) {
    console.error('[align] Whisper failed:', err.message);
    return null;
  }
}

/**
 * Convert Whisper output to our timestamps format.
 * Whisper outputs segments that roughly correspond to sentences.
 */
function formatTimestamps(whisperOutput) {
  if (!whisperOutput || !whisperOutput.segments) return null;

  const segments = whisperOutput.segments
    .map(seg => ({
      start: Math.round(seg.start * 100) / 100,
      end: Math.round(seg.end * 100) / 100,
      text: (seg.text || '').trim(),
    }))
    .filter(s => s.text.length > 0);

  return { segments };
}

/**
 * Estimate timestamps by character proportion (fallback).
 */
function estimateTimestamps(plainText, durationSeconds) {
  if (!plainText || !durationSeconds) return { segments: [] };

  const sentences = plainText.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  const segments = [];
  let charOffset = 0;

  for (const sentence of sentences) {
    const start = (charOffset / totalChars) * durationSeconds;
    charOffset += sentence.length;
    const end = (charOffset / totalChars) * durationSeconds;
    segments.push({
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text: sentence.trim(),
    });
  }

  return { segments };
}

async function main() {
  const workFile = process.env.WORK_FILE || join(process.env.RUNNER_TEMP || '/tmp', 'changed_sessions.json');
  if (!existsSync(workFile)) {
    console.log('[align] No work file found, skipping.');
    return;
  }

  const workItems = JSON.parse(readFileSync(workFile, 'utf-8'));
  if (workItems.length === 0) {
    console.log('[align] No sessions to align.');
    return;
  }

  const whisperAvailable = ensureWhisper();

  for (const item of workItems) {
    const slug = item.sessionFile.replace('.md', '').toLowerCase();
    const audioGcsPath = `audio/${item.bookSlugPath}/${slug}.mp3`;
    const timestampsGcsPath = `audio/${item.bookSlugPath}/${slug}.timestamps.json`;

    console.log(`[align] ${item.sessionFile}`);

    const tmpDir = join('/tmp', 'align', item.bookSlugPath, slug);
    mkdirSync(tmpDir, { recursive: true });

    // Download MP3 from GCS
    const mp3Path = join(tmpDir, `${slug}.mp3`);
    try {
      await bucket.file(audioGcsPath).download({ destination: mp3Path });
    } catch (err) {
      console.log(`[align] Skipping: MP3 not in GCS (${err.message})`);
      continue;
    }

    // Get duration
    let duration = 0;
    try {
      const probe = execSync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mp3Path}"`,
        { encoding: 'utf-8' }
      );
      duration = parseFloat(probe.trim());
    } catch { /* use 0 */ }
    console.log(`[align] Duration: ${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s`);

    let timestamps;

    if (whisperAvailable) {
      console.log('[align] Running Whisper (tiny.en)...');
      const t0 = Date.now();
      const whisperOutput = runWhisper(mp3Path, tmpDir);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (whisperOutput) {
        timestamps = formatTimestamps(whisperOutput);
        console.log(`[align] Whisper: ${timestamps.segments.length} segments in ${elapsed}s`);
      }
    }

    if (!timestamps) {
      console.log('[align] Falling back to character-proportion estimation');
      timestamps = estimateTimestamps(item.plainText, duration);
      console.log(`[align] Estimated: ${timestamps.segments.length} segments`);
    }

    // Upload timestamps to GCS
    const tsPath = join(tmpDir, `${slug}.timestamps.json`);
    writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));
    await bucket.upload(tsPath, { destination: timestampsGcsPath });
    console.log(`[align] Uploaded: gs://${GCS_BUCKET}/${timestampsGcsPath}`);
  }

  console.log('\n[align] Complete!');
}

main().catch(err => {
  console.error('[align] Failed:', err);
  process.exit(0); // Non-fatal — audio works without timestamps
});
