/**
 * retimestamp.js — Rebuild timestamps from cached ElevenLabs alignment data.
 *
 * Downloads existing chunk .align.json files and chunk MP3s from GCS,
 * recalculates sentence-level timestamps using the corrected character
 * lookup, and uploads new .timestamps.json files. No ElevenLabs API calls.
 *
 * Environment:
 *   GCS_BUCKET - GCS bucket name
 *   RESOURCES_PATH - path to checked-out Resources repo
 *   BOOK_PATH_FILTER - optional book path to limit scope
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';
import { preprocessSession } from './preprocess-tts.js';

const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const BOOK_FILTER = process.env.BOOK_PATH_FILTER || '';
const CHUNK_SIZE = 4500;
const CHUNK_GAP_SECONDS = 0.5;

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

function slugify(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function bookRepoPathToSlugPath(repoPath) {
  return repoPath.replace(/^series\//, '').split('/').map(slugify).join('/');
}

function findBooks(basePath, currentPath = '') {
  const books = [];
  const fullPath = join(basePath, currentPath);
  if (!existsSync(fullPath)) return books;
  const entries = readdirSync(fullPath, { withFileTypes: true });
  if (entries.some(e => e.isDirectory() && e.name === 'sessions')) {
    books.push(currentPath);
  } else {
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'images') {
        books.push(...findBooks(basePath, join(currentPath, entry.name)));
      }
    }
  }
  return books;
}

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

function buildTimestampsFromAlignments(chunkAlignments, chunkTexts, chunkDurations, sentences) {
  const charTimes = [];
  let chapterOffset = 0;

  for (let c = 0; c < chunkAlignments.length; c++) {
    const alignment = chunkAlignments[c];
    if (!alignment || !alignment.character_start_times_seconds) {
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

  // Join without separators so char positions match charTimes indices
  const flatText = chunkTexts.join('');

  if (charTimes.length !== flatText.length) {
    console.log(`    Warning: charTimes (${charTimes.length}) != flatText (${flatText.length})`);
  }

  const segments = [];
  let searchFrom = 0;

  for (const sent of sentences) {
    const idx = flatText.indexOf(sent.text, searchFrom);
    if (idx < 0) {
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

async function main() {
  const seriesPath = join(RESOURCES_PATH, 'series');
  const allBooks = findBooks(seriesPath);
  let totalSessions = 0;

  for (const bookRelPath of allBooks) {
    const bookFullPath = join(seriesPath, bookRelPath);
    const bookRepoPath = `series/${bookRelPath}`;

    if (BOOK_FILTER && !bookRepoPath.includes(BOOK_FILTER)) continue;

    const metaPath = join(bookFullPath, 'meta.json');
    if (!existsSync(metaPath)) continue;

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (!meta.audiobook || !meta.audiobook.enabled) continue;

    const bookSlugPath = bookRepoPathToSlugPath(bookRepoPath);
    const skipSessions = new Set(meta.audiobook.skip_sessions || []);
    const voiceId = meta.audiobook.voice_id || 'default';

    // Load manifest
    let manifest;
    try {
      const [contents] = await bucket.file(`audio/${bookSlugPath}/manifest.json`).download();
      manifest = JSON.parse(contents.toString());
    } catch {
      console.log(`[retimestamp] No manifest for ${bookRepoPath}, skipping.`);
      continue;
    }

    console.log(`\n[retimestamp] Book: ${bookRepoPath} (${manifest.sessions.length} sessions)`);

    const sessionsDir = join(bookFullPath, 'sessions');

    for (const ms of manifest.sessions) {
      if (skipSessions.has(ms.sessionFile)) continue;

      const slug = ms.sessionFile.replace('.md', '').toLowerCase()
        .replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const mdPath = join(sessionsDir, ms.sessionFile);
      if (!existsSync(mdPath)) {
        console.log(`  ${ms.sessionFile} — source not found, skipping`);
        continue;
      }

      console.log(`  ${ms.sessionFile}`);

      // Preprocess to get sentences
      const markdown = readFileSync(mdPath, 'utf-8');
      const chapter = preprocessSession(markdown, voiceId);
      const sentences = chapter.sentences || [];
      const chunks = chunkText(chapter.plainText);

      console.log(`    ${chunks.length} chunks, ${sentences.length} sentences`);

      // Download chunk alignments and MP3s from GCS
      const tmpDir = join('/tmp', 'retimestamp', bookSlugPath, slug);
      mkdirSync(tmpDir, { recursive: true });

      const chunkAlignments = [];
      const chunkDurations = [];
      let missingAlignments = 0;

      for (let c = 0; c < chunks.length; c++) {
        const padded = String(c).padStart(3, '0');
        const alignPath = `audio/${bookSlugPath}/chunks/${slug}/${padded}.align.json`;
        const mp3Path = `audio/${bookSlugPath}/chunks/${slug}/${padded}.mp3`;
        const localMp3 = join(tmpDir, `${padded}.mp3`);

        // Download alignment
        try {
          const [contents] = await bucket.file(alignPath).download();
          chunkAlignments.push(JSON.parse(contents.toString()));
        } catch {
          chunkAlignments.push(null);
          missingAlignments++;
        }

        // Download MP3 for duration
        try {
          await bucket.file(mp3Path).download({ destination: localMp3 });
          const probe = execSync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${localMp3}"`,
            { encoding: 'utf-8' }
          );
          chunkDurations.push(parseFloat(probe.trim()));
        } catch {
          // Estimate from total duration
          chunkDurations.push((ms.durationSeconds || 0) / chunks.length);
        }
      }

      if (missingAlignments > 0) {
        console.log(`    ${missingAlignments} chunks missing alignment — will estimate`);
      }

      // Rebuild timestamps
      const timestamps = buildTimestampsFromAlignments(
        chunkAlignments, chunks, chunkDurations, sentences
      );

      // Upload
      const tsPath = join(tmpDir, `${slug}.timestamps.json`);
      writeFileSync(tsPath, JSON.stringify(timestamps, null, 2));
      await bucket.upload(tsPath, {
        destination: `audio/${bookSlugPath}/${slug}.timestamps.json`,
      });
      console.log(`    Uploaded: ${timestamps.segments.length} segments`);
      totalSessions++;
    }
  }

  // Clear website cache
  try {
    await fetch('https://resources.noblecollective.org/api/refresh-audio', { method: 'POST' });
    console.log('\n[retimestamp] Website cache cleared.');
  } catch {}

  console.log(`\n[retimestamp] Done! Retimestamped ${totalSessions} session(s).`);
}

main().catch(err => {
  console.error('[retimestamp] Failed:', err);
  process.exit(1);
});
