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
 * Call ElevenLabs TTS for a single text chunk. Returns MP3 buffer.
 */
async function generateChunk(text, voiceId, modelId, voiceSettings, outputFormat) {
  const res = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}?output_format=${outputFormat || 'mp3_44100_128'}`,
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
  return Buffer.from(await res.arrayBuffer());
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

      for (let c = 0; c < chunks.length; c++) {
        const chunkPath = join(tmpDir, `${slug}_chunk_${String(c).padStart(3, '0')}.mp3`);
        chunkPaths.push(chunkPath);

        // Check if this chunk's content is unchanged AND the chunk MP3 exists in GCS
        if (existingHashes[String(c)] === chunkHashes[c]) {
          try {
            await downloadFromGCS(`${gcsChunksDir}/${String(c).padStart(3, '0')}.mp3`, chunkPath);
            reusedCount++;
            continue;
          } catch {
            // Chunk file missing in GCS — regenerate
          }
        }

        // Generate this chunk
        console.log(`    Chunk ${c + 1}/${chunks.length} (${chunks[c].length} chars) — generating...`);
        const mp3Buffer = await generateWithRetry(
          chunks[c], voiceId, meta.model_id, meta.voice_settings,
          meta.output_format || 'mp3_44100_128'
        );
        writeFileSync(chunkPath, mp3Buffer);
        regeneratedCount++;

        // Upload individual chunk to GCS for future reuse
        await uploadToGCS(chunkPath, `${gcsChunksDir}/${String(c).padStart(3, '0')}.mp3`);

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
