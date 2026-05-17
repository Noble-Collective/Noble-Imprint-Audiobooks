# Noble Imprint Audiobooks

Automated audiobook generation for Noble Imprint resources. Converts structured markdown content to narrated audio via the ElevenLabs Studio API, with sentence-level text sync via Whisper alignment.

## How It Works

```
Noble-Imprint-Resources (content push)
  → repository_dispatch
  → This repo: detect changes → preprocess markdown → ElevenLabs Studio → GCS
  → Noble-Imprint-Resource-Website: serves audio via signed URLs + text sync
```

1. **Detect changes** — compare content hashes against GCS manifest to find modified sessions
2. **Preprocess** — strip markdown syntax, convert to ElevenLabs Studio `from_content_json` format
3. **Generate** — create/update Studio project, trigger conversion, download chapter audio
4. **Align** — run Whisper forced alignment to produce sentence-level timestamps
5. **Upload** — MP3s, TTS JSON (debug), timestamps JSON, and manifest to GCS

## Configuration

Audiobook generation is enabled per-book via `meta.json` in the Resources repo:

```json
{
  "audiobook": {
    "enabled": true,
    "voice_id": "voice-id-here",
    "model_id": "eleven_multilingual_v2",
    "quality_preset": "high",
    "skip_sessions": ["01-FrontMatter.md", "08-Bibliography.md"]
  }
}
```

## Running Manually

```bash
# Test preprocessing locally
node src/preprocess-test.js ../Noble-Imprint-Resources

# Trigger via GitHub Actions
# Go to Actions → Generate Audiobook → Run workflow
```

## GCS Output Structure

```
noble-imprint-audiobooks/audio/{slugified-book-path}/
  manifest.json                    ← index of all sessions
  02-chapterone.mp3                ← audio
  02-chapterone.tts.json           ← preprocessed text (debug)
  02-chapterone.timestamps.json    ← sentence-level timestamps (text sync)
```

## Secrets Required

| Secret | Purpose |
|--------|---------|
| `ELEVENLABS_API_KEY` | ElevenLabs API authentication |
| `GCP_SA_KEY` | GCP service account (storage access) |
| `RESOURCES_TOKEN` | GitHub PAT to read Resources repo + commit project_id |

## Architecture

See the full plan: [Audiobook Generation System](https://github.com/Noble-Collective/Noble-Imprint-Audiobooks/wiki) (or ask the project admin for the design document).
