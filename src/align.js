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
 * Compare two normalized words. Uses exact match for very short words
 * (1 char) and progressively looser matching for longer words.
 */
function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length <= 1 || b.length <= 1) return false;
  // For short words (2-3 chars), one must contain the other
  // e.g., "my" matches "my", "in" matches "in", but "in" won't match "on"
  if (a.length <= 3 || b.length <= 3) {
    return a.includes(b) || b.includes(a);
  }
  // For longer words, prefix match (first 4 chars)
  const prefix = Math.min(4, a.length, b.length);
  return a.substring(0, prefix) === b.substring(0, prefix);
}

/**
 * Find the start of a sentence in the Whisper word list by matching
 * multiple anchor words (not just the first word). Requires at least
 * 2 of the first 3 significant words to match in sequence to avoid
 * false positives from common words.
 */
function findSentenceStart(wWords, sentenceWords, startIdx, endIdx) {
  // Get anchor words: first 3 words with length > 3 chars (skip "the", "a", etc.)
  const anchors = [];
  for (let i = 0; i < sentenceWords.length && anchors.length < 3; i++) {
    if (sentenceWords[i].length > 3 || anchors.length === 0) {
      anchors.push({ word: sentenceWords[i], srcIdx: i });
    }
  }

  for (let i = startIdx; i < endIdx; i++) {
    if (!wordsMatch(wWords[i].norm, anchors[0].word)) continue;

    // Found first anchor — verify by checking remaining anchors nearby
    if (anchors.length === 1) return i;

    let confirmed = 1;
    let searchPos = i + 1;
    for (let a = 1; a < anchors.length; a++) {
      // Look for the next anchor within a reasonable window
      const gap = anchors[a].srcIdx - anchors[a - 1].srcIdx;
      const searchEnd = Math.min(searchPos + gap + 5, endIdx);
      for (let j = searchPos; j < searchEnd; j++) {
        if (wordsMatch(wWords[j].norm, anchors[a].word)) {
          confirmed++;
          searchPos = j + 1;
          break;
        }
      }
    }

    // Accept if we confirmed at least 2 anchors (or only 1 anchor exists)
    if (confirmed >= Math.min(2, anchors.length)) return i;
  }

  // Fallback: single-word match for very short sentences (headings, numbers)
  if (sentenceWords.length <= 3) {
    for (let i = startIdx; i < endIdx; i++) {
      if (wWords[i].norm === sentenceWords[0]) return i;
    }
  }

  return -1;
}

/**
 * Map source sentences (with blockIndex/sentenceIndex) to Whisper word timestamps.
 *
 * For each source sentence, finds where it starts and ends in the Whisper
 * word stream using multi-word anchor matching. Only advances the end
 * pointer on actual word matches (never overshoots). Unmatched sentences
 * are gap-filled from their neighbors so every sentence has coverage.
 *
 * @param {Array<{blockIndex, sentenceIndex, text}>} sentences - from preprocessor
 */
function mapSentencesToTiming(sentences, whisperWords, totalDuration) {
  if (!whisperWords || whisperWords.length === 0) return null;

  // Build a flat list of Whisper words with timing
  const wWords = whisperWords.map(w => ({
    norm: norm(w.word),
    start: w.start,
    end: w.end,
  })).filter(w => w.norm.length > 0);

  // Pass 1: match sentences to Whisper words. Unmatched get start=-1.
  const segments = [];
  let wIdx = 0;

  for (const sentenceObj of sentences) {
    const sentence = sentenceObj.text;
    const sentenceWords = norm(sentence).split(/\s+/).filter(w => w.length > 0);
    if (sentenceWords.length === 0) continue;

    // Search for sentence start using multi-word anchoring
    const searchLimit = Math.min(wIdx + 200, wWords.length);
    const matchStart = findSentenceStart(wWords, sentenceWords, wIdx, searchLimit);

    if (matchStart < 0) {
      // Mark for gap-filling in pass 2
      segments.push({
        start: -1, end: -1,
        blockIndex: sentenceObj.blockIndex,
        sentenceIndex: sentenceObj.sentenceIndex,
        text: sentence,
      });
      // Don't advance wIdx — next sentence should search from the same position
      continue;
    }

    // Walk forward matching words. Allow skipping unmatched words on both sides.
    // For each Whisper word, check if it matches the current or next few source words.
    // This handles Whisper dropping, inserting, or altering individual words.
    let lastMatched = matchStart;
    let sWordIdx = 1; // first word already matched via findSentenceStart
    const walkLimit = Math.min(matchStart + sentenceWords.length * 2 + 10, wWords.length);

    for (let i = matchStart + 1; i < walkLimit; i++) {
      if (sWordIdx >= sentenceWords.length) break;
      // Try matching current source word
      if (wordsMatch(wWords[i].norm, sentenceWords[sWordIdx])) {
        lastMatched = i;
        sWordIdx++;
      } else {
        // Try skipping 1-2 source words (Whisper may have dropped them)
        for (let skip = 1; skip <= 2 && sWordIdx + skip < sentenceWords.length; skip++) {
          if (wordsMatch(wWords[i].norm, sentenceWords[sWordIdx + skip])) {
            lastMatched = i;
            sWordIdx += skip + 1;
            break;
          }
        }
      }
    }

    segments.push({
      start: wWords[matchStart].start,
      end: wWords[lastMatched].end,
      blockIndex: sentenceObj.blockIndex,
      sentenceIndex: sentenceObj.sentenceIndex,
      text: sentence,
    });

    // Advance pointer past the last matched word
    wIdx = lastMatched + 1;
  }

  // Pass 2a: sanity check — detect segments with duration too short for their
  // text length. These are false matches where the algorithm matched to wrong
  // Whisper words. Mark them as unmatched so the gap-filler picks them up.
  const totalChars = segments.reduce((s, seg) => s + seg.text.length, 0);
  const avgCharsPerSec = totalChars / totalDuration;
  for (const seg of segments) {
    if (seg.start < 0) continue;
    const duration = seg.end - seg.start;
    const expectedDuration = seg.text.length / avgCharsPerSec;
    // If actual duration is less than 15% of expected, it's a bad match
    if (duration < expectedDuration * 0.15 && seg.text.length > 20) {
      seg.start = -1;
      seg.end = -1;
    }
  }

  // Pass 2b: fill gaps — interpolate unmatched sentences from neighbors.
  // Every sentence gets timing coverage.
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start >= 0) continue;

    // Find the nearest matched segments before and after this gap
    let prevEnd = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (segments[j].end >= 0) { prevEnd = segments[j].end; break; }
    }
    let nextStart = totalDuration;
    let gapCount = 0;
    for (let j = i; j < segments.length; j++) {
      if (segments[j].start >= 0) { nextStart = segments[j].start; break; }
      gapCount++;
    }

    // Distribute the gap proportionally by character count
    const gapChars = segments.slice(i, i + gapCount).reduce((s, seg) => s + seg.text.length, 0);
    const gapDuration = nextStart - prevEnd;
    let charOffset = 0;
    for (let j = 0; j < gapCount; j++) {
      const seg = segments[i + j];
      const ratio = seg.text.length / gapChars;
      seg.start = prevEnd + (charOffset / gapChars) * gapDuration;
      charOffset += seg.text.length;
      seg.end = prevEnd + (charOffset / gapChars) * gapDuration;
    }
  }

  // Pass 3: round and enforce monotonic timestamps
  for (const seg of segments) {
    seg.start = Math.round(seg.start * 100) / 100;
    seg.end = Math.round(seg.end * 100) / 100;
  }
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end) {
      segments[i].start = segments[i - 1].end;
    }
    if (segments[i].end <= segments[i].start) {
      segments[i].end = segments[i].start + 0.5;
    }
  }

  return { segments };
}

/**
 * Fallback: estimate timestamps by character proportion.
 */
function estimateTimestamps(sentences, durationSeconds) {
  if (!sentences || !durationSeconds) return { segments: [] };

  const totalChars = sentences.reduce((sum, s) => sum + s.text.length, 0);
  const segments = [];
  let charOffset = 0;

  for (const sentenceObj of sentences) {
    const start = (charOffset / totalChars) * durationSeconds;
    charOffset += sentenceObj.text.length;
    const end = (charOffset / totalChars) * durationSeconds;
    segments.push({
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      blockIndex: sentenceObj.blockIndex,
      sentenceIndex: sentenceObj.sentenceIndex,
      text: sentenceObj.text,
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

    // Use preprocessor's sentence list (with blockIndex/sentenceIndex)
    // Rebuild from the work item's TTS blocks if sentences aren't passed directly
    let sentences;
    if (item.sentences) {
      sentences = item.sentences;
    } else {
      // Reconstruct from blocks — split each block into sentences
      sentences = [];
      const blocks = item.ttsBlocks || [];
      for (let bi = 0; bi < blocks.length; bi++) {
        const blockText = blocks[bi].nodes[0].text;
        const sents = blockText.split(/(?<=[.!?])\s+/).filter(s => s.trim());
        for (let si = 0; si < sents.length; si++) {
          sentences.push({ blockIndex: bi, sentenceIndex: si, text: sents[si].trim() });
        }
      }
    }
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
      timestamps = estimateTimestamps(sentences, duration);
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
