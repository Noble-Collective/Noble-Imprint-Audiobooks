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
import { usfmBookToChapters, findBookFile, parseChapterRange } from './usfm-to-markdown.js';

const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const FORCE = process.env.FORCE_REGENERATE === 'true';
const BOOK_FILTER = process.env.BOOK_PATH_FILTER || '';
const SESSION_FILTER = process.env.SESSION_FILTER || '';

// Bible-audiobook run: when BIBLE_BOOK is set, detect-changes does a BIBLE-ONLY run of
// that single book (series/ is skipped) — this is how we generate scripture "one book at
// a time" without touching regular books. See findBibleWorkItems().
const BIBLE_BOOK = process.env.BIBLE_BOOK || '';
const BIBLE_TRANSLATION = (process.env.BIBLE_TRANSLATION || 'bsb').toLowerCase();
const BIBLE_CHAPTERS = process.env.BIBLE_CHAPTERS || '';

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

/**
 * Build work items for a single Bible book from its USFM, in the same shape as the
 * series path. Converts USFM → per-chapter markdown (usfm-to-markdown.js) → preprocessed
 * blocks, and change-detects each chapter against the GCS manifest.
 *
 * Slug layout: bookSlugPath = "bible/{tx}/{book-slug}" → GCS audio/bible/{tx}/{book-slug}/.
 * Each chapter is a "session" file "NNN.md" (zero-padded chapter number) → slug "NNN".
 */
async function findBibleWorkItems(tx, code, chaptersOverride) {
  const metaPath = join(RESOURCES_PATH, 'bibles', tx, 'meta.json');
  if (!existsSync(metaPath)) { console.warn(`[bible] no meta.json for ${tx}`); return []; }
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  const ab = meta.audiobook;
  if (!ab || !ab.enabled) { console.warn(`[bible] ${tx}: audiobook not enabled in meta.json`); return []; }

  const cfg = (ab.books || {})[code] || (ab.books || {})[code.toUpperCase()];
  if (!cfg || !cfg.enabled) {
    console.warn(`[bible] ${tx}/${code}: book not enabled in meta.audiobook.books — skipping`);
    return [];
  }

  const contentDir = join(RESOURCES_PATH, 'bibles', tx, 'content');
  const file = findBookFile(contentDir, tx, code); // throws if missing — surfaced by caller
  const chapters = usfmBookToChapters(readFileSync(file, 'utf-8'));
  const bookName = chapters[0]?.bookName || code;
  const bookSlug = slugify(bookName);
  const bookRepoPath = `bibles/${tx}/${code.toUpperCase()}`;
  const bookSlugPath = `bible/${tx}/${bookSlug}`;

  const range = parseChapterRange(chaptersOverride || cfg.chapters || 'true');
  const selected = range ? chapters.filter(c => c.chapter >= range.lo && c.chapter <= range.hi) : chapters;

  console.log(`Checking bible book: ${bookRepoPath} (${bookName}) — ${selected.length} chapter(s) → ${bookSlugPath}`);

  const manifest = await retry(() => loadManifest(bookSlugPath), { label: `manifest ${bookSlugPath}` });
  const existingHashes = {};
  if (manifest) for (const s of manifest.sessions) existingHashes[s.sessionFile] = s.contentHash;

  const voiceId = ab.voice_id || 'default';
  const items = [];
  for (const ch of selected) {
    const sessionFile = `${String(ch.chapter).padStart(3, '0')}.md`;
    if (SESSION_FILTER && sessionFile !== SESSION_FILTER) continue;
    const pre = preprocessSession(ch.markdown, voiceId, meta.language || 'en', ab.language_normalization === true);
    const hash = `sha256:${createHash('sha256').update(pre.plainText).digest('hex')}`;
    if (FORCE || hash !== existingHashes[sessionFile]) {
      console.log(`  ${sessionFile} (ch ${ch.chapter}) — needs regeneration (${FORCE ? 'forced' : existingHashes[sessionFile] ? 'content changed' : 'new'})`);
      items.push({
        bookRepoPath, bookSlugPath, sessionFile,
        contentHash: hash, meta: ab,
        ttsBlocks: pre.blocks, sentences: pre.sentences,
        chapterName: pre.name, plainText: pre.plainText,
      });
    } else {
      console.log(`  ${sessionFile} — unchanged`);
    }
  }
  return items;
}

async function main() {
  const workItems = [];

  // Bible-only run: generate a single scripture book, skip the series scan entirely.
  if (BIBLE_BOOK) {
    console.log(`Bible-only run: ${BIBLE_TRANSLATION}/${BIBLE_BOOK}${BIBLE_CHAPTERS ? ` chapters ${BIBLE_CHAPTERS}` : ''}`);
    workItems.push(...await findBibleWorkItems(BIBLE_TRANSLATION, BIBLE_BOOK, BIBLE_CHAPTERS));
    return finish(workItems);
  }

  const seriesPath = join(RESOURCES_PATH, 'series');
  const allBooks = findBooks(seriesPath);

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
      .filter(f => !SESSION_FILTER || f === SESSION_FILTER)
      .sort();

    for (const file of sessionFiles) {
      const content = readFileSync(join(sessionsDir, file), 'utf-8');
      const chapter = preprocessSession(content, voiceId, meta.language || 'en', meta.audiobook?.language_normalization === true);
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

  return finish(workItems);
}

// Emit GitHub Actions outputs (or a local-testing summary) for a set of work items.
async function finish(workItems) {
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
