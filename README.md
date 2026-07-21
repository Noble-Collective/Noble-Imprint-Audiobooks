# Noble Imprint Audiobooks

Automated audiobook generation for Noble Imprint resources via ElevenLabs TTS with character-level sentence sync.

```
Noble-Imprint-Resources (content push)
  -> repository_dispatch
  -> This repo: detect changes -> preprocess markdown -> ElevenLabs TTS -> GCS
  -> Noble-Imprint-Resource-Website: serves audio via signed URLs + text sync
```

## How to enable audiobook for a new book

1. **Choose a voice** -- browse [elevenlabs.io/voice-library](https://elevenlabs.io/voice-library), filter by accent/gender, and add to the workspace.

2. **Add audiobook config** to the book's `meta.json` in the Resources repo:

```json
{
  "audiobook": {
    "enabled": true,
    "voice_id": "your-voice-id",
    "model_id": "eleven_multilingual_v2",
    "quality_preset": "high",
    "voice_settings": { "stability": 0.71, "similarity_boost": 0.5, "style": 0.0, "speed": 0.92 },
    "skip_sessions": ["01-FrontMatter.md"],
    "pronunciation_dictionary_id": null
  }
}
```

3. **Push to main** -- the dispatch trigger fires automatically and generates audio.

4. **Audio appears on the website** within ~30 minutes (generation + timestamp alignment).

## Voice testing

Use `voice_test_map` to assign different voices to different chapters for A/B testing:

```json
"voice_test_map": {
  "02-ChapterOne.md": "voice-id-1",
  "03-ChapterTwo.md": "voice-id-2"
}
```

When a session has an entry in `voice_test_map`, that voice is used instead of the top-level `voice_id`. Remove `voice_test_map` once you have chosen a voice.

## Manual triggers

- Go to **Actions -> Generate Audiobook -> Run workflow**
- Optional: `book_path` filter to limit to one book (e.g., `A Library of Classics/A Pastoral Shelf/Oration II`)
- Optional: `force_regenerate=true` to regenerate everything (ignores chunk hashes)

There is also a **Find Voices** workflow (`Actions -> Find Voices -> Run workflow`) that searches the ElevenLabs voice library and lists workspace voices.

## Configuration reference

All `meta.json` `audiobook` fields:

| Field | Required | Description |
|-------|----------|-------------|
| `enabled` | Yes | Set `true` to include this book in audiobook generation |
| `voice_id` | Yes | ElevenLabs voice ID (from voice library or workspace) |
| `voice_test_map` | No | Object mapping session filenames to alternate voice IDs for A/B testing |
| `model_id` | No | ElevenLabs model (default: `eleven_multilingual_v2`) |
| `quality_preset` | No | Quality level (default: `high`) |
| `voice_settings` | No | Object with `stability`, `similarity_boost`, `style`, `speed` |
| `skip_sessions` | No | Array of session filenames to exclude (e.g., `["01-FrontMatter.md"]`) |
| `pronunciation_dictionary_id` | No | ElevenLabs pronunciation dictionary ID |
| `output_format` | No | Audio format string (default: `mp3_44100_128`) |
| `language_normalization` | No | When `true`, speak scripture refs/numeric ranges naturally per the book's top-level `language` (`en`/`fr`); default `false` speaks them literally. Toggling it changes the spoken text, so affected sessions regenerate on the next run. |
| `project_id` | No | Legacy field, unused |

## Repo structure

```
.github/workflows/
  generate.yml         -- main generation workflow (dispatch + manual)
  find-voices.yml      -- utility to search ElevenLabs voice library
  voice-test.yml       -- A/B voice testing (short samples with different voices)
src/
  preprocess-tts.js    -- markdown -> clean spoken text for TTS (+ per-language normalization, gated)
  detect-changes.js    -- chunk-level content hash comparison against GCS manifest
  generate.js          -- ElevenLabs TTS with timestamps + chunk-level caching + GCS upload
  languages.js         -- per-language spoken-text normalization (scripture refs, numeric ranges)
  bible-refs.js        -- legacy English scripture-ref -> spoken form (fallback when language_normalization is off)
  preprocess-test.js   -- local testing utility (runs against Resources repo)
  find-voices.js       -- voice search utility
  voice-test.js        -- A/B voice test sample generation
pronunciation/
  dictionary.pls       -- W3C PLS pronunciation lexicon (theological names)
docs/
  ARCHITECTURE.md      -- full system architecture (if present)
```

## Preprocessing rules

Before sending to TTS, markdown is cleaned as follows:

- **Headings** -- stripped of `#` markers (including inside `<Question>` tags), sentence-cased (proper nouns preserved), and wrapped in SSML `<break>` tags for pacing (2s for H1/H2, 1s for H3+). Redundant breaks between back-to-back headings are de-duplicated. The original heading text is kept as `displayText` for web-reader highlighting.
- **`<ChapterNum>` tags** -- section numbers (e.g. `<ChapterNum>10</ChapterNum>`) are stripped entirely (tag + number), not spoken
- **Blockquote → body** -- a `<break time="2s"/>` is prepended to a body paragraph that follows a blockquote summary (Seneca), for an audible transition. Break tags live only in the spoken/TTS text; they are stripped from the sentence list used for timestamps and highlighting.
- **Language normalization** (opt-in, `language_normalization: true`) -- scripture references and numeric ranges expanded to natural speech per the book's `language` (e.g. EN "Proverbs 1-9" → "Proverbs, chapters 1 through 9"; FR "Actes 2:1-47" → "Actes, chapitre 2, versets 1 à 47"). When off, text is spoken literally.
- **Numbered orations** -- lines starting with a number and period (e.g., "103.") have a paragraph break inserted after the number for TTS pacing
- **Bold/italic** -- `**text**`, `*text*`, `_text_` markers removed, content kept
- **Links** -- `[text](url)` replaced with just `text`
- **Images** -- `![alt](url)` removed entirely
- **Tables** -- rows starting with `|` removed entirely
- **Horizontal rules** -- `---` lines removed
- **Blockquotes** -- `>` marker stripped, content kept
- **HTML tags** -- `<Question>`, `<Callout>`, `<sup>`, `<br>` tags stripped, content kept
- **Attributions** -- lines starting with `<<` converted to spoken Bible references (e.g., "First Corinthians, chapter 4, verse 1.")
- **Greek text** -- lines that are entirely Greek Unicode characters are removed
- **Citation markers** -- leftover `<<` prefixes stripped

## GCS output structure

```
noble-imprint-audiobooks/audio/{slugified-book-path}/
  manifest.json                                -- index of all sessions with hashes and durations
  02-chapterone.mp3                            -- final chapter audio
  02-chapterone.tts.json                       -- preprocessed text (debug)
  02-chapterone.timestamps.json                -- sentence-level timestamps with blockIndex/sentenceIndex for DOM element lookup
  chunks/02-chapterone/
    <content-hash>.mp3                         -- individual TTS chunk, named by 16-char content hash (for reuse)
    <content-hash>.align.json                  -- cached ElevenLabs character-level alignment per chunk
```

Chunks target ~800 characters each, produced by a linear block walk that force-splits at H1/H2/H3 headings (250-char minimum guard). Each chunk file is named by a content hash of its text; only chunks whose hash changes are regenerated, and unchanged chunks are downloaded from GCS and reused. Chunks are concatenated directly with no silence gaps — ElevenLabs handles paragraph pacing naturally.

To rebuild only the sentence-level timestamps without spending ElevenLabs credits (e.g. after a timestamp-matching fix), re-run `generate.yml` with `force_regenerate=true`: unchanged chunks are reused from cache (0 credits) and just the `.timestamps.json` files are rebuilt.

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| "0 sessions need regeneration" | Check that `meta.json` has `audiobook.enabled: true` and the book path matches any `book_path` filter |
| Generation fails with 429 | Rate limited by ElevenLabs. Retries automatically with exponential backoff (4s, 16s, 64s) |
| Timestamps inaccurate | Check that the with-timestamps endpoint returned alignment data; generate.js logs segment count |
| No audio icon on website | Manifest may not exist in GCS, or the website content tree needs a refresh (`POST /api/refresh-audio`) |
| CORS errors on audio/timestamps | GCS bucket CORS config must include the website domain |

## Secrets required

These secrets must be configured in **this repo** (Noble-Imprint-Audiobooks):

| Secret | Purpose |
|--------|---------|
| `ELEVENLABS_API_KEY` | ElevenLabs API authentication |
| `GCP_SA_KEY` | GCP service account JSON (GCS read/write access to `noble-imprint-audiobooks` bucket) |
| `RESOURCES_TOKEN` | GitHub PAT with read access to Noble-Imprint-Resources |

The **Resources repo** needs a `repository_dispatch` event configured to notify this repo on push to main.

## Links

- **Resources repo**: [Noble-Collective/Noble-Imprint-Resources](https://github.com/Noble-Collective/Noble-Imprint-Resources)
- **Website repo**: [Noble-Collective/Noble-Imprint-Resource-Website](https://github.com/Noble-Collective/Noble-Imprint-Resource-Website)
- **ElevenLabs dashboard**: [elevenlabs.io/app](https://elevenlabs.io/app)
- **GCS bucket**: [console.cloud.google.com](https://console.cloud.google.com) (noble-imprint-website project, `noble-imprint-audiobooks` bucket)
