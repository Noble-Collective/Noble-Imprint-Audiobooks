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
 * Split text into chunks at paragraph boundaries.
 */
function chunkText(plainText, maxChars = CHUNK_SIZE) {
  const paragraphs = plainText.split('\n\n').filter(p => p.trim());
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

  // Handle oversized paragraphs — split on sentence boundaries
  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      finalChunks.push(chunk);
    } else {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let sub = '';
      for (const sentence of sentences) {
        if (sub.length + sentence.length + 1 > maxChars && sub) {
          finalChunks.push(sub.trim());
          sub = sentence;
        } else {
          sub += (sub ? ' ' : '') + sentence;
        }
      }
      if (sub.trim()) finalChunks.push(sub.trim());
    }
  }
  return finalChunks;
}

function hashChunk(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Call ElevenLabs TTS with timestamps for a single text chunk.
 * Returns { audio: Buffer, alignment: { characters, character_start_times_seconds, character_end_times_seconds } }
 */
async function generateChunk(text, voiceId, modelId, voiceSettings, outputFormat) {
  const res = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}/with-timestamps?output_format=${outputFormat || 'mp3_44100_128'}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: modelId || 'eleven_multilingual_v2',
        voice_settings: voiceSettings || { stability: 0.71, similarity_boost: 0.5, style: 0.0 },
      }),
    }
  );
  if (res.status === 429) throw Object.assign(new Error('Rate limited'), { status: 429 });
  if (!res.ok) throw new Error(`TTS failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return {
    audio: Buffer.from(data.audio_base64, 'base64'),
    alignment: data.alignment || null,
  };
}

async function generateWithRetry(text, voiceId, modelId, voiceSettings, outputFormat, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await generateChunk(text, voiceId, modelId, voiceSettings, outputFormat);
    } catch (err) {
      if (err.status === 429 && i < retries - 1) {
        const wait = Math.pow(4, i + 1) * 1000;
        console.log(`    Rate limited, waiting ${wait / 1000}s...`);
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
function buildTimestampsFromAlignments(chunkAlignments, chunkTexts, chunkDurations, sentences) {
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

    chapterOffset += chunkDurations[c] + CHUNK_GAP_SECONDS;
  }

  // Now map sentences to character positions in the plain text.
  // The plain text = blocks joined by \n\n. Sentences have blockIndex + sentenceIndex.
  // We need to find each sentence's start/end character position in the concatenated
  // chunk text (which is the same as plain text but possibly with \n\n for the
  // paragraph break we added after numbered starts like "103.\n\n").
  const fullText = chunkTexts.join('\n\n');

  const segments = [];
  let searchFrom = 0;

  for (const sent of sentences) {
    // Find the sentence text in the full concatenated text
    const idx = fullText.indexOf(sent.text, searchFrom);
    if (idx < 0) {
      // Sentence not found — use proportional estimate
      const proportion = segments.length / Math.max(sentences.length, 1);
      const totalDuration = chapterOffset - CHUNK_GAP_SECONDS; // remove last gap
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

const CHUNK_GAP_SECONDS = 0.5; // silence between chunks (paragraph break pause)

function concatenateChunks(chunkPaths, outputPath, tmpDir) {
  // Generate a silent MP3 gap to insert between chunks
  const gapPath = join(tmpDir, '_silence.mp3');
  execSync(
    `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${CHUNK_GAP_SECONDS} -c:a libmp3lame -b:a 128k "${gapPath}" -y`,
    { stdio: 'pipe' }
  );

  // Build concat list: chunk, gap, chunk, gap, ..., chunk (no trailing gap)
  const listPath = outputPath + '.concat.txt';
  const entries = [];
  for (let i = 0; i < chunkPaths.length; i++) {
    entries.push(`file '${chunkPaths[i]}'`);
    if (i < chunkPaths.length - 1) {
      entries.push(`file '${gapPath}'`);
    }
  }
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
 * Load existing chunk hashes from the manifest for a session.
 */
function getExistingChunkHashes(manifest, sessionFile) {
  if (!manifest) return {};
  const session = manifest.sessions.find(s => s.sessionFile === sessionFile);
  if (!session || !session.chunkHashes) return {};
  // chunkHashes: { "0": "abc123", "1": "def456", ... }
  return session.chunkHashes;
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

  if (workItems.length === 0) {
    console.log('No work to do.');
    return;
  }

  const bookGroups = {};
  for (const item of workItems) {
    if (!bookGroups[item.bookRepoPath]) bookGroups[item.bookRepoPath] = [];
    bookGroups[item.bookRepoPath].push(item);
  }

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
      const slug = item.sessionFile.replace('.md', '').toLowerCase();
      const voiceId = (meta.voice_test_map && meta.voice_test_map[item.sessionFile]) || meta.voice_id;
      console.log(`\n  Chapter: ${item.chapterName} (${item.sessionFile})`);
      console.log(`    Voice: ${voiceId}`);

      // Chunk the plain text and hash each chunk
      const chunks = chunkText(item.plainText);
      const chunkHashes = {};
      for (let c = 0; c < chunks.length; c++) {
        chunkHashes[c] = hashChunk(chunks[c]);
      }

      // Compare against existing chunk hashes
      const existingHashes = getExistingChunkHashes(existingManifest, item.sessionFile);
      const gcsChunksDir = `audio/${bookSlugPath}/chunks/${slug}`;

      let regeneratedCount = 0;
      let reusedCount = 0;
      const chunkPaths = [];
      const chunkAlignments = [];

      for (let c = 0; c < chunks.length; c++) {
        const chunkPath = join(tmpDir, `${slug}_chunk_${String(c).padStart(3, '0')}.mp3`);
        const chunkAlignPath = join(tmpDir, `${slug}_chunk_${String(c).padStart(3, '0')}.align.json`);
        chunkPaths.push(chunkPath);

        // Check if this chunk's content is unchanged AND the chunk MP3 exists in GCS
        if (existingHashes[String(c)] === chunkHashes[c]) {
          try {
            await downloadFromGCS(`${gcsChunksDir}/${String(c).padStart(3, '0')}.mp3`, chunkPath);
            // Try to download cached alignment
            try {
              await downloadFromGCS(`${gcsChunksDir}/${String(c).padStart(3, '0')}.align.json`, chunkAlignPath);
              chunkAlignments.push(JSON.parse(readFileSync(chunkAlignPath, 'utf-8')));
            } catch {
              chunkAlignments.push(null); // no cached alignment — will estimate
            }
            reusedCount++;
            continue;
          } catch {
            // Chunk file missing in GCS — regenerate
          }
        }

        // Generate this chunk with timestamps
        console.log(`    Chunk ${c + 1}/${chunks.length} (${chunks[c].length} chars) — generating...`);
        const result = await generateWithRetry(
          chunks[c], voiceId, meta.model_id, meta.voice_settings,
          meta.output_format || 'mp3_44100_128'
        );
        writeFileSync(chunkPath, result.audio);
        chunkAlignments.push(result.alignment);
        regeneratedCount++;

        // Upload individual chunk + alignment to GCS for future reuse
        await uploadToGCS(chunkPath, `${gcsChunksDir}/${String(c).padStart(3, '0')}.mp3`);
        if (result.alignment) {
          writeFileSync(chunkAlignPath, JSON.stringify(result.alignment));
          await uploadToGCS(chunkAlignPath, `${gcsChunksDir}/${String(c).padStart(3, '0')}.align.json`);
        }

        if (c < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
      }

      console.log(`    ${chunks.length} chunks: ${regeneratedCount} generated, ${reusedCount} reused`);

      // Clean up stale chunks in GCS (if chunk count decreased)
      if (existingHashes) {
        const oldCount = Object.keys(existingHashes).length;
        for (let c = chunks.length; c < oldCount; c++) {
          try {
            await bucket.file(`${gcsChunksDir}/${String(c).padStart(3, '0')}.mp3`).delete();
          } catch { /* already gone */ }
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
          chunkAlignments, chunks, chunkDurations, sentences
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
        chunkHashes,
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
  }

  console.log('\nGeneration complete!');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
