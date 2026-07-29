# Bible Audiobooks — Architecture & Runbook

How narrated audiobooks of individual Bible books are produced and served in the
`/bible` reader. Built 2026-07-29; first two books live: **Proverbs** and **2 Timothy**
(BSB, "Ali" voice). This is the doc to read before adding another book.

---

## 1. The one idea

We did **not** build a new audio pipeline. A Bible book is turned into the same
per-chapter session markdown that the existing audiobook pipeline already consumes, so
all of chunking, TTS-with-timestamps, GCS upload, and the web player are reused unchanged.

**The only genuinely new code is a USFM→markdown converter.** Everything else is config +
small glue.

```
bibles/{tx}/content/{CODE}.SFM        (source USFM, in Noble-Imprint-Resources)
        │
        ▼  usfm-to-markdown.js         (converter — the only new logic)
per-chapter markdown  "# 2 Timothy 1\n\n## heading\n\n<sup>1</sup>verse…"
        │
        ├── GENERATION ─────────────────────────────────────────────────────────
        │   detect-changes.js (Bible path) → preprocess-tts.js → generate.js
        │   → GCS  audio/bible/{tx}/{book-slug}/{NNN}.mp3 + .timestamps.json + manifest.json
        │
        └── WEBSITE (/bible reader) ────────────────────────────────────────────
            bible.js renders the SAME blocks (via a CommonJS port of the converter)
            + audio.js signs the GCS assets + bible-chapter.ejs shows the player
```

Because the on-screen blocks are produced by the *same* parser the timestamps came from,
the highlight sync is correct by construction.

---

## 2. Repos & key files

**Noble-Imprint-Audiobooks** (generation tooling)
| File | Role |
|------|------|
| `src/usfm-to-markdown.js` | **The converter.** USFM book → per-chapter markdown. Also a CLI (dry-run + preview). Exports `usfmBookToChapters`, `parseUsfmBook`, `findBookFile`, `parseChapterRange`. |
| `src/detect-changes.js` | `findBibleWorkItems()` + `BIBLE_BOOK`/`BIBLE_TRANSLATION`/`BIBLE_CHAPTERS` env. Bible-only run when `BIBLE_BOOK` is set. |
| `src/preprocess-tts.js` | Shared. Turns markdown → spoken blocks/sentences. `spokenChapterTitle` used for heading pronunciation. |
| `src/languages.js` | `spokenChapterTitle()` (chapter-title speech), scripture-ref normalization, `EN_BOOKS` list. |
| `src/generate.js` | **Unchanged** — content-source-agnostic; consumes work items. |
| `.github/workflows/generate.yml` | Manual dispatch. Inputs: `bible_book`, `bible_translation`, `bible_chapters` (+ `force_regenerate`). |
| `scripts/scan-heading-impact.mjs` | One-off audit: which existing headings the title transform would change. |

**Noble-Imprint-Resources** (content)
| Path | Role |
|------|------|
| `bibles/{bsb,kjv}/content/*.SFM` | Source USFM, one file per book. |
| `bibles/{bsb,kjv}/references.json` | Flat `{"Book C:V": text}` map — the website's verse source + book names. |
| `bibles/{tx}/meta.json` | **Config.** The `audiobook` block gates which books are enabled (see §4). |

**Noble-Imprint-Resource-Website** (serving)
| File | Role |
|------|------|
| `src/server/usfm-audio.js` | **CommonJS port of the converter.** MUST stay byte-parity with `usfm-to-markdown.js`. |
| `src/server/audio.js` | `getBibleAudioManifest(tx, bookName)`, `getBibleAudioChapter(...)`. |
| `src/server/bible.js` | `getAudioChapterBlocks(tx, code, ch)`; `resolveRefBookName()`; paragraph-grouping in `loadBibles`. |
| `src/server/index.js` | `/bible/:tx/:book` route: looks up audio + blocks, degrades to text-only. |
| `src/views/bible-chapter.ejs` | Renders audio chapters as paragraphs + the player; text-only otherwise. |

---

## 3. GCS layout

Bucket `noble-imprint-audiobooks` (us-central1, private; served via 1-hr signed URLs).
Bible audio lives under a `bible/` prefix, separate from series audiobooks:

```
audio/bible/{tx}/{book-slug}/
  manifest.json                 { bookPath:"bibles/{tx}/{CODE}", sessions:[…], totalDurationSeconds }
  {NNN}.mp3                      one per chapter (001, 002, … zero-padded)
  {NNN}.timestamps.json          { segments:[{start,end,blockIndex,sentenceIndex,text}] }
  {NNN}.tts.json                 debug ({name, blocks, plainText, chunks})
  chunks/{NNN}/{hash}.mp3 + .align.json
```

`{book-slug}` = `slugify(bookName)`. **Gotcha:** the generation side slugifies the USFM
`\h` name; the website slugifies the references.json name. They match for most books but
NOT for Psalms/Song (see §8) — reconcile before adding those.

---

## 4. Configuration — `bibles/{tx}/meta.json`

```json
{
  "title": "Berean Standard Bible",
  "description": "…",
  "version": "BSB",
  "language": "en",
  "audiobook": {
    "enabled": true,
    "language_normalization": true,
    "voice_id": "MI88rOZjXbH22N8KHXUo",
    "model_id": "eleven_multilingual_v2",
    "quality_preset": "high",
    "voice_settings": { "stability": 0.71, "similarity_boost": 0.5, "style": 0.0, "speed": 0.90 },
    "books": {
      "PRO": { "enabled": true },
      "2TI": { "enabled": true }
    }
  }
}
```

- `books.{CODE}` — **opt-in per book** (3-letter USFM code). `{ "enabled": true }`, optional
  `"chapters": "1-4"` to limit range. This is how "one book at a time" is enforced and how
  the website knows a book has audio.
- `voice_id` — current: **Ali** `MI88rOZjXbH22N8KHXUo` (Saudi-Arabic-accented English narrator,
  chosen via `/voice-test`). `speed: 0.90` is the scripture read profile.
- `language_normalization: true` — expands scripture refs / numeric ranges in verse text.
  Harmless for the current books; see §8 for the caveat.

Find a book's `CODE` from its filename (`562TIBSB.SFM` → `2TI`) or its `\id` line.

---

## 5. The converter (`usfm-to-markdown.js`)

Emits the `samples/psalm-1-2.md` convention: `# {Book} {N}` (H1 chapter title) → `##`/`###`
section headings (from `\s1`/`\s2`) → paragraphs with `<sup>N</sup>` verse numbers.

Behavior worth knowing:
- **Poetry is flowing** — consecutive `\q1`/`\q2` lines group into ONE stanza paragraph;
  breaks only at `\b`/prose markers. (Deliberate: no per-line pauses. Steve's call.)
- **Verse numbers** `<sup>N</sup>` are silent in audio (stripped by preprocess), visible on web.
- **`\d` superscriptions** (Psalms) are kept as spoken paragraphs.
- **Footnotes/cross-refs/char-styles** (`\f…\f*`, `\x…\x*`, `\add`, `\nd`, `\wj`) are stripped,
  inner text kept.
- **Self-check** (`assertClean`) rejects output containing stray `\` markers or non-`<sup>`
  tags, so nothing can trip generate.js's timestamp guard.

CLI (spends **no** credits):
```
node src/usfm-to-markdown.js --tx bsb --book 2TI [--chapters 1-4] [--print] [--out DIR] [--label "…"]
```
`--print` shows the markdown + the SPOKEN preview (with break tags) + a char/credit estimate.
Always dry-run a new book and eyeball the output before generating.

---

## 6. RUNBOOK — add a new Bible book

Example: adding **Ruth** (code `RUT`), BSB.

1. **Confirm the source + code.** `ls Noble-Imprint-Resources/bibles/bsb/content | grep RUT`
   → `08RUTBSB.SFM`. Code = `RUT`.

2. **Dry-run the converter** (no spend) and read it:
   ```
   node src/usfm-to-markdown.js --tx bsb --book RUT --print
   ```
   Check: headings sentence-cased, verse numbers present, poetry grouped sensibly, no
   leftover `\` markers, and the credit estimate is what you expect.

3. **Enable it in config.** Edit `Noble-Imprint-Resources/bibles/bsb/meta.json`:
   ```json
   "books": { …, "RUT": { "enabled": true } }
   ```
   Commit + push the Resources repo. (Pushing does nothing on its own — generation is
   manual, auto-dispatch is off.)

4. **Smoke-test one chapter** (~cents):
   ```
   gh workflow run generate.yml --repo Noble-Collective/Noble-Imprint-Audiobooks \
     -f bible_book=RUT -f bible_chapters=1
   ```
   Watch it (`gh run watch <id>`). Confirm it uploaded to `audio/bible/bsb/ruth/` and the
   timestamp guard passed.

5. **Verify the chapter live** — `https://resources.noblecollective.org/bible/bsb/Ruth?chapter=1`
   should show the audio player + paragraph rendering, and the signed URL should resolve:
   `curl -s .../api/audio/url/bible/bsb/ruth/001.mp3`.

6. **Generate the rest:** `gh workflow run … -f bible_book=RUT` (all chapters; ch1 is cached
   → 0 credits for it). Verify a couple more chapters.

**No website change is needed per book** — the `/bible` route auto-detects audio for any
book that has a GCS manifest and is enabled in config.

To re-run/repair: `-f force_regenerate=true` re-does everything; otherwise only chapters
whose spoken text changed regenerate (and within those, only changed chunks — see §8).

---

## 7. Rendering behavior (web)

- Audio-enabled chapters render from the converter's blocks: `<h1>` chapter title (from the
  template), `<h3>` section headings, `<p class="bible-paragraph">` with inline `<sup>`.
- Non-audio chapters keep the existing verse-span layout. Both now group poetry into stanzas
  (the `\q` paragraph-break fix in `bible.js` `loadBibles`), and the same grouping drives the
  inline scripture-reference **popup** (`main.js` `initVersePopup` → `getVerses`).
- Chapter-title pronunciation: `spokenChapterTitle` speaks "2 Timothy 1" as **"Second
  Timothy, Chapter 1"**, "Proverbs 1" as "Proverbs, Chapter 1", "Psalm 23" as "Psalm 23".
  The on-screen title and the highlight needle stay the literal "2 Timothy 1".

---

## 8. Known gotchas & lessons (READ before adding Psalms / Song / numbered books)

1. **`\h` vs references.json name mismatch.** A few books' USFM `\h` name differs from the
   verse-key name: `Psalms`→`Psalm`, `Song`→`Song of Solomon`. This breaks TWO things:
   - **Web paragraph/heading flags** — fixed by `resolveRefBookName()` in `bible.js`
     (add new aliases there if another book mismatches).
   - **The GCS book-slug** — generation slugs from `\h` (`psalms`), the website looks up
     from the ref name (`psalm`) → the site won't find the audio. **Not yet reconciled.**
     Before adding Psalms/Song, normalize the generation-side book name too (apply the same
     alias in `detect-changes.findBibleWorkItems`, or pass an explicit slug), so both sides
     agree. Proverbs/2 Timothy are unaffected (names match).

2. **Heading edits can cascade chunk regeneration.** The chapter title lives in chunk 1.
   Changing its spoken text usually re-does only chunk 1 (hash reuse). But if the change
   pushes chunk 1 past the ~800-char boundary, the split point moves and *every* chunk hash
   in that chapter changes → full-chapter regen. (Seen on 4 Proverbs chapters during the
   heading fix.) If we expect title tweaks, force the H1 onto its own chunk so edits never
   cascade — not done yet; a small change in `generate.js` `chunkText`.

3. **The Bible disk cache is committed and stale-prone.** `Website/.bible-cache/{tx}-v1.json`
   bakes in `paragraphStart`/`sectionHeading` flags and ships in the Docker image. After any
   change to `bible.js` parsing (or the USFM), **rebuild + commit it**: delete
   `.bible-cache/*.json`, boot the server (fetches USFM from GitHub, ~2 min), commit the
   rebuilt JSON. Otherwise the deploy serves stale flags. (`CACHE_VERSION` bump is the
   alternative but forces a slow first-boot rebuild in prod.)

4. **Converter parity.** `Website/src/server/usfm-audio.js` is a hand-port of
   `usfm-to-markdown.js`. If you change one, change the other, or the web blocks stop
   matching the audio timestamps. Parity check: diff their per-chapter output for a book.

5. **Audio chapters lose per-verse `id="vN"` anchors** (rendered as paragraphs). Fine so far;
   revisit if verse-level deep-linking into audio chapters is needed.

6. **`language_normalization`** transforms verse text for speech; if a verse contained a
   numeric range it would diverge from the on-screen text and the highlight could drift for
   that sentence. Rare (refs live in dropped cross-ref lines), but if a book shows sync drift,
   try `language_normalization: false` for it.

7. **`spokenChapterTitle` only fires for known book names** (from `languages.js` `EN_BOOKS`).
   A book whose name isn't in that list falls back to sentence-casing (still fine, just not
   "…, Chapter N"). Add the name to `EN_BOOKS` if needed.

---

## 9. Cost model

Credits ≈ generated (billed) characters; **$1.65 / 10,000**. Unchanged chunks reuse cached
audio at 0 credits. `--print` prints an estimate before you spend.

Actuals (2026-07-29): 2 Timothy (4 ch) + Proverbs (31 ch) initial generation ≈ **52,000
credits (~$8.6)**; the heading-pronunciation regen ≈ **18,000 credits (~$3)**. Whole project
~$11.7. Balance after: 742,390 / 896,039 this cycle.

---

## 10. Verification checklist

- [ ] `--print` output looks right (headings, verses, poetry grouping, no `\` leaks).
- [ ] Smoke-test 1 chapter → GCS manifest + timestamps present, guard passed.
- [ ] Live page shows the player + paragraph rendering; signed MP3/timestamps URLs resolve.
- [ ] Highlight tracks narration (spot-check by ear on 1–2 chapters).
- [ ] Chapter title reads correctly (spelled-out ordinal for numbered books).

---

## Related docs
- `plans/2026-07-29-bible-audiobooks.md` — the original plan + build history/decisions.
- `docs/VOICE-COMPARE.md` — how the Ali voice was chosen (`/voice-test`).
- `docs/ARCHITECTURE.md` — the overall audiobook system.
