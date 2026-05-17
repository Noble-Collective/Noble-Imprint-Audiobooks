/**
 * align.js — Generate sentence-level timestamps via Whisper forced alignment.
 *
 * Reads generated MP3s and their TTS JSON from GCS, runs Whisper to produce
 * timestamps, uploads .timestamps.json files back to GCS.
 *
 * Environment:
 *   GCS_BUCKET - GCS bucket name
 *   WORK_FILE - path to changed_sessions.json from detect-changes.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';

const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

/**
 * Run Whisper on an audio file to generate timestamps.
 * Uses whisper.cpp or falls back to OpenAI Whisper Python.
 */
function runWhisper(audioPath, outputDir) {
  const baseName = audioPath.replace(/\.[^.]+$/, '');

  // Try whisper.cpp first (faster, no Python needed)
  try {
    // Convert MP3 to WAV (16kHz mono, required by whisper.cpp)
    const wavPath = join(outputDir, 'temp.wav');
    execSync(`ffmpeg -i "${audioPath}" -ar 16000 -ac 1 -y "${wavPath}"`, { stdio: 'pipe' });

    // Run whisper.cpp with word-level timestamps
    const modelPath = process.env.WHISPER_MODEL || 'models/ggml-base.en.bin';
    if (existsSync(modelPath)) {
      execSync(`whisper-cpp -m "${modelPath}" -f "${wavPath}" -oj -of "${join(outputDir, 'whisper_out')}"`, { stdio: 'pipe' });
      const jsonPath = join(outputDir, 'whisper_out.json');
      if (existsSync(jsonPath)) {
        return JSON.parse(readFileSync(jsonPath, 'utf-8'));
      }
    }
  } catch {
    // whisper.cpp not available, continue to fallback
  }

  // Fallback: use OpenAI Whisper Python (if installed)
  try {
    execSync(`whisper "${audioPath}" --model base.en --output_format json --output_dir "${outputDir}" --language en`, { stdio: 'pipe' });
    const jsonFiles = require('node:fs').readdirSync(outputDir).filter(f => f.endsWith('.json') && f !== 'whisper_out.json');
    if (jsonFiles.length > 0) {
      return JSON.parse(readFileSync(join(outputDir, jsonFiles[0]), 'utf-8'));
    }
  } catch {
    // Whisper Python not available either
  }

  // Final fallback: estimate timestamps from character proportions
  console.log('  Warning: Whisper not available, using character-proportion estimation');
  return null;
}

/**
 * Convert Whisper output to our timestamps format.
 */
function formatTimestamps(whisperOutput) {
  if (!whisperOutput) return null;

  // Whisper outputs segments with start/end times
  const segments = (whisperOutput.segments || whisperOutput.transcription || []).map(seg => ({
    start: seg.timestamps?.from ? parseTimestamp(seg.timestamps.from) : (seg.start || 0),
    end: seg.timestamps?.to ? parseTimestamp(seg.timestamps.to) : (seg.end || 0),
    text: (seg.text || '').trim(),
  })).filter(s => s.text);

  return { segments };
}

function parseTimestamp(ts) {
  // "00:01:23.456" → seconds
  if (typeof ts === 'number') return ts;
  const parts = ts.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(ts) || 0;
}

/**
 * Estimate timestamps by character proportion when Whisper is unavailable.
 */
function estimateTimestamps(plainText, durationSeconds) {
  const totalChars = plainText.length;
  if (totalChars === 0 || durationSeconds === 0) return { segments: [] };

  // Split into sentences
  const sentences = plainText.split(/(?<=[.!?])\s+/).filter(s => s.trim());
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
    console.log('No work file found, skipping alignment.');
    return;
  }

  const workItems = JSON.parse(readFileSync(workFile, 'utf-8'));
  if (workItems.length === 0) {
    console.log('No sessions to align.');
    return;
  }

  for (const item of workItems) {
    const slug = item.sessionFile.replace('.md', '').toLowerCase();
    const audioGcsPath = `audio/${item.bookSlugPath}/${slug}.mp3`;
    const timestampsGcsPath = `audio/${item.bookSlugPath}/${slug}.timestamps.json`;

    console.log(`Aligning: ${item.sessionFile}`);

    const tmpDir = join('/tmp', 'align', item.bookSlugPath);
    mkdirSync(tmpDir, { recursive: true });

    // Download MP3 from GCS
    const mp3Path = join(tmpDir, `${slug}.mp3`);
    try {
      await bucket.file(audioGcsPath).download({ destination: mp3Path });
    } catch (err) {
      console.log(`  Skipping: MP3 not found in GCS (${err.message})`);
      continue;
    }

    // Get duration
    let duration = 0;
    try {
      const probe = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mp3Path}"`, { encoding: 'utf-8' });
      duration = parseFloat(probe.trim());
    } catch { /* use 0 */ }

    // Run Whisper
    const whisperOutput = runWhisper(mp3Path, tmpDir);
    let timestamps;

    if (whisperOutput) {
      timestamps = formatTimestamps(whisperOutput);
      console.log(`  Whisper: ${timestamps.segments.length} segments`);
    } else {
      // Fallback to estimation
      timestamps = estimateTimestamps(item.plainText, duration);
      console.log(`  Estimated: ${timestamps.segments.length} segments (Whisper unavailable)`);
    }

    // Upload timestamps to GCS
    const tsPath = join(tmpDir, `${slug}.timestamps.json`);
    writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));
    await bucket.upload(tsPath, { destination: timestampsGcsPath });
    console.log(`  Uploaded: gs://${GCS_BUCKET}/${timestampsGcsPath}`);
  }

  console.log('\nAlignment complete!');
}

main().catch(err => {
  console.error('Alignment failed:', err);
  // Non-fatal — audio works without timestamps
  process.exit(0);
});
