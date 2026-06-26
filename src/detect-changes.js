/**
 * detect-changes.js — Detect which audiobook sessions need regeneration.
 *
 * Scans the Resources repo for books with audiobook.enabled, preprocesses
 * each session, hashes the TTS text, and compares against the GCS manifest.
 * Outputs a JSON list of sessions needing work.
 *
 * Environment:
 *   RESOURCES_PATH - path to checked-out Resources repo
 *   GCS_BUCKET - GCS bucket name
 *   FORCE_REGENERATE - "true" to skip hash comparison
 *   BOOK_PATH_FILTER - optional book path to limit scope
 *
 * Sets GitHub Actions outputs:
 *   has_work - "true" if any sessions need regeneration
 *   changed_sessions - JSON array of work items
 */

import { readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { preprocessSession } from './preprocess-tts.js';

const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const FORCE = process.env.FORCE_REGENERATE === 'true';
const BOOK_FILTER = process.env.BOOK_PATH_FILTER || '';

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

/**
 * Retry an async operation with exponential backoff.
 */
async function retry(fn, { retries = 3, baseDelay = 2000, label = 'operation' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`  ${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function slugify(name) {
  return name.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function bookRepoPathToSlugPath(repoPath) {
  return repoPath.replace(/^series\//, '').split('/').map(slugify).join('/');
}

/**
 * Recursively find all book directories (those containing a sessions/ subdir).
 */
function findBooks(basePath, currentPath = '') {
  const books = [];
  const fullPath = join(basePath, currentPath);
  if (!existsSync(fullPath)) return books;

  const entries = readdirSync(fullPath, { withFileTypes: true });
  const hasSessionsDir = entries.some(e => e.isDirectory() && e.name === 'sessions');

  if (hasSessionsDir) {
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

/**
 * Load manifest from GCS for a book.
 */
async function loadManifest(bookSlugPath) {
  try {
    const file = bucket.file(`audio/${bookSlugPath}/manifest.json`);
    const [contents] = await file.download();
    return JSON.parse(contents.toString());
  } catch (err) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function main() {
  const seriesPath = join(RESOURCES_PATH, 'series');
  const allBooks = findBooks(seriesPath);
  const workItems = [];

  for (const bookRelPath of allBooks) {
    const bookFullPath = join(seriesPath, bookRelPath);
    const bookRepoPath = `series/${bookRelPath}`;

    // Apply book filter if set
    if (BOOK_FILTER && !bookRepoPath.includes(BOOK_FILTER)) continue;

    // Check meta.json for audiobook config
    const metaPath = join(bookFullPath, 'meta.json');
    if (!existsSync(metaPath)) continue;

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (!meta.audiobook || !meta.audiobook.enabled) continue;

    const skipSessions = new Set(meta.audiobook.skip_sessions || []);
    const voiceId = meta.audiobook.voice_id || 'default';
    const bookSlugPath = bookRepoPathToSlugPath(bookRepoPath);

    console.log(`Checking book: ${bookRepoPath}`);

    // Load existing manifest from GCS (with retry for transient auth/network errors)
    const manifest = await retry(() => loadManifest(bookSlugPath), {
      label: `Loading manifest for ${bookRepoPath}`,
    });
    const existingHashes = {};
    if (manifest) {
      for (const s of manifest.sessions) {
        existingHashes[s.sessionFile] = s.contentHash;
      }
    }

    // Check each session
    const sessionsDir = join(bookFullPath, 'sessions');
    const sessionFiles = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.md') && !skipSessions.has(f))
      .sort();

    for (const file of sessionFiles) {
      const content = readFileSync(join(sessionsDir, file), 'utf-8');
      const chapter = preprocessSession(content, voiceId);
      const hash = `sha256:${createHash('sha256').update(chapter.plainText).digest('hex')}`;

      if (FORCE || hash !== existingHashes[file]) {
        console.log(`  ${file} — needs regeneration (${FORCE ? 'forced' : 'content changed'})`);
        workItems.push({
          bookRepoPath,
          bookSlugPath,
          sessionFile: file,
          contentHash: hash,
          meta: meta.audiobook,
          ttsBlocks: chapter.blocks,
          sentences: chapter.sentences,
          chapterName: chapter.name,
          plainText: chapter.plainText,
        });
      } else {
        console.log(`  ${file} — unchanged`);
      }
    }
  }

  // Set GitHub Actions outputs
  const hasWork = workItems.length > 0;
  console.log(`\nResult: ${workItems.length} session(s) need regeneration`);

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `has_work=${hasWork}\n`);
    // Write work items to a temp file (too large for output variable)
    const workFile = join(process.env.RUNNER_TEMP || '/tmp', 'changed_sessions.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(workFile, JSON.stringify(workItems));
    appendFileSync(outputFile, `work_file=${workFile}\n`);
  } else {
    // Local testing
    console.log(JSON.stringify(workItems.map(w => ({
      book: w.bookRepoPath,
      session: w.sessionFile,
      hash: w.contentHash,
      blocks: w.ttsBlocks.length,
    })), null, 2));
  }
}

main().catch(err => {
  console.error('Detection failed:', err);
  process.exit(1);
});
