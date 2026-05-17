/**
 * generate.js — Generate audiobook audio via ElevenLabs standard TTS API.
 *
 * Uses the /v1/text-to-speech endpoint with chunking and ffmpeg concatenation.
 * Each chapter is split into ~4,500-char chunks at paragraph boundaries,
 * generated individually, then concatenated into a single chapter MP3.
 *
 * Environment:
 *   ELEVENLABS_API_KEY - ElevenLabs API key
 *   GCS_BUCKET - GCS bucket name
 *   RESOURCES_PATH - path to checked-out Resources repo
 *   RESOURCES_TOKEN - GitHub PAT for committing back
 *   WORK_FILE - path to changed_sessions.json from detect-changes.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';

const API_BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = process.env.ELEVENLABS_API_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const RESOURCES_TOKEN = process.env.RESOURCES_TOKEN || '';
const CHUNK_SIZE = 4500; // chars per TTS request (headroom below 5K limit)

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
      // Split on sentence endings
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

/**
 * Call ElevenLabs TTS for a single text chunk. Returns MP3 buffer.
 */
async function generateChunk(text, voiceId, modelId, voiceSettings, outputFormat) {
  const body = {
    text,
    model_id: modelId || 'eleven_multilingual_v2',
    voice_settings: voiceSettings || {
      stability: 0.71,
      similarity_boost: 0.5,
      style: 0.0,
    },
  };

  const res = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}?output_format=${outputFormat || 'mp3_44100_128'}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (res.status === 429) {
    throw Object.assign(new Error('Rate limited'), { status: 429 });
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS failed (${res.status}): ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Generate with retry logic for rate limits.
 */
async function generateWithRetry(text, voiceId, modelId, voiceSettings, outputFormat, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await generateChunk(text, voiceId, modelId, voiceSettings, outputFormat);
    } catch (err) {
      if (err.status === 429 && i < retries - 1) {
        const wait = Math.pow(4, i + 1) * 1000; // 4s, 16s, 64s
        console.log(`    Rate limited, waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Concatenate MP3 chunks into a single file using ffmpeg.
 */
function concatenateChunks(chunkPaths, outputPath) {
  const listPath = outputPath + '.concat.txt';
  const listContent = chunkPaths.map(p => `file '${p}'`).join('\n');
  writeFileSync(listPath, listContent);
  execSync(`ffmpeg -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}" -y`, { stdio: 'pipe' });
}

/**
 * Upload a file to GCS.
 */
async function uploadToGCS(localPath, gcsPath) {
  await bucket.upload(localPath, { destination: gcsPath });
  console.log(`    Uploaded: gs://${GCS_BUCKET}/${gcsPath}`);
}

/**
 * Build or update manifest in GCS.
 */
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

  // Group by book
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

    const sessionResults = [];

    for (const item of items) {
      const slug = item.sessionFile.replace('.md', '').toLowerCase();
      // Support per-chapter voice override for testing
      const voiceId = (meta.voice_test_map && meta.voice_test_map[item.sessionFile]) || meta.voice_id;
      console.log(`\n  Chapter: ${item.chapterName} (${item.sessionFile})`);
      console.log(`    Voice: ${voiceId}`);

      // Chunk the plain text
      const chunks = chunkText(item.plainText);
      console.log(`    ${item.plainText.length} chars → ${chunks.length} chunks`);

      // Generate each chunk
      const chunkPaths = [];
      for (let c = 0; c < chunks.length; c++) {
        console.log(`    Chunk ${c + 1}/${chunks.length} (${chunks[c].length} chars)...`);
        const mp3Buffer = await generateWithRetry(
          chunks[c],
          voiceId,
          meta.model_id,
          meta.voice_settings,
          meta.output_format || 'mp3_44100_128'
        );
        const chunkPath = join(tmpDir, `${slug}_chunk_${String(c).padStart(3, '0')}.mp3`);
        writeFileSync(chunkPath, mp3Buffer);
        chunkPaths.push(chunkPath);

        // Brief pause between chunks to avoid rate limits
        if (c < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // Concatenate chunks
      const outputPath = join(tmpDir, `${slug}.mp3`);
      if (chunkPaths.length === 1) {
        // Single chunk — just rename
        const { renameSync } = await import('node:fs');
        renameSync(chunkPaths[0], outputPath);
      } else {
        console.log(`    Concatenating ${chunkPaths.length} chunks...`);
        concatenateChunks(chunkPaths, outputPath);
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

      // Upload audio to GCS
      const gcsAudioPath = `audio/${bookSlugPath}/${slug}.mp3`;
      await uploadToGCS(outputPath, gcsAudioPath);

      // Upload TTS JSON for debugging
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
        durationSeconds: duration,
        characterCount: item.plainText.length,
        chunks: chunks.length,
        generatedAt: new Date().toISOString(),
      });
    }

    // Update manifest
    await updateManifest(bookSlugPath, bookRepoPath, sessionResults);

    const totalDuration = sessionResults.reduce((s, r) => s + r.durationSeconds, 0);
    const totalChars = sessionResults.reduce((s, r) => s + r.characterCount, 0);
    console.log(`\n  Done: ${sessionResults.length} sessions, ${totalChars.toLocaleString()} chars, ${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s total`);
  }

  console.log('\nGeneration complete!');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
