/**
 * realign.js — Re-run Whisper alignment on existing audio without regenerating.
 *
 * Scans the Resources repo for audiobook-enabled books, checks GCS for
 * existing manifests, builds a work file with session data, and delegates
 * to align.js. No ElevenLabs credits used — only Whisper on CPU.
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

async function main() {
  const seriesPath = join(RESOURCES_PATH, 'series');
  const allBooks = findBooks(seriesPath);
  const workItems = [];

  for (const bookRelPath of allBooks) {
    const bookFullPath = join(seriesPath, bookRelPath);
    const bookRepoPath = `series/${bookRelPath}`;

    if (BOOK_FILTER && !bookRepoPath.includes(BOOK_FILTER)) continue;

    const metaPath = join(bookFullPath, 'meta.json');
    if (!existsSync(metaPath)) continue;

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (!meta.audiobook || !meta.audiobook.enabled) continue;

    const skipSessions = new Set(meta.audiobook.skip_sessions || []);
    const voiceId = meta.audiobook.voice_id || 'default';
    const bookSlugPath = bookRepoPathToSlugPath(bookRepoPath);

    // Check manifest exists
    let manifest;
    try {
      const [contents] = await bucket.file(`audio/${bookSlugPath}/manifest.json`).download();
      manifest = JSON.parse(contents.toString());
    } catch {
      console.log(`[realign] No manifest for ${bookRepoPath}, skipping.`);
      continue;
    }

    console.log(`[realign] Book: ${bookRepoPath} (${manifest.sessions.length} sessions with audio)`);

    const sessionsDir = join(bookFullPath, 'sessions');

    for (const ms of manifest.sessions) {
      if (skipSessions.has(ms.sessionFile)) continue;

      const mdPath = join(sessionsDir, ms.sessionFile);
      if (!existsSync(mdPath)) {
        console.log(`[realign]   ${ms.sessionFile} — source not found, skipping`);
        continue;
      }

      const markdown = readFileSync(mdPath, 'utf-8');
      const chapter = preprocessSession(markdown, voiceId, meta.language || 'en', meta.audiobook?.language_normalization === true);

      console.log(`[realign]   ${ms.sessionFile} — ${chapter.blocks.length} blocks`);

      workItems.push({
        bookRepoPath,
        bookSlugPath,
        sessionFile: ms.sessionFile,
        ttsBlocks: chapter.blocks,
        sentences: chapter.sentences,
      });
    }
  }

  if (workItems.length === 0) {
    console.log('[realign] No sessions to realign.');
    return;
  }

  console.log(`\n[realign] ${workItems.length} session(s) to realign. Delegating to align.js...\n`);

  // Write work file and run align.js
  const workFilePath = join(process.env.RUNNER_TEMP || '/tmp', 'realign_sessions.json');
  writeFileSync(workFilePath, JSON.stringify(workItems));

  execSync(`node src/align.js`, {
    stdio: 'inherit',
    env: { ...process.env, GCS_BUCKET, WORK_FILE: workFilePath },
  });
}

main().catch(err => {
  console.error('[realign] Failed:', err);
  process.exit(1);
});
