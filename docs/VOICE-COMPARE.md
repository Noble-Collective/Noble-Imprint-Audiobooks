# Voice Compare — side-by-side voice auditioning on the website

A reusable tool for auditioning ElevenLabs voices on a real passage and sharing
them with the team for review. It renders the *same* passage in many voices,
publishes the MP3s to GCS, and the resource website serves them side by side at
**`/voice-test`**.

This is separate from the main audiobook pipeline (`generate.yml`): it doesn't
touch `series/` content, book `meta.json`, existing audiobooks, or timestamps.
It only writes under the GCS prefix `voice-test/{slug}/`.

- **Live page:** https://resources.noblecollective.org/voice-test
- **Per-passage pages:** `/voice-test/<slug>` (default slug `psalm-1-2`)

## How to run it

1. **Actions → "Voice Compare (publish to website)" → Run workflow**, with inputs:
   - `sample_file` — a markdown file in this repo (default `samples/psalm-1-2.md`)
   - `slug` — GCS folder + page URL segment (default `psalm-1-2`)
   - `title` — heading shown on the page (default `Psalm 1 & 2`)
   - `dry_run` — `true` = resolve voices + print the spoken text, **no TTS spend**
   - `force` — `true` = regenerate every voice (default skips voices already in GCS)
2. The page updates within ~1 minute (the workflow clears the website audio cache).
   No website deploy is needed — the page reads the manifest live.

**Always dry-run first.** It confirms every voice resolves and prints the exact
spoken text and the credit/cost estimate before anything is billed.

### Cost & the skip-existing safety

Cost ≈ `spokenChars × voicesGenerated` credits (`$1.65 / 10,000`). Psalm 1 & 2 is
~1,737 chars, so ~$0.29 per voice. Re-runs **skip any voice whose MP3 already
exists** in `voice-test/{slug}/` — only newly added voices are generated and
billed. Use `force=true` only to deliberately re-render everything.

## Adding / changing voices

Edit the `VOICES` array in [`src/voice-compare.js`](../src/voice-compare.js).
Each entry resolves in one of three ways:

| Field | Meaning |
|-------|---------|
| `id` | Explicit ElevenLabs voice ID — used directly (premade voices, or a known library ID). |
| *(name only)* | Searches the shared library by `name`, adds the match to the workspace. |
| `query` + `searchFallback` | Resolves by library filter (e.g. `{gender:'male', language:'fa'}`), falling back through keyword searches. Use for accents you can't name. |

Resolution is idempotent: added voices are stored in the workspace under a
`vt:` name prefix and reused on later runs (no duplicate workspace entries). A
voice that fails to resolve is **skipped with a warning**, not fatal to the run.

### Sample files

`samples/*.md` use the same markdown conventions as `series/` sessions:
`#`/`##` headings (spoken with SSML pauses), `<sup>N</sup>` verse numbers
(shown on screen, **silent** in audio). `samples/psalm-1-2.md` is the BSB text of
Psalms 1 & 2, chosen because two section headings let you hear heading pacing.

## The current slate (Psalm 1 & 2)

13 voices, generated 2026-07-22. Resolved IDs (workspace/library) for reference:

**Western narrators**

| Display | Accent | Voice ID | Source |
|---------|--------|----------|--------|
| George | British | `JBFqnCBsd6RMkjVDRZzb` | premade |
| Brian | American | `nPczCjzI2devNBz1zQrb` | premade |
| Daniel | British | `onwK4e9ZLuTAKqWW03F9` | premade |
| Bill L. Oxley | American | `iiidtqDt9FBdT1vfBluA` | library — "Bill Oxley - Documentary Commentator" |
| Matthew Schmitz | American | `4QLC5fepxZkYmdD2IGRU` | library — "…Scriptures, Bible & Religious readings" |

**Middle Eastern narrators** (reading the English text — judge intelligibility *and* authenticity)

| Display | Accent | Voice ID | Source |
|---------|--------|----------|--------|
| Ali | Arabic (Saudi) | `MI88rOZjXbH22N8KHXUo` | library — "Ali - calm & Deep Arabic Saudi Narrator" |
| Marco Nady | Arabic | `Ojb0nFbyzZn95u0i5a5p` | library — "Marco Nady - Confident and Calm" |
| Haytham | Arabic (Egyptian) | `wxweiHvoC2r2jFM7mS8b` | library — "Haytham - Dramatic and Narrative" |
| Persian (Farsi) | Persian | `rNb3hdSf0n4ROIbYC8Bl` | library — "Shahram - Natural Documentary Narrator" |
| Ali Alpagu | Turkish | `4beSxG7EOp1Zp56REJeW` | library — "Ali Alpagu - Clear, Assertive and Steady" |
| Mamdoh | Egyptian | `68MRVrnQAt8vLbu0FCzw` | library — "Mamdoh - Deep Egyptian Arabic Male voice" |
| Fadi | Lebanese | `oJQlz7pz2yWd7MRmDUXm` | library — "Fadi - Lebanese Conversational Voice" |
| Palestinian (Levant) | Levantine | `8sSDN08XkFeN2zqNwCZk` | library — "Odai - Expressive and Professional" |

### Note on Hebrew (verified 2026-07-22)

There is **no Hebrew voice in the ElevenLabs shared library reachable via the
API** — `shared-voices` returns 0 for `language=he`, the legacy `language=iw`,
and every keyword search ("Hebrew", "Israeli", "Ivrit", "Jewish", "Tel Aviv").
The closest authentic stand-in is a **Levantine Arabic** voice from the Bible's
geography — Palestinian (Odai) is spoken in the land of ancient Israel.
To get a genuine Hebrew accent you'd need either ElevenLabs **Voice Design**
(synthesize from a prompt) or to add a Hebrew voice found in the dashboard UI
(which shows voices the API filter doesn't) and reference it by `id`.

## Website side (Noble-Imprint-Resource-Website)

Three small additions serve the page — no other behavior touched:
- `src/server/audio.js` → `getVoiceCompareData(slug)` — reads the manifest, signs URLs.
- `src/server/index.js` → `GET /voice-test/:slug?` route (registered before the catch-all).
- `src/views/voice-test.ejs` → the page (passage text + one player per voice).

The GCS manifest at `voice-test/{slug}/manifest.json` is the contract:
`{ slug, title, translation, spokenChars, blocks:[{type,text}], voices:[{name,accent,blurb,voiceId,file}] }`.

## Relationship to real Bible audiobooks

This tool auditions voices; it is **not** the Bible-audiobook pipeline. Producing
actual scripture audiobooks still needs a **USFM→markdown converter** (adapt
`Coram-Deo-App/scripts/ingest-usfm.js`'s `parseUSFM` to emit session markdown
instead of DB rows). Known quirk to fix there: the TTS preprocessor appends a
stray period after quoted lines (`cords"."`) — inaudible but worth cleaning up
given how quote-heavy scripture is. Once a voice is chosen, its ID drops into a
book's `meta.json` `audiobook.voice_id`.
