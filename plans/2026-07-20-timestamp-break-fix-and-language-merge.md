# Plan: Fix audiobook timestamp overlaps + unify `main` with the language layer (gated)

**Date:** 2026-07-20
**Author:** Claude (with Steve)
**Repo:** `Noble-Collective/Noble-Imprint-Audiobooks`
**Status:** Draft — awaiting approval. No code pushed, no audio regenerated yet.

---

## 1. Goal

Two outcomes, achieved together with **zero ElevenLabs credits** and **no regressions**:

1. **Fix the sentence-highlighting bug** in the web reader (timestamp overlaps in Seneca + L'Appel).
2. **Unify everything onto one `main`** — bring the parked language layer in alongside main's audio-quality work, but keep language normalization **dormant behind a default-off switch** so merging reprocesses nothing.

---

## 2. Background — the bug

A listener reported that in *On the Shortness of Life*, Ch3 "Section 10", highlighting stops when audio reaches the large "10". The app developer correctly narrowed it to a timestamp overlap in the audio data.

**Confirmed root cause (live GCS data + offline repro):**
The generator prepends a literal `<break time="2s"/>` SSML tag to body paragraphs that follow a blockquote summary (`preprocess-tts.js` on `main`, the "blockquote → body pause" feature). Because paragraph blocks have no clean `displayText`, that tag leaks into the stored **sentence text**. The timestamp matcher (`generate.js` `buildTimestampsFromAlignments`) strips `<break>` tags from the audio-alignment side but **not** from the sentence needle, so that sentence fails `indexOf`, falls back to a proportional time estimate, and lands out of order relative to the next (correctly-matched) sentence. There is no monotonic-order guard, so nothing catches it.

**Live proof** (`04-chapterthree.timestamps.json`):
```
[7] 72.63→83.01  "<break time="2s"/>If I chose to divide this proposition…"
[8] 48.79→76.86  "Fabianus, who was none of your lecture-room philosophers…"
```
"Fabianus" starts 24s before the sentence that precedes it, and they overlap → highlighter loses the thread for a paragraph or two.

**Full audit — all 36 deployed timestamp files, 9,508 segments:**

| Book | Status | Corrupted segments |
|---|---|---|
| On the Shortness of Life (Seneca) | ⚠️ | **20** across 6 of 8 sessions |
| L'Appel du Christ | ⚠️ | **5** (one per body session; French blockquote→body) |
| Oration II | ✓ clean | 0 |
| HomeStead | ✓ clean | 0 (uses `<<` attributions, not the blockquote→body pattern) |
| Proverbs and Faith Formation | ✓ clean | 0 (regenerated 2026-07-14 on the fix branch) |

**Total: 25 corrupted segments, one root cause.** Every segment with a `<break>` in its text is out of order 1:1. No other failure modes found. (L'Appel frontmatter has two segments containing the CC-license URL `<https://…>` in the text — cosmetic, matches and orders fine, out of scope.)

> Note: the `<break>` in stored text also breaks the web reader's DOM sentence matching independently of timing. Stripping it from the sentence text fixes both the ordering and the DOM match.

---

## 3. The branch situation (and why the gated merge is safe)

The code split on 2026-06-27 at commit `249033d` ("Strip ChapterNum tags"). Since then:

**`main` gained 4 commits (audio quality):**
- `0a4f512` Add pause after blockquote summaries (+ sub-paragraph number fix)
- `da60f6a` Increase blockquote→body pause 1s → 2s
- `ea3a746`, `0238ae5` Deduplicate break tags between consecutive headings

**`fix/tts-range-language-layer` gained 2 commits (parked language layer):**
- `219793a` Per-language scripture/number normalization (`src/languages.js`)
- `33f1502` docs

Neither branch is a superset. The language layer was **deliberately parked** on its branch — merging it would have armed the next content push to auto-regenerate every changed session (credits). That is the *only* reason it lives on a branch.

**Files differing between the branches:** `README.md`, `detect-changes.js`, `languages.js` (new), `preprocess-tts.js`, `realign.js`, `retimestamp.js`. **`generate.js` is identical on both** (chunker + matcher are shared).

**Why merging-with-the-flag-off is provably free.** `main`'s current preprocessing = "merged main with language normalization off". Re-running it and hashing every chunk against the real cached GCS chunk hashes:
```
Shortness of Life: 0/127 chunks would re-synthesize  ✓ ALL CACHED
L'Appel du Christ: 0/237 chunks would re-synthesize  ✓ ALL CACHED
TOTAL: 0/364 chunks change → merging with the flag off triggers ZERO regeneration.
```
(This also confirms the deployed audio came from exactly `main`'s code — every hash matched.)

For contrast, adopting the fix branch as-is (language layer active) would re-synthesize 103/364 chunks ≈ **77,700 credits** (~$12.82) and would *drop* main's 4 audio-quality commits. This plan avoids both.

---

## 4. Design decisions

### 4.1 Reconcile by re-applying, not raw-merging
`main`'s `preprocess-tts.js` is the more advanced file (blockquote pause + heading-dedup). The fix branch's copy is 99 lines *smaller* and predates that work. A raw `git merge` would produce awkward conflicts in `flushParagraph`/heading regions. Instead: **cherry-pick `src/languages.js` verbatim and hand-insert the gated `normalizeSpoken`/`convertReference` calls into `main`'s structure.** Cleaner and fully reviewable.

### 4.2 The gate: per-book, default-off
- New optional flag in each book's `meta.json`: `audiobook.language_normalization: true`. **Absent/false = off = pass-through.**
- `language: "en"|"fr"` remains the locale, used only when normalization is on. Committing the staged `language` fields is safe (inert while gated off).
- Rollout later is per-book: set the flag `true` on one book + regenerate → activates only that book, paying only that book's cost.

### 4.3 The timestamp fix: strip `<break>` at the source
Strip `<break…/>` from sentence text when building the `sentences[]` array (source of truth for both timing and DOM highlighting). Keep the tag in the TTS/`plainText` chunk text so the audio pause and chunk hashes are unchanged. Add a defense-in-depth strip in the matcher needle, and a post-build validation guard.

---

## 5. Implementation steps

### Phase 0 — Consolidate working copies (recommended, housekeeping)
Two local clones exist: `Noble-Imprint-Audiobook` (on `main`) and `Noble-Imprint-Audiobooks` (on the fix branch), both pointing at the same GitHub repo. Pick **`Noble-Imprint-Audiobooks`** as canonical (correct name, has both branches), do all work there, and stop using the singular clone to avoid confusion. Not a data risk — just hygiene.

### Phase 1 — Bring the language layer onto `main` (gated, 0 change)
1. Branch off `main`: `git checkout main && git pull && git checkout -b feat/unify-main-gated-language`.
2. `git checkout fix/tts-range-language-layer -- src/languages.js` (bring the file in verbatim).
3. Edit `src/preprocess-tts.js` (main) per §6.1 — import, add gate, insert gated calls.
4. Thread the flag through callers: `generate.js`, `detect-changes.js`, `realign.js`, `retimestamp.js` (§6.2). Read from `meta.audiobook?.language_normalization === true`.
5. **Verify 0 change:** re-run `scratchpad/prove-gate.mjs`-equivalent against this branch → expect `0/364 chunks change` for every book. Gate is correct iff this holds.

### Phase 2 — Timestamp bug fix (2 edits) — §6.3
1. `preprocess-tts.js`: strip `<break…/>` from paragraph sentence text.
2. `generate.js`: strip `<break…/>` from the matcher needle.

### Phase 3 — Validation guard — §6.4
Add a post-build check in `buildTimestampsFromAlignments`: assert segment `start`s are monotonic non-overlapping and no segment `text` contains `<`. Log loudly and (in CI) fail the run if violated. This is the guardrail that would have caught the original bug.

### Phase 4 — Fix the deployed timestamps (0 credits)
1. Merge `feat/unify-main-gated-language` → `main`, push.
2. Force-regenerate the two affected books (chunks all cached → audio identical → only timestamps rebuilt):
   ```
   gh workflow run generate.yml --ref main \
     --field book_path="series/A Library of Classics/A Philosophical Shelf/On the Shortness of Life" \
     --field force_regenerate=true
   gh workflow run generate.yml --ref main \
     --field book_path="series/Narrative Journey Series/Foundations/L’Appel du Christ" \
     --field force_regenerate=true
   ```
   (Confirm exact input names against `generate.yml` before running.)
3. Watch the run logs: expect "reusing cached chunk" for every chunk and **0 ElevenLabs characters synthesized**. If any chunk synthesizes, stop and investigate before it spends credits.

### Phase 5 — Commit language metadata (inert)
Commit the staged `language` fields in `Noble-Imprint-Resources/.../meta.json` (5 books). Harmless while `language_normalization` is off. Do **not** set `language_normalization: true` on any book yet.

---

## 6. Exact edits

### 6.1 `src/preprocess-tts.js` (main) — add gated language normalization
- **Import** (top of file):
  ```js
  import { normalizeSpoken, convertReference } from './languages.js';
  ```
- **Signature + gate** — change `preprocessSession(markdown, voiceId)` to accept language + flag, and build a local `norm()`:
  ```js
  export function preprocessSession(markdown, voiceId, language = 'en', languageNormalization = false) {
    const norm = languageNormalization ? (t) => normalizeSpoken(t, language) : (t) => t;
    const cref = languageNormalization ? (t) => convertReference(t, language) : (t) => t;
    // …
  ```
- **Call sites** (mirror the fix branch, but gated): apply `norm(text)` to paragraph text in `flushParagraph`, `norm(text)` to heading spoken text, and `cref(...)` where attributions are converted.
- **Sanity:** with `languageNormalization=false`, `norm`/`cref` are identity → output identical to today (Phase 1 step 5 proves it).

### 6.2 Thread the flag through callers
In `generate.js`, `detect-changes.js`, `realign.js`, `retimestamp.js`, at each `preprocessSession(md, voiceId, meta.language || 'en')` call, add the flag:
```js
preprocessSession(md, voiceId, meta.language || 'en', meta.audiobook?.language_normalization === true)
```

### 6.3 Timestamp bug fix (2 edits)
- `src/preprocess-tts.js`, paragraph sentence build (main ~line 186–188):
  ```js
  const sents = splitSentences(block.nodes[0].text);
  for (let si = 0; si < sents.length; si++) {
    const clean = sents[si].replace(/<break[^>]*\/>/g, '').replace(/\s+/g, ' ').trim();
    if (clean) sentences.push({ blockIndex: bi, sentenceIndex: si, text: clean });
  }
  ```
  (Headings already use clean `displayText` — no change needed.)
- `src/generate.js`, matcher needle (line 274):
  ```js
  const needle = sent.text.toLowerCase().replace(/<break[^>]*\/>/g, '');
  ```

### 6.4 Validation guard — `src/generate.js`, before `return { segments }` (line 323)
```js
// Guard: sentence text must be SSML-free and timestamps must be monotonic.
for (let i = 0; i < segments.length; i++) {
  if (/</.test(segments[i].text)) {
    console.warn(`    [validate] markup left in segment ${i}: ${JSON.stringify(segments[i].text.slice(0,60))}`);
  }
  if (i > 0 && segments[i].start < segments[i-1].start - 0.5) {
    console.warn(`    [validate] OUT-OF-ORDER segment ${i}: start ${segments[i].start} < prev ${segments[i-1].start}`);
  }
}
```
(Start as warnings so we can eyeball the first run; consider promoting to a hard failure in CI afterward.)

---

## 7. Verification / acceptance criteria

- **Phase 1:** gate proof shows `0/364 chunks change` on all books.
- **Phase 4 run logs:** 0 characters synthesized; every chunk reused from cache.
- **Post-regen timestamp audit:** re-download `04-chapterthree.timestamps.json` (+ the other 5 sessions) and re-run the audit script → **0 break-in-text, 0 out-of-order, 0 overlap** across Seneca + L'Appel.
- **Manual spot check:** play Seneca Ch3 from "Section 10" on the live site; highlighting tracks continuously through the "10" and the Fabianus paragraph.
- **No regressions:** Oration II / HomeStead / Proverbs timestamps untouched; Seneca audio bytes unchanged (blockquote pauses preserved); heading-dedup still present.

---

## 8. Cost & risk

| Path | Credits | Audio changes? | Regressions | Effort |
|---|---|---|---|---|
| **This plan (gated merge + break fix)** | **0** | No (byte-identical) | None | ~5 small edits + 1 merge |
| Regenerate on fix branch | ~77,700 | Yes (re-render + loses Seneca pauses) | Drops main's 4 commits; ships language layer unintentionally | Low (just run workflow) |

**Residual risks & mitigations**
- *Gate wired wrong → silent normalization on.* Mitigated by the Phase 1 `0/364` proof gate — do not proceed if it fails.
- *A chunk synthesizes during Phase 4.* Mitigated by watching logs and aborting on first synthesis.
- *`force_regenerate` input name differs.* Confirm against `generate.yml` before dispatch.
- *Merge conflicts in `preprocess-tts.js`.* Avoided by re-applying (§4.1) instead of raw-merging.

---

## 9. Rollback

- Timestamps are the only deployed artifact touched. The pre-fix `*.timestamps.json` files for the 6 Seneca + 5 L'Appel sessions can be backed up from GCS before Phase 4 (`gcloud storage cp … ./backup/`) and restored if needed.
- Code changes live on `feat/unify-main-gated-language` until merged; revert the merge commit to undo.
- No audio (`.mp3`) or chunk alignment (`.align.json`) files are modified.

---

## 10. Follow-ups (separate, later)

- **Per-book language rollout:** flip `language_normalization: true` one book at a time + regenerate; budget ~19K (Seneca) / ~59K (L'Appel) credits per the measured chunk-delta.
- **`retimestamp.js` is currently broken** (expects `000/001…` chunk names; actual are 16-hex content hashes; uses 4,500-char chunking vs the ~800 block-walk; still has the naive case-sensitive matcher). Running `retimestamp.yml` today would proportionally estimate whole chapters. Either fix it to match `generate.js` or retire it. Not needed for this plan (Phase 4 uses `generate.js`).
- Consider promoting the §6.4 validation warnings to hard CI failures.
