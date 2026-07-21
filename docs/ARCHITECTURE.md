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
- [Timestamp Alignment](#timestamp-alignment)
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
| **Noble-Imprint-Audiobooks** | Generation tooling. Preprocessing, ElevenLabs TTS with character-level timestamps, GCS upload. |
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
       +-> preprocess markdown -> strip syntax, sentence-case headings, add SSML <break> pauses
       |
       +-> generate audio via ElevenLabs /v1/text-to-speech/{voice}/with-timestamps
       |   +-> split into ~800 char chunks via linear block walk (force-split at H1/H2/H3, 250-char min)
       |   +-> per-chunk hash comparison -- only regenerate changed chunks
       |   +-> unchanged chunks downloaded from GCS and reused (with cached alignment)
       |   +-> previous_text / next_text (200 chars) sent for prosody stitching across boundaries
       |   +-> character-level timestamps returned alongside audio per chunk
       |   +-> all chunks concatenated with ffmpeg into chapter MP3 (no silence between chunks)
       |   +-> sentence timestamps built from character alignments + chunk offsets
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
- Manual trigger supports a `book_path` filter, a `session_filter` input for targeting individual chapters, and a `force_regenerate` flag.
- Concurrency group queues runs instead of cancelling in-progress ones.
- Node.js pinned to 20 (node-fetch v2 bug on Node 22).

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
| Headings (`# ...`) | Sentence-cased for TTS (proper noun whitelist). SSML `<break>` tags added (H1: 2s, H2: 1.5s, H3-H6: 1s before/after). Original display text preserved in `block.displayText`. |
| Bold/italic markers (`**`, `*`, `_`) | Stripped. |
| `<Question>` tags | Tags stripped, inner content kept (read aloud). |
| `<Callout>` tags | Tags stripped, inner content kept. |
| Blockquote markers (`>`) | Stripped. |
| Blockquote → following body paragraph | A `<break time="2s"/>` is prepended to the body paragraph for an audible transition (Seneca). The break lives only in the spoken text — it is stripped from the sentence list used for timestamps/highlighting. |
| Attribution markers (`<<`) | Scripture references converted to spoken form (e.g., "First Peter, chapter 2, verse 24."). |
| `<sup>` tags | Stripped entirely (including verse number content). |
| `<ChapterNum>` tags | Stripped entirely (tag + section number); not spoken. |
| `<br>` tags | Stripped. |
| Parenthetical verse refs | Stripped (e.g., `(v. 3)`, `(Matt 5:1)`). |
| Art/image citations | Stripped. |
| Paragraphs lacking terminal punctuation | Period appended. |
| Greek text | Stripped (only appears in skipped front matter). |
| Tables, links, images | Stripped. |
| Paragraphs | Grouped into blocks. |

### Language Normalization Layer

**File:** `languages.js` — opt-in per book via `meta.audiobook.language_normalization` (default `false`).

When enabled, scripture references and numeric ranges are expanded to natural speech (per the book's top-level `language` code) before chunking:

- **EN:** "Proverbs 1-9" → "Proverbs, chapters 1 through 9"; "Psalm 78:19-20" → "Psalm, chapter 78, verses 19 through 20".
- **FR:** "Actes 2:1-47" → "Actes, chapitre 2, versets 1 à 47".

When disabled (the default) text is spoken literally, and attributions fall back to the legacy English converter in `bible-refs.js`. The switch is per-book so the layer can be rolled out one title at a time; because it changes the spoken text, toggling it regenerates the affected chunks on the next run.

---

## Chunk-Level Change Detection

Each chapter is split into chunks of approximately 800 characters using a linear block walk. Chunks force-split at H1/H2/H3 heading boundaries with a 250-character minimum. Each chunk is assigned a SHA-256 hash (first 16 hex characters).

On subsequent runs:

1. Preprocess the markdown.
2. Split into chunks and hash each chunk.
3. Compare against `chunkHashes` in the existing GCS manifest.
4. Only regenerate chunks whose hash has changed.
5. Download unchanged chunks from GCS.
6. Re-concatenate all chunks into the chapter MP3 with ffmpeg (no silence gaps between chunks).

**Example:** A typo fix in a 47K-character chapter regenerates only the 1 affected chunk (~800 characters) instead of the full chapter.

---

## ElevenLabs Integration

Uses the TTS with timestamps endpoint:

```
POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128
```

Returns JSON with `audio_base64` (the MP3 data) and `alignment` (character-level start/end times). Request body includes `voice_settings` and `model_id` from the book's `meta.json` configuration. `previous_text` and `next_text` parameters (last/first 200 chars of adjacent chunks) are sent for natural prosody across chunk boundaries.

**Plan:** Pro plan with Impact Program (600K credits/month).

**Rate limiting:** 3 retries with exponential backoff (4s, 16s, 64s). A 500ms pause is inserted between chunk requests.

**Note:** The with-timestamps endpoint uses the same credits as the standard endpoint (billed by character count). The alignment data adds no extra cost.

---

## Timestamp Alignment

Sentence-level timestamps are generated directly by ElevenLabs using the `/text-to-speech/{voice_id}/with-timestamps` endpoint, which returns character-level timing alongside the audio. This replaces a previous Whisper-based approach.

- **Source:** ElevenLabs character-level alignment data, returned with each TTS chunk.
- **`generate.js`:** Calls the with-timestamps endpoint per chunk, collects character start/end times, then maps them to source sentences using a dual-text approach: full text (with SSML tags) for `charTimes` indexing, stripped text for sentence matching with `cleanToOriginal` position mapping. Case-insensitive matching with proximity check for duplicate sentences.
- **Per-chunk alignment:** Each chunk's character times are offset by cumulative chunk durations to produce chapter-level timestamps (no silence gaps).
- **Preprocessor output:** Source sentences with `blockIndex` (which content block in the DOM) and `sentenceIndex` (which sentence within that block).
- **Storage:** `.timestamps.json` files in GCS. Per-chunk alignment data cached as `.align.json` in the chunks directory.
- **Consumer:** The website player uses these timestamps for sentence-level text highlighting.
- **Accuracy:** Character-level precision from the TTS engine — no transcription or fuzzy matching needed. Zero gaps, ~97% coverage.

### Validation Guard

After building a session's segments, `generate.js` runs a guard that **throws before the timestamps are uploaded** (failing the run via `process.exit(1)`) if it detects either:

- a leftover SSML/custom tag (`break`, `sup`, `br`, `Question`, `Callout`, `ChapterNum`) in a sentence's text, or
- a non-monotonic / out-of-order segment start time (a >0.5s regression against the previous segment).

This blocks the class of bug where a `<break>` tag leaked into the sentence list and produced overlapping, out-of-order timestamps (which broke web-reader highlighting). A bare `<` that is not one of the above tags — e.g. a literal `<https://…>` URL in front matter — is a non-fatal warning.

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
  02-chapterone.timestamps.json       <- sentence-level timestamps (from ElevenLabs character alignment)
  chunks/02-chapterone/
    <content-hash>.mp3                 <- individual chunk audio, named by 16-char content hash (for reuse)
    <content-hash>.align.json          <- cached ElevenLabs character alignment
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

Each segment contains the original source text, ElevenLabs character-level timing, and positional indices for DOM lookup:

```json
{
  "segments": [
    { "start": 0.0, "end": 3.2, "blockIndex": 0, "sentenceIndex": 0, "text": "Chapter one" },
    { "start": 3.5, "end": 8.1, "blockIndex": 1, "sentenceIndex": 0, "text": "Section 1: Gregory addresses his flight from ministry" },
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
- Mobile: expandable player bar (tap chevron to reveal speed control and ±15s skip).
- H2 section markers on the scrubber bar — clickable tick marks at exact heading positions.
- Clickable headphone icons on h1-h6 headings — seeks audio to that heading's timestamp.

**Sentence-level text highlighting:**

1. Fetches `.timestamps.json` eagerly on page load (heading icons appear immediately).
2. Matches segments to DOM elements by **text content** (not blockIndex counting) — handles extra DOM elements from Question tags, tables, list items. Uses blockIndex as a hint, searches outward by distance, tracks matched elements to handle repeated headings.
3. Uses `sentenceIndex` to locate the specific sentence within that block.
4. A `requestAnimationFrame` loop tracks `audio.currentTime`.
5. Uses `Range.getClientRects()` to measure the sentence position, then positions transparent overlay divs for the highlight (no DOM modification -- the document text is never wrapped or altered).
6. Clears highlight when current time falls in a gap between segments.
7. Auto-scrolls to the highlighted sentence by default. When the user scrolls away, auto-scroll disengages and a "Jump to audio location" pill link appears above the player. Tapping re-engages auto-scroll.

**Auto-advance:** Navigates to the next chapter when audio ends. Auto-plays via a `localStorage` flag.

**Resume:** Saves playback position to `localStorage` and restores it on page load.

**Book page:** Displays an audiobook badge with total duration when a manifest exists.

**Homepage:** Small headphones icon next to session count on book cards that have audio enabled.

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
| **Timestamp-only rebuild** | Re-run generation with `force_regenerate=true`: cached chunks are reused (0 ElevenLabs credits), only `.timestamps.json` is rebuilt. |
| **Per-edit regeneration** | ~800 characters (1 chunk) = negligible. |
