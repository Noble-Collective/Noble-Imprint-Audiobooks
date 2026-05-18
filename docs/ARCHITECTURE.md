# Noble Imprint Audiobook System — Architecture

Automated audiobook generation system that converts markdown book content to narrated audio with sentence-level text synchronization.

---

## Table of Contents

- [System Overview](#system-overview)
- [End-to-End Flow](#end-to-end-flow)
- [Cross-Repo Trigger](#cross-repo-trigger)
- [Configuration](#configuration)
- [Preprocessing Pipeline](#preprocessing-pipeline)
- [Chunk-Level Change Detection](#chunk-level-change-detection)
- [ElevenLabs Integration](#elevenlabs-integration)
- [Whisper Alignment](#whisper-alignment)
- [GCS Storage](#gcs-storage)
- [Website Integration](#website-integration)
- [IAM and Secrets](#iam-and-secrets)
- [Cost](#cost)

---

## System Overview

The system spans three repositories:

| Repository | Role |
|---|---|
| **Noble-Imprint-Resources** | Content repo. Markdown files and `meta.json` per book. Push to main triggers dispatch to the other repos. |
| **Noble-Imprint-Audiobooks** | Generation tooling. Preprocessing, ElevenLabs TTS, Whisper alignment, GCS upload. |
| **Noble-Imprint-Resource-Website** | Serves audio via signed URLs. Player UI with sentence-level text highlighting. |

---

## End-to-End Flow

```
Content push to Resources repo
  |
  +-> notify-website.yml -> website cache refresh
  |
  +-> notify-audiobook.yml -> repository_dispatch -> Audiobooks repo
       |
       +-> detect changed sessions (content hash per chunk)
       |
       +-> preprocess markdown -> strip syntax, add heading periods for TTS pauses
       |
       +-> generate audio via ElevenLabs /v1/text-to-speech endpoint
       |   +-> split into ~4,500 char chunks at paragraph boundaries
       |   +-> per-chunk hash comparison -- only regenerate changed chunks
       |   +-> unchanged chunks downloaded from GCS and reused
       |   +-> all chunks concatenated with ffmpeg into chapter MP3 (0.5s silence between chunks)
       |
       +-> Whisper alignment (tiny.en model) -> sentence-level timestamps
       |
       +-> upload to GCS: MP3 + .tts.json + .timestamps.json + manifest
       |
       +-> notify website to clear audio cache
```

---

## Cross-Repo Trigger

### Resources repo: `.github/workflows/notify-audiobook.yml`

- Triggers on push to `main` when `series/**/sessions/*.md` or `series/**/meta.json` changes.
- Uses `peter-evans/repository-dispatch@v3` to fire a `content-updated` event on the Audiobooks repo.

### Audiobooks repo: `.github/workflows/generate.yml`

- Triggers on `repository_dispatch` (`content-updated`) and `workflow_dispatch` (manual).
- Manual trigger supports a `book_path` filter and a `force_regenerate` flag.

---

## Configuration

Audiobook generation is enabled per-book via `meta.json` in the Resources repo:

```json
{
  "audiobook": {
    "enabled": true,
    "project_id": null,
    "voice_id": "onwK4e9ZLuTAKqWW03F9",
    "voice_test_map": { "02-ChapterOne.md": "voice_id_1" },
    "model_id": "eleven_multilingual_v2",
    "quality_preset": "high",
    "voice_settings": {
      "stability": 0.71,
      "similarity_boost": 0.5,
      "style": 0.0,
      "speed": 0.92
    },
    "skip_sessions": ["01-FrontMatter.md", "08-Bibliography.md"],
    "pronunciation_dictionary_id": null
  }
}
```

| Field | Purpose |
|---|---|
| `enabled` | Master switch for the book. |
| `project_id` | Reserved (unused). |
| `voice_id` | Default ElevenLabs voice for all sessions. |
| `voice_test_map` | Per-session voice overrides for A/B testing. |
| `model_id` | ElevenLabs model. `eleven_multilingual_v2` is current. |
| `quality_preset` | ElevenLabs quality setting (`high`). |
| `voice_settings` | Stability, similarity boost, style, and speed parameters. |
| `skip_sessions` | Session files to exclude from generation (front matter, bibliography, etc.). |
| `pronunciation_dictionary_id` | Optional ElevenLabs pronunciation dictionary. |

---

## Preprocessing Pipeline

**File:** `preprocess-tts.js`

Transforms markdown into clean spoken text suitable for TTS:

| Markdown construct | Transformation |
|---|---|
| Headings (`# ...`) | Heading text with period appended (produces a TTS pause). |
| Bold/italic markers (`**`, `*`, `_`) | Stripped. |
| `<Question>` tags | Tags stripped, inner content kept (read aloud). |
| `<Callout>` tags | Tags stripped, inner content kept. |
| Blockquote markers (`>`) | Stripped. |
| Attribution markers (`<<`) | Scripture references converted to spoken form (e.g., "First Peter, chapter 2, verse 24."). |
| `<sup>`, `<br>` tags | Stripped. |
| Greek text | Stripped (only appears in skipped front matter). |
| Tables, links, images | Stripped. |
| Paragraphs | Grouped into blocks. |

---

## Chunk-Level Change Detection

Each chapter is split into chunks of approximately 4,500 characters at paragraph boundaries. Each chunk is assigned a SHA-256 hash (first 16 hex characters).

On subsequent runs:

1. Preprocess the markdown.
2. Split into chunks and hash each chunk.
3. Compare against `chunkHashes` in the existing GCS manifest.
4. Only regenerate chunks whose hash has changed.
5. Download unchanged chunks from GCS.
6. Re-concatenate all chunks into the chapter MP3 with ffmpeg. A 0.5-second silence gap is inserted between chunks during concatenation to produce natural pauses at paragraph boundaries.

**Example:** A typo fix in a 47K-character chapter (12 chunks) regenerates only the 1 affected chunk (~4.5K characters) instead of the full 47K.

---

## ElevenLabs Integration

Uses the standard TTS endpoint:

```
POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
```

Request body includes `voice_settings` and `model_id` from the book's `meta.json` configuration.

**Plan:** Pro plan with Impact Program (600K credits/month).

**Rate limiting:** 3 retries with exponential backoff (4s, 16s, 64s). A 500ms pause is inserted between chunk requests.

**Note:** The Studio/Projects API requires an Enterprise plan (not available). Standard TTS with chunking produces identical quality. The system handles splitting and concatenation itself.

---

## Whisper Alignment

After audio generation, OpenAI Whisper runs on each chapter MP3 to produce word-level timestamps. These are then mapped back to our source sentences by `align.js`.

- **Model:** `tiny.en`
- **Installation:** `pip install openai-whisper`
- **Whisper output:** Word-level timestamps from the audio.
- **Preprocessor output:** Source sentences with `blockIndex` (which content block in the DOM) and `sentenceIndex` (which sentence within that block).
- **align.js:** Maps Whisper word timing onto the preprocessor's source sentences. Each output segment contains our exact source text (not Whisper's transcription) paired with Whisper's timing, plus the `blockIndex` and `sentenceIndex` needed for DOM lookup.
- **Storage:** `.timestamps.json` files in GCS.
- **Consumer:** The website player uses these timestamps for sentence-level text highlighting.
- **Performance:** Approximately 2 minutes per chapter on GitHub Actions CPU.

---

## GCS Storage

**Bucket:** `noble-imprint-audiobooks`
**GCP project:** `noble-imprint-website`
**Region:** `us-central1`
**Access:** Uniform bucket-level IAM. NOT public. Served via 1-hour signed URLs.
**CORS:** Configured for `resources.noblecollective.org` and `localhost:8080`.

### Directory Structure

```
noble-imprint-audiobooks/audio/{slugified-book-path}/
  manifest.json
  02-chapterone.mp3
  02-chapterone.tts.json              <- preprocessed text sent to ElevenLabs (debug)
  02-chapterone.timestamps.json       <- Whisper sentence-level timestamps
  chunks/02-chapterone/
    000.mp3                            <- individual chunk audio (for reuse)
    001.mp3
    ...
```

### Manifest Format

```json
{
  "bookPath": "series/A Library of Classics/A Pastoral Shelf/Oration II",
  "sessions": [
    {
      "sessionFile": "02-ChapterOne.md",
      "audioFile": "02-chapterone.mp3",
      "ttsFile": "02-chapterone.tts.json",
      "timestampsFile": "02-chapterone.timestamps.json",
      "contentHash": "sha256:...",
      "chunkHashes": { "0": "abc123", "1": "def456" },
      "chunkCount": 4,
      "durationSeconds": 1158,
      "characterCount": 14824,
      "generatedAt": "2026-05-17T..."
    }
  ],
  "totalDurationSeconds": 11358
}
```

### Timestamps Format

Each segment contains the original source text, Whisper-derived timing, and positional indices for DOM lookup:

```json
{
  "segments": [
    { "start": 0.0, "end": 3.2, "blockIndex": 0, "sentenceIndex": 0, "text": "Chapter One." },
    { "start": 3.5, "end": 8.1, "blockIndex": 1, "sentenceIndex": 0, "text": "Section 1: Gregory Addresses His Flight from Ministry." },
    { "start": 11.97, "end": 17.72, "blockIndex": 3, "sentenceIndex": 0, "text": "Gregory has yielded to the Lord's calling..." }
  ]
}
```

---

## Website Integration

### Server (`src/server/audio.js`)

| Function | Purpose |
|---|---|
| `getAudioManifest(bookRepoPath)` | Fetches manifest from GCS. Cached for 5 minutes. |
| `getSignedUrl(bookRepoPath, filename)` | Generates a 1-hour signed URL for an audio/metadata file. |

**Routes:**

- `GET /api/audio/manifest/*` — returns the manifest for a book.
- `GET /api/audio/url/*` — returns a signed URL for a specific file.
- `POST /api/refresh-audio` — clears the audio manifest cache.

### Player (`src/public/js/audio-player.js`)

**UI:**

- Floating headphones icon (bottom-right corner).
- Expands to a sticky bottom bar when playing.
- Controls: play/pause, scrubber, speed (0.75x--1.5x), skip forward/back 15s, close (X).
- FAB hides when the player bar is visible (no overlap).

**Sentence-level text highlighting:**

1. Fetches `.timestamps.json` via signed URL on first play.
2. Uses `blockIndex` to find the target DOM element by counting content blocks (no text matching needed).
3. Uses `sentenceIndex` to locate the specific sentence within that block.
4. A `requestAnimationFrame` loop tracks `audio.currentTime`.
5. Uses `Range.getClientRects()` to measure the sentence position, then positions transparent overlay divs for the highlight (no DOM modification -- the document text is never wrapped or altered).
6. Smooth-scrolls to the highlighted sentence. Pauses auto-scroll for 5 seconds if the user scrolls manually.

**Auto-advance:** Navigates to the next chapter when audio ends. Auto-plays via a `localStorage` flag.

**Resume:** Saves playback position to `localStorage` and restores it on page load.

**Book page:** Displays an audiobook badge with total duration when a manifest exists.

**Branding:** ElevenLabs logo displayed in the footer per Impact Program requirements.

---

## IAM and Secrets

### GCS Bucket IAM

| Principal | Roles |
|---|---|
| Cloud Run SA (`471081269328-compute@`) | `roles/storage.objectViewer` + `roles/iam.serviceAccountTokenCreator` |
| CI Deploy SA (`ci-deploy@noble-imprint-website`) | `roles/storage.objectAdmin` |

### GitHub Secrets — Audiobooks Repo

| Secret | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs API authentication. |
| `GCP_SA_KEY` | `ci-deploy` service account JSON key. |
| `RESOURCES_TOKEN` | PAT with `repo` scope. Reads the Resources repo and commits `project_id`. |

### GitHub Secrets — Resources Repo

| Secret | Purpose |
|---|---|
| `AUDIOBOOK_DISPATCH_TOKEN` | Same PAT. Triggers `repository_dispatch` on the Audiobooks repo. |

---

## Cost

Reference data point: first book (Oration II) -- approximately 153K characters, 3.2 hours of audio, 41 chunks.

| Resource | Cost |
|---|---|
| **ElevenLabs** | ~7.6% of the 2M monthly Pro quota, or ~25% of the 600K Impact quota. |
| **GCS storage** | ~180 MB, approximately $0.004/month. |
| **Whisper on GitHub Actions** | ~10 minutes CPU time (free tier). |
| **Per-edit regeneration** | ~4.5K characters (1 chunk) = negligible. |
