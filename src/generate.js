/**
 * generate.js — Generate audiobook audio via ElevenLabs standard TTS API.
 *
 * Uses chunk-level change detection: each chapter is split into ~4,500-char
 * chunks at paragraph boundaries. Only chunks whose content hash changed
 * are regenerated. Unchanged chunks are downloaded from GCS. All chunks
 * are then concatenated into the final chapter MP3.
 *
 * Environment:
 *   ELEVENLABS_API_KEY - ElevenLabs API key
 *   GCS_BUCKET - GCS bucket name
 *   RESOURCES_PATH - path to checked-out Resources repo
 *   RESOURCES_TOKEN - GitHub PAT for committing back
 *   WORK_FILE - path to changed_sessions.json from detect-changes.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

const API_BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = process.env.ELEVENLABS_API_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const CHUNK_SIZE = 4500;

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

/**
 * Query ElevenLabs subscription for credit usage.
 * Returns { character_count, character_limit } or null on failure.
 */
async function getCredits() {
  try {
    const res = await fetch(`${API_BASE}/user/subscription`, {
      headers: { 'xi-api-key': API_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      used: data.character_count || 0,
      limit: data.character_limit || 0,
      remaining: (data.character_limit || 0) - (data.character_count || 0),
    };
  } catch { return null; }
}

/**
 * Split text into chunks by walking through blocks linearly.
 *
 * Accumulates blocks into a chunk until one of two flush triggers:
 *   1. An H1/H2/H3 heading is reached — structural break
 *   2. Adding the next block would exceed TARGET_CHUNK_SIZE — size break
 *
 * Minimum size guard: never flush a chunk under MIN_CHUNK_SIZE chars,
 * even at a heading boundary — keeps chunks long enough for natural TTS.
 *
 * Uses block sub_type metadata (h1, h2, h3, p) from preprocessing.
 */
const TARGET_CHUNK_SIZE = 800;
const MIN_CHUNK_SIZE = 250;
const FORCE_SPLIT_TYPES = new Set(['h1', 'h2', 'h3']);

function chunkText(plainText, maxChars = CHUNK_SIZE, blocks = null) {
  // If no blocks provided, fall back to paragraph splitting
  if (!blocks || blocks.length === 0) {
    return splitAtParagraphs(plainText, maxChars);
  }

  const chunks = [];
  let currentTexts = [];
  let currentLen = 0;

  function flush() {
    if (currentTexts.length > 0) {
      chunks.push(currentTexts.join('\n\n'));
      currentTexts = [];
      currentLen = 0;
    }
  }

  for (const block of blocks) {
    const text = block.nodes[0].text;
    const addedLen = currentLen > 0 ? text.length + 2 : text.length; // +2 for \n\n separator

    // Flush trigger 1: H1/H2/H3 heading (if chunk is large enough)
    if (FORCE_SPLIT_TYPES.has(block.sub_type) && currentLen >= MIN_CHUNK_SIZE) {
      flush();
    }

    // Flush trigger 2: adding this block would exceed target (if chunk is large enough)
    if (currentLen + addedLen > TARGET_CHUNK_SIZE && currentLen >= MIN_CHUNK_SIZE) {
      flush();
    }

    currentTexts.push(text);
    currentLen += currentLen > 0 ? text.length + 2 : text.length;
  }
  flush();

  // If the last chunk is tiny, merge it into the previous one
  if (chunks.length > 1 && chunks[chunks.length - 1].length < MIN_CHUNK_SIZE) {
    const last = chunks.pop();
    chunks[chunks.length - 1] += '\n\n' + last;
  }

  return chunks.filter(c => c.trim());
}

/**
 * Split text at paragraph boundaries (greedy packing).
 */
function splitAtParagraphs(text, maxChars) {
  const paragraphs = text.split('\n\n').filter(p => p.trim());
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function hashChunk(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Call ElevenLabs TTS with timestamps for a single text chunk.
 * Uses previous_text/next_text for prosody continuity across chunks.
 * Returns { audio: Buffer, alignment: { characters, character_start_times_seconds, character_end_times_seconds } }
 */
async function generateChunk(text, voiceId, modelId, voiceSettings, outputFormat, previousText, nextText) {
  const body = {
    text,
    model_id: modelId || 'eleven_multilingual_v2',
    voice_settings: voiceSettings || { stability: 0.71, similarity_boost: 0.5, style: 0.0 },
  };
  if (previousText) body.previous_text = previousText;
  if (nextText) body.next_text = nextText;

  const res = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}/with-timestamps?output_format=${outputFormat || 'mp3_44100_128'}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    const isQuota = body.includes('quota_exceeded');
    const err = new Error(`TTS failed (${res.status}): ${body}`);
    err.status = isQuota ? 'quota' : res.status;
    throw err;
  }
  const data = await res.json();
  return {
    audio: Buffer.from(data.audio_base64, 'base64'),
    alignment: data.alignment || null,
  };
}

async function generateWithRetry(text, voiceId, modelId, voiceSettings, outputFormat, previousText, nextText, retries = 5) {
  const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
  for (let i = 0; i < retries; i++) {
    try {
      return await generateChunk(text, voiceId, modelId, voiceSettings, outputFormat, previousText, nextText);
    } catch (err) {
      const status = err.status;
      const isRetryable = RETRYABLE_STATUS.has(status) || status === 'quota';
      if (isRetryable && i < retries - 1) {
        // Quota errors get longer backoff (60s, 120s, 180s, 240s) to allow auto top-up
        // Server/rate errors get shorter backoff (3s, 9s, 27s, 81s)
        const wait = status === 'quota'
          ? (i + 1) * 60 * 1000
          : Math.pow(3, i + 1) * 1000;
        const label = status === 'quota' ? 'Quota exceeded (waiting for auto top-up)'
          : status === 429 ? 'Rate limited'
          : 'Server error (' + status + ')';
        console.log(`    ${label}, retrying in ${wait / 1000}s... (attempt ${i + 2}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
      } else throw err;
    }
  }
}

/**
 * Build sentence-level timestamps from per-chunk character alignments.
 * Each chunk's alignment has character-level start/end times relative to chunk start.
 * We offset by cumulative chunk durations + silence gaps to get chapter-level times.
 */
function buildTimestampsFromAlignments(chunkAlignments, chunkTexts, chunkDurations, sentences, gapSeconds) {
  // Build a chapter-level character timeline: for each character position in the
  // concatenated plain text, what's its absolute time in the chapter?
  const charTimes = []; // [{start, end}] for each character in plain text

  // The plain text is blocks joined by \n\n. Chunks are the plain text split at
  // paragraph boundaries. We need to map chunk characters back to plain text positions.
  let chapterOffset = 0; // cumulative time offset for current chunk

  for (let c = 0; c < chunkAlignments.length; c++) {
    const alignment = chunkAlignments[c];
    if (!alignment || !alignment.character_start_times_seconds) {
      // No alignment data — estimate proportionally for this chunk
      const chunkChars = chunkTexts[c].length;
      const duration = chunkDurations[c];
      for (let i = 0; i < chunkChars; i++) {
        charTimes.push({
          start: chapterOffset + (i / chunkChars) * duration,
          end: chapterOffset + ((i + 1) / chunkChars) * duration,
        });
      }
    } else {
      const starts = alignment.character_start_times_seconds;
      const ends = alignment.character_end_times_seconds;
      for (let i = 0; i < starts.length; i++) {
        charTimes.push({
          start: chapterOffset + starts[i],
          end: chapterOffset + ends[i],
        });
      }
    }

    chapterOffset += chunkDurations[c] + gapSeconds;
  }

  // Now map sentences to character positions.
  // charTimes is a flat array of per-character timestamps across all chunks
  // (no separators). The plain text joins blocks with \n\n, and chunks are
  // joined with \n\n too. We need to find sentence positions in the chunk
  // text and convert to charTimes indices, skipping the \n\n separators.

  // Build a combined text that matches charTimes indexing (no \n\n between chunks).
  // Strip SSML break tags since ElevenLabs alignment data doesn't include them.
  const strippedChunks = chunkTexts.map(t => t.replace(/<break[^>]*\/>/g, ''));
  const flatText = strippedChunks.join('');

  if (charTimes.length !== flatText.length) {
    console.log(`    Warning: charTimes (${charTimes.length}) != flatText (${flatText.length}) — using proportional fallback for mismatched chars`);
  }

  const segments = [];
  let searchFrom = 0;

  for (const sent of sentences) {
    // Try exact match, then case-insensitive (headings are sentence-cased in TTS)
    let idx = flatText.indexOf(sent.text, searchFrom);
    if (idx < 0) {
      idx = flatText.toLowerCase().indexOf(sent.text.toLowerCase(), searchFrom);
    }
    if (idx < 0) {
      // Sentence not found — use proportional estimate
      const proportion = segments.length / Math.max(sentences.length, 1);
      const totalDuration = chapterOffset - CHUNK_GAP_SECONDS;
      segments.push({
        start: Math.round(proportion * totalDuration * 100) / 100,
        end: Math.round(((segments.length + 1) / sentences.length) * totalDuration * 100) / 100,
        blockIndex: sent.blockIndex,
        sentenceIndex: sent.sentenceIndex,
        text: sent.text,
      });
      continue;
    }

    const startChar = idx;
    const endChar = idx + sent.text.length - 1;
    searchFrom = idx + sent.text.length;

    // Look up times from charTimes array
    const startTime = startChar < charTimes.length ? charTimes[startChar].start : 0;
    const endTime = endChar < charTimes.length ? charTimes[endChar].end : startTime + 1;

    segments.push({
      start: Math.round(startTime * 100) / 100,
      end: Math.round(endTime * 100) / 100,
      blockIndex: sent.blockIndex,
      sentenceIndex: sent.sentenceIndex,
      text: sent.text,
    });
  }

  return { segments };
}

const CHUNK_GAP_SECONDS = 0; // no silence gaps — ElevenLabs handles paragraph pauses naturally

function concatenateChunks(chunkPaths, outputPath, tmpDir) {
  const listPath = outputPath + '.concat.txt';
  const entries = chunkPaths.map(p => `file '${p}'`);
  writeFileSync(listPath, entries.join('\n'));
  execSync(`ffmpeg -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}" -y`, { stdio: 'pipe' });
}

async function uploadToGCS(localPath, gcsPath) {
  await bucket.upload(localPath, { destination: gcsPath });
  console.log(`    Uploaded: gs://${GCS_BUCKET}/${gcsPath}`);
}

async function downloadFromGCS(gcsPath, localPath) {
  await bucket.file(gcsPath).download({ destination: localPath });
}

/**
 * Build a hash→GCS filename map from the manifest for a session.
 * Supports both old format (chunkHashes: {"0":"abc"}) and new format (hashToFile: {"abc":"abc.mp3"}).
 */
function getExistingHashMap(manifest, sessionFile) {
  if (!manifest) return {};
  const session = manifest.sessions.find(s => s.sessionFile === sessionFile);
  if (!session) return {};
  // New format: hash → GCS filename
  if (session.hashToFile) return session.hashToFile;
  // Old format: index → hash — convert to hash → old index-based filename
  if (session.chunkHashes) {
    const map = {};
    for (const [idx, hash] of Object.entries(session.chunkHashes)) {
      map[hash] = `${String(idx).padStart(3, '0')}`;
    }
    return map;
  }
  return {};
}

async function updateManifest(bookSlugPath, bookRepoPath, sessions) {
  const manifestPath = `audio/${bookSlugPath}/manifest.json`;
  let manifest;
  try {
    const [contents] = await bucket.file(manifestPath).download();
    manifest = JSON.parse(contents.toString());
  } catch {
    manifest = { bookPath: bookRepoPath, sessions: [], totalDurationSeconds: 0 };
  }

  for (const s of sessions) {
    const idx = manifest.sessions.findIndex(e => e.sessionFile === s.sessionFile);
    if (idx >= 0) manifest.sessions[idx] = s;
    else manifest.sessions.push(s);
  }

  manifest.sessions.sort((a, b) => a.sessionFile.localeCompare(b.sessionFile));
  manifest.totalDurationSeconds = manifest.sessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);

  const tmpPath = join('/tmp', 'manifest.json');
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  await uploadToGCS(tmpPath, manifestPath);
  return manifest;
}

async function main() {
  const workFile = process.env.WORK_FILE || join(process.env.RUNNER_TEMP || '/tmp', 'changed_sessions.json');
  const workItems = JSON.parse(readFileSync(workFile, 'utf-8'));

  // Log trigger source
  const triggerEvent = process.env.GITHUB_EVENT_NAME || 'unknown';
  const bookFilter = process.env.BOOK_PATH_FILTER || '(all books)';
  const forceRegen = process.env.FORCE_REGENERATE === 'true';
  console.log(`[AUDIT] Trigger: ${triggerEvent} | Book filter: ${bookFilter} | Force: ${forceRegen}`);

  if (workItems.length === 0) {
    console.log('No work to do.');
    return;
  }

  // Snapshot credits before generation
  const creditsBefore = await getCredits();
  if (creditsBefore) {
    console.log(`[AUDIT] Credits before: ${creditsBefore.remaining.toLocaleString()} remaining (${creditsBefore.used.toLocaleString()} / ${creditsBefore.limit.toLocaleString()})`);
  }

  const bookGroups = {};
  for (const item of workItems) {
    if (!bookGroups[item.bookRepoPath]) bookGroups[item.bookRepoPath] = [];
    bookGroups[item.bookRepoPath].push(item);
  }

  let grandTotalChars = 0, grandTotalDuration = 0, grandTotalRegen = 0, grandTotalReused = 0, grandTotalSessions = 0;

  for (const [bookRepoPath, items] of Object.entries(bookGroups)) {
    const bookSlugPath = items[0].bookSlugPath;
    const meta = items[0].meta;
    const tmpDir = join('/tmp', 'audiobook', bookSlugPath);
    mkdirSync(tmpDir, { recursive: true });

    console.log(`\nProcessing book: ${bookRepoPath}`);
    console.log(`  Voice: ${meta.voice_id}`);
    console.log(`  Model: ${meta.model_id || 'eleven_multilingual_v2'}`);
    console.log(`  ${items.length} session(s) to generate`);

    // Load existing manifest for chunk-level comparison
    let existingManifest = null;
    try {
      const [contents] = await bucket.file(`audio/${bookSlugPath}/manifest.json`).download();
      existingManifest = JSON.parse(contents.toString());
    } catch { /* no manifest yet */ }

    const sessionResults = [];

    for (const item of items) {
      const slug = item.sessionFile.replace('.md', '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const voiceId = (meta.voice_test_map && meta.voice_test_map[item.sessionFile]) || meta.voice_id;
      console.log(`\n  Chapter: ${item.chapterName} (${item.sessionFile})`);
      console.log(`    Voice: ${voiceId}`);

      // Chunk the plain text using stable heading-based boundaries
      const chunks = chunkText(item.plainText, CHUNK_SIZE, item.ttsBlocks);
      const chunkHashes = chunks.map(c => hashChunk(c));

      // Build hash→file map from existing manifest (supports old and new format)
      const existingHashMap = getExistingHashMap(existingManifest, item.sessionFile);
      const gcsChunksDir = `audio/${bookSlugPath}/chunks/${slug}`;

      let regeneratedCount = 0;
      let reusedCount = 0;
      const chunkPaths = [];
      const chunkAlignments = [];
      const newHashToFile = {};

      for (let c = 0; c < chunks.length; c++) {
        const hash = chunkHashes[c];
        const gcsName = hash; // use content hash as filename for stability
        const chunkPath = join(tmpDir, `${slug}_chunk_${hash}.mp3`);
        const chunkAlignPath = join(tmpDir, `${slug}_chunk_${hash}.align.json`);
        chunkPaths.push(chunkPath);

        // Check if this chunk's content hash exists in any previous chunk (regardless of index)
        const existingFile = existingHashMap[hash];
        if (existingFile) {
          try {
            await downloadFromGCS(`${gcsChunksDir}/${existingFile}.mp3`, chunkPath);
            try {
              await downloadFromGCS(`${gcsChunksDir}/${existingFile}.align.json`, chunkAlignPath);
              chunkAlignments.push(JSON.parse(readFileSync(chunkAlignPath, 'utf-8')));
            } catch {
              chunkAlignments.push(null);
            }
            // Re-upload under new hash-based name if it was stored under old index-based name
            if (existingFile !== gcsName) {
              await uploadToGCS(chunkPath, `${gcsChunksDir}/${gcsName}.mp3`);
              if (chunkAlignments[chunkAlignments.length - 1]) {
                await uploadToGCS(chunkAlignPath, `${gcsChunksDir}/${gcsName}.align.json`);
              }
            }
            newHashToFile[hash] = gcsName;
            reusedCount++;
            continue;
          } catch {
            // Chunk file missing in GCS — regenerate
          }
        }

        // Generate this chunk with timestamps, providing surrounding text for prosody
        const prevText = c > 0 ? chunks[c - 1].slice(-200) : undefined;
        const nextChunkText = c < chunks.length - 1 ? chunks[c + 1].slice(0, 200) : undefined;
        console.log(`    Chunk ${c + 1}/${chunks.length} (${chunks[c].length} chars) — generating...`);
        const result = await generateWithRetry(
          chunks[c], voiceId, meta.model_id, meta.voice_settings,
          meta.output_format || 'mp3_44100_128', prevText, nextChunkText
        );
        writeFileSync(chunkPath, result.audio);
        chunkAlignments.push(result.alignment);
        regeneratedCount++;

        // Upload with hash-based filename
        await uploadToGCS(chunkPath, `${gcsChunksDir}/${gcsName}.mp3`);
        if (result.alignment) {
          writeFileSync(chunkAlignPath, JSON.stringify(result.alignment));
          await uploadToGCS(chunkAlignPath, `${gcsChunksDir}/${gcsName}.align.json`);
        }
        newHashToFile[hash] = gcsName;

        if (c < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
      }

      console.log(`    ${chunks.length} chunks: ${regeneratedCount} generated, ${reusedCount} reused`);

      // Clean up stale chunks in GCS — remove hashes no longer in use
      const activeHashes = new Set(Object.values(newHashToFile));
      for (const [oldHash, oldFile] of Object.entries(existingHashMap)) {
        if (!activeHashes.has(oldFile)) {
          try { await bucket.file(`${gcsChunksDir}/${oldFile}.mp3`).delete(); } catch { /* already gone */ }
          try { await bucket.file(`${gcsChunksDir}/${oldFile}.align.json`).delete(); } catch { /* already gone */ }
        }
      }

      // Concatenate all chunks into final chapter MP3
      const outputPath = join(tmpDir, `${slug}.mp3`);
      if (chunkPaths.length === 1) {
        copyFileSync(chunkPaths[0], outputPath);
      } else {
        console.log(`    Concatenating ${chunkPaths.length} chunks with ${CHUNK_GAP_SECONDS}s gaps...`);
        concatenateChunks(chunkPaths, outputPath, tmpDir);
      }

      // Get duration
      let duration = 0;
      try {
        const probe = execSync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`,
          { encoding: 'utf-8' }
        );
        duration = Math.round(parseFloat(probe.trim()));
      } catch { /* fallback to 0 */ }
      console.log(`    Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);

      // Upload final chapter MP3
      await uploadToGCS(outputPath, `audio/${bookSlugPath}/${slug}.mp3`);

      // Build sentence-level timestamps from ElevenLabs character alignments
      const sentences = item.sentences || [];
      if (sentences.length > 0) {
        // Get per-chunk durations via ffprobe
        const chunkDurations = [];
        for (const cp of chunkPaths) {
          try {
            const probe = execSync(
              `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${cp}"`,
              { encoding: 'utf-8' }
            );
            chunkDurations.push(parseFloat(probe.trim()));
          } catch {
            // Estimate from total duration proportionally
            chunkDurations.push(duration / chunks.length);
          }
        }

        const timestamps = buildTimestampsFromAlignments(
          chunkAlignments, chunks, chunkDurations, sentences, CHUNK_GAP_SECONDS
        );
        const tsPath = join(tmpDir, `${slug}.timestamps.json`);
        writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));
        await uploadToGCS(tsPath, `audio/${bookSlugPath}/${slug}.timestamps.json`);
        console.log(`    Timestamps: ${timestamps.segments.length} segments (from ElevenLabs alignment)`);
      }

      // Upload TTS JSON
      const ttsJsonPath = join(tmpDir, `${slug}.tts.json`);
      writeFileSync(ttsJsonPath, JSON.stringify({
        name: item.chapterName,
        blocks: item.ttsBlocks,
        plainText: item.plainText,
        chunks: chunks.length,
      }, null, 2));
      await uploadToGCS(ttsJsonPath, `audio/${bookSlugPath}/${slug}.tts.json`);

      sessionResults.push({
        sessionFile: item.sessionFile,
        audioFile: `${slug}.mp3`,
        ttsFile: `${slug}.tts.json`,
        timestampsFile: `${slug}.timestamps.json`,
        contentHash: item.contentHash,
        hashToFile: newHashToFile,
        chunkCount: chunks.length,
        chunksRegenerated: regeneratedCount,
        chunksReused: reusedCount,
        durationSeconds: duration,
        characterCount: item.plainText.length,
        generatedAt: new Date().toISOString(),
      });
    }

    await updateManifest(bookSlugPath, bookRepoPath, sessionResults);

    const totalDuration = sessionResults.reduce((s, r) => s + r.durationSeconds, 0);
    const totalChars = sessionResults.reduce((s, r) => s + r.characterCount, 0);
    const totalRegen = sessionResults.reduce((s, r) => s + r.chunksRegenerated, 0);
    const totalReused = sessionResults.reduce((s, r) => s + r.chunksReused, 0);
    console.log(`\n  Done: ${sessionResults.length} sessions, ${totalChars.toLocaleString()} chars, ${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s total`);
    console.log(`  Chunks: ${totalRegen} generated, ${totalReused} reused`);

    grandTotalChars += totalChars;
    grandTotalDuration += totalDuration;
    grandTotalRegen += totalRegen;
    grandTotalReused += totalReused;
    grandTotalSessions += sessionResults.length;
  }

  // Snapshot credits after generation
  const creditsAfter = await getCredits();
  const creditsUsed = (creditsBefore && creditsAfter)
    ? creditsBefore.remaining - creditsAfter.remaining
    : null;

  console.log('\n[AUDIT] ═══════════════════════════════════════════');
  console.log(`[AUDIT] Trigger: ${triggerEvent} | Book filter: ${bookFilter} | Force: ${forceRegen}`);
  if (creditsBefore && creditsAfter) {
    console.log(`[AUDIT] Credits: ${creditsBefore.remaining.toLocaleString()} → ${creditsAfter.remaining.toLocaleString()} (${creditsUsed.toLocaleString()} used)`);
  } else {
    console.log(`[AUDIT] Credits: unable to query (API key may lack permission)`);
  }
  console.log(`[AUDIT] Sessions: ${grandTotalSessions} | Characters: ${grandTotalChars.toLocaleString()} | Audio: ${Math.floor(grandTotalDuration / 60)}m ${grandTotalDuration % 60}s`);
  console.log(`[AUDIT] Chunks: ${grandTotalRegen} generated, ${grandTotalReused} reused`);
  console.log('[AUDIT] ═══════════════════════════════════════════');

  console.log('\nGeneration complete!');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
