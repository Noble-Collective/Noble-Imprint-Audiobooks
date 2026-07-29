# Plan: Bible Audiobooks — native `/bible` reader (one book at a time)

**Date:** 2026-07-29
**Goal:** Narrated audiobooks for individual books of the Bible, one book at a time, with
audio + synced highlighting **inside the existing `/bible` reader** (no duplicated
content). Steve has 2 books + a chosen voice ready.

## Confirmed decisions
1. **Serving:** Option **B — native `/bible` player**. Audio + highlight sync live on the
   `/bible/:tx/:book?chapter=N` pages. No `series/` duplication.
2. **Granularity:** **per chapter** (one MP3 + one manifest entry + one page = one chapter).
3. **Translation:** **BSB** (per-book override possible).
4. Pending from Steve: the 2 book names, the ElevenLabs voice ID, public/hidden rollout.

---

## The key insight (unchanged by Option B)
We reuse the *entire* generation engine — `generate.js` chunking, TTS-with-timestamps,
chunk-hash reuse, `buildTimestampsFromAlignments`, the hard-fail guard, GCS manifest.
The only new logic is **USFM → markdown blocks**. HomeStead already proves scripture
(`<sup>N</sup>` verses in markdown paragraphs + `##` headings) flows through
`preprocessSession` → `generate.js` → the web player and syncs correctly. Our converter
produces exactly the `samples/psalm-1-2.md` shape.

**Because we chose native `/bible` (no duplicate committed text), the converter runs
in-memory and feeds the pipeline directly — we do NOT commit a second copy of scripture
as `series/…/sessions/*.md`.**

---

## Architecture for Option B

Three layers. The converter is shared between generation and rendering so the audio and
the on-screen blocks are guaranteed identical → **sync is correct by construction.**

```
bibles/bsb/content/19PSABSB.SFM   (source, already in Noble-Imprint-Resources)
        │
        ▼  usfm-to-markdown.js  (NEW, in-memory, pure)
markdown per chapter  ("# Psalm 1\n\n## The Two Paths\n\n<sup>1</sup>…")
        │
        ├──────────────► GENERATION (detect-changes → preprocessSession → generate.js)
        │                    → GCS audio/bible/{tx}/{book}/{NN}.mp3 + .timestamps.json + manifest.json
        │
        └──────────────► WEBSITE RENDER (bible reader renders the SAME blocks + the player)
                             → /bible/bsb/Psalms?chapter=1  with play + synced highlight
```

### Layer 1 — Converter: `src/usfm-to-markdown.js` (NEW, the only genuinely new logic)
Adapts Coram-Deo's `parseUSFM` but emits **markdown blocks per chapter**, not DB rows.
Pure/in-memory (no file writes). Exported so both the generation script and (via a small
website port or shared package) the renderer can call it.

**Signature (concept):**
```js
usfmBookToChapters(usfmText, { bookCode, bookName }) 
  → [ { chapter: 1, markdown: "# Psalm 1\n\n## The Two Paths\n\n<sup>1</sup>Blessed…" }, … ]
```

**USFM marker handling (from the real data in the repo):**
| USFM | Action |
|------|--------|
| `\id \h \toc* \mt*` | front matter → book name; not spoken |
| `\c N` | new chapter block; `# {BookName} {N}` H1 |
| `\ms \mr` | book-division super-headings (Psalms) → drop |
| `\s1` / `\s2` | `##` / `###` section heading (spoken, paused) |
| `\r (…)` | cross-ref under heading → drop (silent) |
| `\d …` | Psalm superscription → spoken line (blockquote/para); **strip embedded `\f…\f*` first** (Psalm 6). ⚠️ Coram-Deo drops these — we must keep. |
| `\v N text` | `<sup>N</sup>` inline; first verse of chapter may use `<sup>C:1</sup>` |
| `\v N-M` | keep `<sup>N-M</sup>`, join text |
| `\p \m \pc \pmo` | prose paragraph boundary |
| `\q1 \q2 \qr \qa \li1 \li2` | poetry/list lines → grouped into a paragraph; punctuation carries phrasing |
| `\b` | stanza/paragraph boundary |
| `\f … \f*` | footnote → strip (handle BSB `\fr 1:3`, KJV `\fr 1.1`, stacked `\f*\f +`) |
| `\x … \x*` | strip |
| `\add…\* \nd…\* \wj…\* \tl…\* \it…\*` | keep inner text, drop markers |
| `¶` (KJV) | strip |
| any other `\xyz`/`\xyz*` | generic strip (Coram-Deo lines 70–71 model) |

**Must-haves:**
- **Verse-continuation reassembly** — split each line on `/\\v\s+(\d+)(?:-\d+)?\s*/`, append
  leading text to the open verse, start verses at odd indices (mirrors Coram-Deo). KJV
  wraps verses across physical lines with no marker — essential.
- **Stanza grouping** — group consecutive `\q*` lines between `\b`/`\p`/heading into one
  markdown paragraph (avoids choppy audio + a swarm of tiny sub-250-char chunks).
- **Guard-safety** — emit ONLY `<sup>…</sup>` + markdown headings (exactly what
  `preprocess-tts.js` strips and the timestamp guard tolerates). A self-check must reject
  output containing any residual `\` marker or non-`<sup>` tag before it's used.
- **`--dry-run` CLI wrapper** — print the markdown + spoken preview (through
  `preprocessSession`) + char/credit estimate; zero spend. Diff Psalm 1–2 output against
  `samples/psalm-1-2.md` as the acceptance test (should be ~identical).

### Layer 2 — Generation (small extension to `detect-changes.js`; `generate.js` untouched)
`generate.js` is content-source-agnostic — it consumes work items
`{ bookSlugPath, sessionFile, contentHash, meta, ttsBlocks, sentences, chapterName,
plainText }` and writes manifests. We add a **second discovery path** that produces those
items from the Bible tree instead of `series/`.

- **Config** — add an `audiobook` block to `bibles/{tx}/meta.json` (currently minimal):
  ```json
  "audiobook": {
    "enabled": true,
    "language_normalization": true,
    "voice_id": "<ELEVENLABS_VOICE_ID>",
    "model_id": "eleven_multilingual_v2",
    "voice_settings": { "stability": 0.71, "similarity_boost": 0.5, "style": 0.0, "speed": 0.90 },
    "books": {
      "JON": { "enabled": true },
      "RUT": { "enabled": true, "chapters": "1-4" }
    }
  }
  ```
  Books/chapters are opt-in — this is how "one book at a time" is enforced.
- **`detect-changes.js`** — when `BIBLE=true` (or always, as an extra pass): for each
  enabled book, read `bibles/{tx}/content/{code}.SFM`, call `usfmBookToChapters`, and for
  each enabled chapter run `preprocessSession(markdown, voiceId, 'en', true)` and emit a
  work item with:
  - `bookSlugPath = "bible/{tx}/{book-slug}"`  → GCS `audio/bible/{tx}/{book-slug}/`
  - `sessionFile  = "{NN}.md"` (zero-padded chapter, e.g. `001.md`) → slug `001`
  - `contentHash  = sha256(plainText)` (same reuse semantics — regen only changed chapters)
- **`generate.yml`** — add a `translation` + `book` (+ optional `chapters`) dispatch input
  and a `bible` mode flag routed to `detect-changes.js`. Everything else (checkout of
  `Noble-Imprint-Resources`, ffmpeg, GCP auth, credit snapshot, cache refresh) already
  exists.
- **GCS result:** `audio/bible/bsb/jonah/manifest.json` with per-chapter sessions —
  identical shape to a series book manifest.

### Layer 3 — Website: player in the `/bible` reader
- **`audio.js`** — add `getBibleAudioManifest(tx, bookName)` and
  `getBibleAudioChapter(tx, bookName, chapter)` reading
  `audio/bible/{tx}/{book-slug}/manifest.json` (parallel to `getAudioManifest`/
  `getAudioSession`; reuse the cache + signed-URL helpers). Add matching
  `/api/audio/url/bible/…` handling (or a small bible-specific URL route).
- **Rendering (the important part) — render audio-enabled chapters from the converter's
  blocks so on-screen text == audio segments.** For a chapter that has audio, the
  `/bible` chapter page renders the scripture as the **paragraph + `<sup>` block form**
  (same as `samples/psalm-1-2.md` / HomeStead), i.e. `<h1>` chapter, `<h3>` section
  headings, `<p>` paragraphs with superscript verse numbers — the exact block structure
  the timestamps were computed against. This makes `buildSegmentMap`/`applySentenceHighlight`
  work **unchanged** (they already sync this structure on HomeStead). We port
  `usfm-to-markdown.js` (or a compiled blocks JSON) into the website's `bible.js` so both
  sides share one source of truth.
  - *Visual note for Steve:* audio-enabled Bible chapters would read as verse-numbered
    paragraphs rather than the current one-span-per-verse layout. Standard reading-Bible
    look; confirm you're happy with it (chapters without audio keep today's layout).
- **`bible-chapter.ejs`** — add the `audio-fab` + sticky-player markup (copy from
  `session.ejs:27–56`) and load `audio-player.js`, gated on "audio exists for this
  chapter." Wire `data-book-path`/`data-audio-file`/`data-timestamps-file`/`data-duration`
  to the bible manifest entry, and `data-next-url` to the next chapter.
- **AJAX next-chapter** (optional, later) — mirror `/api/session-data` so playback can
  roll into the next chapter without a reload.

---

## Sync strategy (why Option B's main risk is neutralized)
The risk in native `/bible` was that its verse-span DOM wouldn't match the audio segments.
We remove the risk by **rendering audio chapters from the same converter blocks the audio
was generated from** — the player then sees the identical `<h1>/<h3>/<p>` structure it
already syncs on HomeStead. No changes to `buildSegmentMap`/`applySentenceHighlight` needed.
(If we later want the verse-span aesthetic *with* audio, that's a separate,
harder matching task we can defer.)

---

## End-to-end workflow per book
1. **Convert (dry-run)** — `node src/usfm-to-markdown.js --tx bsb --book JON --dry-run`:
   inspect markdown + spoken preview + credit estimate. Fix converter until clean (no `\`
   leaks, headings sentence-cased, verse numbers silent, superscriptions spoken).
2. **Enable** — add/extend `bibles/bsb/meta.json` `audiobook.books.{CODE}.enabled = true`
   with the voice ID; commit + push `Noble-Imprint-Resources` (auto-dispatch is off → no
   spend).
3. **Smoke-test one chapter** — `gh workflow run generate.yml -f bible=true -f translation=bsb
   -f book=JON -f chapters=1`; confirm credits, then verify audio + highlight on the site.
4. **Generate the book** — dispatch for all chapters; unchanged chunks reuse cache (0
   credits). Verify a couple of chapters end-to-end.
5. **Iterate** — converter/markdown fixes re-run only affected chapters.

---

## Cost model
`credits ≈ spoken_chars`, `$1.65 / 10,000`. `--dry-run` prints the estimate from
`references.json`/converted text. Rough BSB verse-text-only: Jonah ~4.5k (~$0.7), Ruth
~5k, Philippians ~6.5k, a single Psalm ~1–3k. Regen of one changed chapter re-spends only
that chapter.

---

## Work breakdown
### Phase 1 — Converter (generation repo) — ✅ DONE + validated 2026-07-29
- [x] `src/usfm-to-markdown.js` — parse, verse-continuation reassembly, stanza grouping
      (breaks only on `\p`/`\m…`/`\b`/headings — NOT per `\q`, so poetry reads as
      paragraphs), `<sup>`/heading emission, `\d` superscription handling, footnote/xref/
      char-style stripping, generic-marker fallback, `assertClean` self-check. CLI:
      `--tx --book --chapters --resources --out --print --label`.
- [x] Book-file resolution by USFM code (BSB `*{CODE}BSB.SFM` / KJV `*{CODE}eng-kjv.usfm`).
- [x] CLI `preprocessSession` spoken preview + char/credit estimate (zero spend).
- [x] Acceptance: converted Psalm 1–2 ≈ identical to `samples/psalm-1-2.md` (only diff:
      H1 "Psalms 1" vs sample "Psalm 1" — `--label "Psalm"` override available).
- **Bug fixed during validation:** the `\ms`/`\mr` skip regex had an optional `s`
      (`/^\\ms?\d?\s/`) that also swallowed the prose `\m ` marker, dropping every `\m`
      continuation line (e.g. 2 Tim 1:2 "Grace, mercy, and peace…"). Now requires the `s`.
- **Validated numbers (BSB):** 2 Timothy 4 ch = 9,910 spoken chars ≈ **$1.64**;
      Proverbs 31 ch = ~80,112 chars ≈ **$13.22**. Both convert with no self-check failures.

### Phase 2 — Generation wiring (generation repo) — ✅ CODE DONE 2026-07-29
- [x] `bibles/bsb/meta.json` `audiobook` block (Ali voice `MI88rOZjXbH22N8KHXUo`, speed 0.90,
      `language_normalization: true`, `books: { PRO:{enabled}, 2TI:{enabled} }`).
- [x] `detect-changes.js` — `findBibleWorkItems()` + `BIBLE_BOOK`/`BIBLE_TRANSLATION`/
      `BIBLE_CHAPTERS` env; when `BIBLE_BOOK` set it's a BIBLE-ONLY run (series skipped).
      Work items slugged `bible/{tx}/{book-slug}`, sessions `NNN.md`. `generate.js` untouched.
      Verified work-item shape locally (2 Tim 1 → 16 blocks h1/h2/p, 24 sentences, hash).
- [x] `generate.yml` inputs `bible_book`, `bible_translation`, `bible_chapters` → detect env.
- [ ] **Smoke-generate one chapter (needs push + dispatch + ~$0.40 spend + Steve OK)** →
      confirm GCS `audio/bible/bsb/2-timothy/…` manifest + timestamps look right.

### Phase 3 — Website player (website repo) — ✅ CODE DONE + verified locally 2026-07-29
- [x] `src/server/usfm-audio.js` — CommonJS port of the converter. **Byte-for-byte parity
      with the ESM converter across all 35 chapters** (2 Tim + Proverbs) → DOM matches
      timestamps by construction. Keep in sync with the audiobooks repo copy.
- [x] `audio.js` — `getBibleAudioManifest(tx, bookName)` + `getBibleAudioChapter(...)`
      (reads `audio/bible/{tx}/{slug}/manifest.json`). Existing `/api/audio/url/*` route
      signs bible paths unchanged (prepend `series/` then strip is a no-op + idempotent slug).
- [x] `bible.js` — `getAudioChapterBlocks(tx, code, chapter)`: resolves USFM filename via a
      cached content-dir listing (by code from the manifest's bookPath), fetches + parses,
      returns blocks. **No CACHE_VERSION bump** (avoids a forced GitHub rebuild on deploy).
- [x] `index.js` — bible chapter route now async; looks up audio session + converter blocks,
      passes `audioSession`/`audioBlocks`/`audioBookPath`/`audioFormatDuration`. Degrades to
      text-only on any failure.
- [x] `bible-chapter.ejs` — audio-fab + sticky player markup + `audio-player.js` (gated on
      audio); audio chapters render from converter blocks (paragraphs + `<sup>`), else the
      existing verse-span layout.
- [x] Verified locally: route 200; graceful text-only fallback when GCS unreachable;
      `getAudioChapterBlocks('bsb','2TI',1)` → 15 blocks (h2,p,p,p,h2,…) via GitHub;
      24/24 unit tests pass. GCS manifest read only fails on the local-dev SA (no bucket
      IAM) — production SA reads the bucket (existing series audio proves this).
- Known minor limitation: audio chapters lose per-verse `id="vN"` anchors (rendered as
      paragraphs with inline `<sup>`). Fine for MVP; revisit if verse deep-linking matters.
- [ ] (Later) AJAX next-chapter continuous playback; optional site-wide paragraph style.

### Phase 4 — Ship (needs Steve OK: deploy + ~$15 spend)
- [ ] Commit + push website repo → auto-deploys to live (~3 min).
- [ ] Verify 2 Timothy 1 on the LIVE site (plays + highlight syncs) — proves the GCS
      render branch on real infra before the full spend.
- [ ] Generate remaining chapters: 2 Timothy 2-4 (~$1.25) + Proverbs 1-31 (~$13.20).
- [ ] Final verify on live.

### Phase 4 — Ship the 2 books
- [ ] Book 1 & 2: convert → review → enable → generate → verify → set rollout (public/hidden).

---

## Risks & mitigations
- **Timestamp hard-fail** from a leaked USFM marker/tag → converter self-check rejects any
  `\` or non-`<sup>`/`<break>` tag before generation.
- **Poetry phrasing** → tune stanza grouping on a psalm during dry-run before spending.
- **`\d` superscriptions** dropped by the reference parser → we explicitly emit them.
- **KJV footnotes** (dot/stacked) → regex handles `[\d.:]+` + adjacency; moot for BSB.
- **Two code copies of the converter** (gen repo + website) → port carefully or extract a
  tiny shared module/npm-less copy with the Psalm-1–2 diff test guarding both.
- **Credits** → always `--dry-run` + check estimate; regen only changed chapters.
- **Bible-page visual change** for audio chapters (paragraph/`<sup>` vs verse-spans) →
  confirm with Steve; non-audio chapters unchanged.

---

## Still needed from Steve
- The 2 book names + the ElevenLabs **voice ID** (from the `/voice-test` pick).
- Public vs hidden for the initial rollout.
- Sign-off on the audio-chapter visual (verse-numbered paragraphs).
