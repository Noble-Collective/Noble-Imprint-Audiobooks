/**
 * generate.js — Generate audiobook audio via ElevenLabs Studio API.
 *
 * Reads work items from detect-changes.js output, creates/updates Studio
 * projects, triggers conversion, downloads audio, uploads to GCS.
 *
 * Environment:
 *   ELEVENLABS_API_KEY - ElevenLabs API key
 *   GCS_BUCKET - GCS bucket name
 *   RESOURCES_PATH - path to checked-out Resources repo
 *   RESOURCES_TOKEN - GitHub PAT for committing project_id back
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Storage } from '@google-cloud/storage';

const API_BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = process.env.ELEVENLABS_API_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const RESOURCES_PATH = process.env.RESOURCES_PATH || '../Noble-Imprint-Resources';
const RESOURCES_TOKEN = process.env.RESOURCES_TOKEN || '';
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const storage = new Storage();
const bucket = storage.bucket(GCS_BUCKET);

function headers(contentType = 'application/json') {
  return {
    'xi-api-key': API_KEY,
    'Content-Type': contentType,
  };
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(path, body, isMultipart = false) {
  const opts = { method: 'POST' };
  if (isMultipart) {
    opts.headers = { 'xi-api-key': API_KEY };
    opts.body = body; // FormData
  } else {
    opts.headers = headers();
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) throw Object.assign(new Error(`Rate limited: ${errText}`), { status: 429 });
    throw new Error(`POST ${path}: ${res.status} ${errText}`);
  }
  return res;
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (err.status === 429 && i < retries - 1) {
        const wait = Math.pow(4, i + 1) * 1000; // 4s, 16s, 64s
        console.log(`  Rate limited, waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else throw err;
    }
  }
}

/**
 * Create a new Studio project with all chapters.
 */
async function createProject(bookMeta, chapters, bookTitle) {
  console.log(`Creating Studio project: ${bookTitle}`);
  const body = {
    name: bookTitle,
    from_content_json: JSON.stringify(chapters),
    quality_preset: bookMeta.quality_preset || 'high',
    volume_normalization: true,
    auto_convert: true,
    default_paragraph_voice_id: bookMeta.voice_id,
    default_model_id: bookMeta.model_id || 'eleven_multilingual_v2',
    title: bookTitle,
  };

  // Studio create requires multipart/form-data
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) {
    formData.append(key, typeof value === 'boolean' ? String(value) : value);
  }

  const res = await withRetry(() => apiPost('/studio/projects', formData, true));
  const data = await res.json();
  console.log(`  Project created: ${data.project_id}`);
  return data;
}

/**
 * Poll project until conversion is complete.
 */
async function pollUntilReady(projectId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const project = await apiGet(`/studio/projects/${projectId}`);

    if (project.can_be_downloaded) {
      console.log(`  Conversion complete!`);
      return project;
    }

    const progress = project.chapters
      ? project.chapters.map(c => `${c.name}: ${Math.round((c.conversion_progress || 0) * 100)}%`).join(', ')
      : project.state;
    console.log(`  Status: ${project.state} — ${progress}`);

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Conversion timed out after ${POLL_TIMEOUT_MS / 60000} minutes`);
}

/**
 * Download project archive (ZIP) and extract chapter MP3s.
 */
async function downloadArchive(projectId, outputDir) {
  // Get latest snapshot
  const snapshots = await apiGet(`/studio/projects/${projectId}/snapshots`);
  if (!snapshots.snapshots || snapshots.snapshots.length === 0) {
    throw new Error('No snapshots available');
  }
  const snapshotId = snapshots.snapshots[0].project_snapshot_id;
  console.log(`  Downloading archive (snapshot: ${snapshotId})...`);

  const res = await fetch(`${API_BASE}/studio/projects/${projectId}/snapshots/${snapshotId}/archive`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ convert_to_mpeg: true }),
  });
  if (!res.ok) throw new Error(`Archive download failed: ${res.status}`);

  const zipPath = join(outputDir, 'archive.zip');
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buffer);
  console.log(`  Archive saved: ${zipPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

  // Extract ZIP
  execSync(`unzip -o "${zipPath}" -d "${outputDir}"`, { stdio: 'pipe' });
  console.log(`  Extracted to ${outputDir}`);

  return snapshotId;
}

/**
 * Upload a file to GCS.
 */
async function uploadToGCS(localPath, gcsPath) {
  await bucket.upload(localPath, { destination: gcsPath });
  console.log(`  Uploaded: gs://${GCS_BUCKET}/${gcsPath}`);
}

/**
 * Commit project_id back to the Resources repo meta.json via GitHub API.
 */
async function commitProjectId(bookRepoPath, projectId) {
  if (!RESOURCES_TOKEN) {
    console.log('  Skipping project_id commit (no RESOURCES_TOKEN)');
    return;
  }

  const metaRepoPath = `${bookRepoPath}/meta.json`;
  const apiUrl = `https://api.github.com/repos/Noble-Collective/Noble-Imprint-Resources/contents/${encodeURIComponent(metaRepoPath)}`;

  // Get current file (need SHA for update)
  const getRes = await fetch(apiUrl, {
    headers: { Authorization: `token ${RESOURCES_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
  });
  if (!getRes.ok) throw new Error(`Failed to get meta.json: ${getRes.status}`);
  const fileData = await getRes.json();
  const currentContent = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf-8'));

  // Update project_id
  currentContent.audiobook.project_id = projectId;
  const newContent = Buffer.from(JSON.stringify(currentContent, null, 2) + '\n').toString('base64');

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `token ${RESOURCES_TOKEN}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Set audiobook project_id for ${currentContent.title}`,
      content: newContent,
      sha: fileData.sha,
    }),
  });
  if (!putRes.ok) throw new Error(`Failed to commit project_id: ${putRes.status}`);
  console.log(`  Committed project_id to ${metaRepoPath}`);
}

/**
 * Build or update manifest in GCS.
 */
async function updateManifest(bookSlugPath, bookRepoPath, projectId, sessions) {
  const manifestPath = `audio/${bookSlugPath}/manifest.json`;

  // Try to load existing manifest
  let manifest;
  try {
    const [contents] = await bucket.file(manifestPath).download();
    manifest = JSON.parse(contents.toString());
  } catch {
    manifest = { bookPath: bookRepoPath, projectId, sessions: [], totalDurationSeconds: 0 };
  }

  manifest.projectId = projectId;

  // Update/add session entries
  for (const s of sessions) {
    const idx = manifest.sessions.findIndex(e => e.sessionFile === s.sessionFile);
    if (idx >= 0) {
      manifest.sessions[idx] = s;
    } else {
      manifest.sessions.push(s);
    }
  }

  // Sort by filename
  manifest.sessions.sort((a, b) => a.sessionFile.localeCompare(b.sessionFile));
  manifest.totalDurationSeconds = manifest.sessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);

  const tmpPath = join('/tmp', 'manifest.json');
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  await uploadToGCS(tmpPath, manifestPath);
  return manifest;
}

async function main() {
  // Load work items
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
    console.log(`  ${items.length} session(s) to generate`);

    let projectId = meta.project_id;

    if (!projectId) {
      // First run — create project with ALL chapters (not just changed ones)
      // Read all non-skipped sessions to build full project
      const seriesPath = join(RESOURCES_PATH, 'series');
      const sessionsDir = join(seriesPath, bookRepoPath.replace('series/', ''), 'sessions');
      const skipSessions = new Set(meta.skip_sessions || []);
      const { readdirSync: rd } = await import('node:fs');
      const allFiles = rd(sessionsDir).filter(f => f.endsWith('.md') && !skipSessions.has(f)).sort();
      const { preprocessSession } = await import('./preprocess-tts.js');

      const chapters = allFiles.map(file => {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        const chapter = preprocessSession(content, meta.voice_id);
        return { name: chapter.name, blocks: chapter.blocks };
      });

      const bookTitle = JSON.parse(readFileSync(join(seriesPath, bookRepoPath.replace('series/', ''), 'meta.json'), 'utf-8')).title || 'Audiobook';
      const result = await createProject(meta, chapters, bookTitle);
      projectId = result.project_id;

      await commitProjectId(bookRepoPath, projectId);
    } else {
      // Subsequent run — update only changed chapters
      // Get existing chapter list to find chapter IDs
      const chaptersRes = await apiGet(`/studio/projects/${projectId}/chapters`);
      const chapterMap = {};
      for (const ch of chaptersRes.chapters || []) {
        chapterMap[ch.name] = ch.chapter_id;
      }

      for (const item of items) {
        const chapterId = chapterMap[item.chapterName];
        if (chapterId) {
          console.log(`  Updating chapter: ${item.chapterName} (${chapterId})`);
          await withRetry(() => apiPost(`/studio/projects/${projectId}/chapters/${chapterId}`, {
            name: item.chapterName,
            content: item.ttsBlocks,
          }));
        } else {
          console.log(`  Warning: chapter "${item.chapterName}" not found in project`);
        }
      }

      // Trigger conversion
      console.log('  Triggering conversion...');
      await withRetry(() => apiPost(`/studio/projects/${projectId}/convert`, {}));
    }

    // Poll until ready
    console.log('  Waiting for conversion...');
    await pollUntilReady(projectId);

    // Download archive
    await downloadArchive(projectId, tmpDir);

    // Find and upload chapter MP3s
    const { readdirSync: readDir } = await import('node:fs');
    const extractedFiles = readDir(tmpDir).filter(f => f.endsWith('.mp3'));
    const sessionResults = [];

    for (const item of items) {
      const slug = item.sessionFile.replace('.md', '').toLowerCase();
      // Match extracted MP3 to session (Studio names chapters by their name field)
      const mp3File = extractedFiles.find(f =>
        f.toLowerCase().includes(item.chapterName.toLowerCase().replace(/\s+/g, ''))
      ) || `${slug}.mp3`;

      const mp3Path = join(tmpDir, mp3File);
      const gcsAudioPath = `audio/${bookSlugPath}/${slug}.mp3`;
      const gcsTtsPath = `audio/${bookSlugPath}/${slug}.tts.json`;

      // Upload audio
      try {
        await uploadToGCS(mp3Path, gcsAudioPath);
      } catch (err) {
        console.log(`  Warning: MP3 not found for ${item.sessionFile}: ${err.message}`);
        continue;
      }

      // Upload TTS JSON
      const ttsJsonPath = join(tmpDir, `${slug}.tts.json`);
      writeFileSync(ttsJsonPath, JSON.stringify({
        name: item.chapterName,
        blocks: item.ttsBlocks,
        plainText: item.plainText,
      }, null, 2));
      await uploadToGCS(ttsJsonPath, gcsTtsPath);

      // Get duration via ffprobe
      let duration = 0;
      try {
        const probe = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${mp3Path}"`, { encoding: 'utf-8' });
        duration = Math.round(parseFloat(probe.trim()));
      } catch { /* fallback to 0 */ }

      sessionResults.push({
        sessionFile: item.sessionFile,
        audioFile: `${slug}.mp3`,
        ttsFile: `${slug}.tts.json`,
        timestampsFile: `${slug}.timestamps.json`,
        chapterId: '',
        contentHash: item.contentHash,
        durationSeconds: duration,
        characterCount: item.plainText.length,
        generatedAt: new Date().toISOString(),
      });
    }

    // Update manifest
    await updateManifest(bookSlugPath, bookRepoPath, projectId, sessionResults);
    console.log(`  Done: ${sessionResults.length} session(s) generated`);
  }

  console.log('\nGeneration complete!');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
