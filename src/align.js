/**
 * align.js — Generate sentence-level timestamps using Whisper word timing + source text.
 *
 * Strategy: Whisper provides accurate word-level timestamps from the audio.
 * We use our own source text (from the TTS preprocessor) for the segment text,
 * since that matches the rendered markdown in the browser. Whisper's word
 * timestamps are mapped to our source sentences to get accurate timing.
 *
 * This gives us: OUR text (perfect DOM matching) + Whisper timing (accurate to audio).
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
 * Run Whisper and extract word-level timestamps.
 * Returns array of { word, start, end } sorted by start time.
 */
function getWhisperWords(mp3Path, outputDir) {
  try {
    execSync(
      `whisper "${mp3Path}" --model tiny.en --output_format json --output_dir "${outputDir}" --language en --word_timestamps True`,
      { stdio: 'inherit', timeout: 600000 }
    );

    const jsonFiles = readdirSync(outputDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.timestamps.json'));

    if (jsonFiles.length === 0) return null;

    const whisperOut = JSON.parse(readFileSync(join(outputDir, jsonFiles[jsonFiles.length - 1]), 'utf-8'));

    // Extract all words with timestamps
    const words = [];
    for (const seg of (whisperOut.segments || [])) {
      for (const w of (seg.words || [])) {
        if (w.word && w.start !== undefined && w.end !== undefined) {
          words.push({
            word: w.word.trim(),
            start: w.start,
            end: w.end,
          });
        }
      }
    }

    // If no word-level timestamps, fall back to segment-level
    if (words.length === 0) {
      for (const seg of (whisperOut.segments || [])) {
        if (seg.text && seg.start !== undefined) {
          words.push({
            word: seg.text.trim(),
            start: seg.start,
            end: seg.end,
          });
        }
      }
    }

    return words;
  } catch (err) {
    console.error('[align] Whisper failed:', err.message);
    return null;
  }
}

/**
 * Normalize text for fuzzy matching between source and Whisper output.
 */
function norm(s) {
  return s.toLowerCase()
    .replace(/[""''"\u201c\u201d\u2018\u2019]/g, '')
    .replace(/[.,;:!?()[\]{}—–\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split source plainText into sentences.
 */
function splitSentences(plainText) {
  // Split on sentence-ending punctuation followed by space/newline
  // Keep headings (lines ending with period we added) as separate sentences
  const lines = plainText.split('\n\n').filter(l => l.trim());
  const sentences = [];

  for (const line of lines) {
    // Split each paragraph/block into sentences
    const parts = line.split(/(?<=[.!?])\s+/).filter(s => s.trim());
    for (const part of parts) {
      if (part.trim().length > 0) {
        sentences.push(part.trim());
      }
    }
  }

  return sentences;
}

/**
 * Map source sentences to Whisper word timestamps.
 *
 * Walks through Whisper words and source sentences in parallel.
 * For each source sentence, finds the span of Whisper words that
 * best covers it by matching normalized words sequentially.
 */
function mapSentencesToTiming(sentences, whisperWords, totalDuration) {
  if (!whisperWords || whisperWords.length === 0) return null;

  // Build a flat list of Whisper words with timing
  const wWords = whisperWords.map(w => ({
    norm: norm(w.word),
    start: w.start,
    end: w.end,
  })).filter(w => w.norm.length > 0);

  const segments = [];
  let wIdx = 0; // current position in Whisper word list

  for (const sentence of sentences) {
    const sentenceWords = norm(sentence).split(/\s+/).filter(w => w.length > 0);
    if (sentenceWords.length === 0) continue;

    // Find the first Whisper word that matches the first word of our sentence
    // Search forward from current position (but allow some lookahead)
    const searchLimit = Math.min(wIdx + 50, wWords.length);
    let matchStart = -1;

    for (let i = wIdx; i < searchLimit; i++) {
      if (wWords[i].norm.includes(sentenceWords[0]) || sentenceWords[0].includes(wWords[i].norm)) {
        matchStart = i;
        break;
      }
    }

    if (matchStart < 0) {
      // Couldn't find start word — use proportional estimate for this sentence
      const proportion = segments.length / Math.max(sentences.length, 1);
      const estStart = proportion * totalDuration;
      const estEnd = ((segments.length + 1) / Math.max(sentences.length, 1)) * totalDuration;
      segments.push({
        start: Math.round(estStart * 100) / 100,
        end: Math.round(estEnd * 100) / 100,
        text: sentence,
      });
      continue;
    }

    // Walk forward through Whisper words to find the end of this sentence
    let matchEnd = matchStart;
    let sWordIdx = 0;

    for (let i = matchStart; i < Math.min(matchStart + sentenceWords.length + 10, wWords.length); i++) {
      matchEnd = i;
      // Check if this Whisper word matches the next expected sentence word
      if (sWordIdx < sentenceWords.length) {
        if (wWords[i].norm.includes(sentenceWords[sWordIdx]) || sentenceWords[sWordIdx].includes(wWords[i].norm)) {
          sWordIdx++;
        }
      }
      // Stop if we've matched most of our sentence words
      if (sWordIdx >= sentenceWords.length - 1) break;
    }

    segments.push({
      start: Math.round(wWords[matchStart].start * 100) / 100,
      end: Math.round(wWords[matchEnd].end * 100) / 100,
      text: sentence,
    });

    // Advance word pointer past this sentence
    wIdx = matchEnd + 1;
  }

  return { segments };
}

/**
 * Fallback: estimate timestamps by character proportion.
 */
function estimateTimestamps(plainText, durationSeconds) {
  if (!plainText || !durationSeconds) return { segments: [] };

  const sentences = splitSentences(plainText);
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
      text: sentence,
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

    // Split source text into sentences
    const sentences = splitSentences(item.plainText);
    console.log(`[align] Source sentences: ${sentences.length}`);

    let timestamps;

    if (whisperAvailable) {
      console.log('[align] Running Whisper (tiny.en) with word timestamps...');
      const t0 = Date.now();
      const whisperWords = getWhisperWords(mp3Path, tmpDir);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (whisperWords && whisperWords.length > 0) {
        console.log(`[align] Whisper: ${whisperWords.length} words in ${elapsed}s`);
        timestamps = mapSentencesToTiming(sentences, whisperWords, duration);
        if (timestamps) {
          console.log(`[align] Mapped: ${timestamps.segments.length} segments (source text + Whisper timing)`);
        }
      } else {
        console.log(`[align] Whisper returned no words after ${elapsed}s`);
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
  process.exit(0);
});
