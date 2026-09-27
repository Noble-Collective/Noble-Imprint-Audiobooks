# Timestamp pipeline fixes — deep dive (2026-09-27)

**Status: BUILT (Steve approved 2026-09-27 "yes lets build this and do it")**, scope widened
to include Bible word timings (the app's A–B loop, Noble-Imprint-App docs/AUDIOBOOKS.md §6d).
- Code: `preprocess-tts.js` `buildSentenceIndex` (heading `matchText` = spoken text);
  `generate.js` `buildTimestampsFromAlignments` (spoken needle, `cleanSegmentText`,
  `opts.words` for Bible, `opts.trace`), `buildChunks` (extracted from main, shared),
  `serializeTimestamps` (one segment per line).
- Rebuild: `src/rebuild-timestamps.js` + `.github/workflows/rebuild-timestamps.yml`
  (dry-run default, write = backup to `audio/_backup/2026-09-27-timestamps/` then rewrite).
  Safety: chunk hashes == manifest; OLD algorithm must reproduce the published file (chunk
  offsets solved from it, ffprobe cross-check ≤0.06 s/chunk — a local static ffprobe
  measured ~1 frame differently); NEW may differ in time only on `matchText` headings.
- Tests: `tests/timestamps.test.mjs`, `tests/tts-stability.test.mjs` (whole-library golden
  of narrated text + sentence index — proves no TTS/hash change).
- Local read-only dry-run via public API: Genesis 28 title 0–7.98 → 0–1.75 s (mp3 energy
  said ~1.7 s), 28/29 segments with words, 6.5 → 18 KB.
- Found + fixed a dangerous README line: it said `force_regenerate=true` rebuilds timestamps
  for 0 credits — a forced run bypasses the chunk cache and re-narrates everything.

## Root cause (verified on published data)
`preprocess-tts.js` gives a heading sentence its DISPLAY text ("Genesis 28") but the
narrator reads the SPOKEN text ("Genesis, Chapter 28" via `spokenChapterTitle`).
`buildTimestampsFromAlignments` searches the chunk text for the display text, fails,
and falls back to a proportional guess: start 0, end = duration / sentenceCount
(Genesis 28: 231 s / 29 = 7.97 → published 0–7.99 s). Real end from the chunk-0
alignment: 1.753 s (matches the mp3 energy measurement). Psalms are unaffected
(spoken "Psalms 23" == display).

## Measured across the whole library (1,218 published timestamp files, 55,589 segments)
- 1,027 Bible chapter titles use the proportional guess and overlap the next segment.
  **This is the only timing defect.** No mid-chapter overlaps, no backwards starts.
- Markdown in `segment.text`: `>` 3 (Call of Christ confessional statement ×3
  sessions), `###` 2 (front matter), leading `- ` list markers in a few hundred
  (Oration II bibliography, Call of Christ / L'Appel Key Elements). 34 sentences hold
  2+ list items. Some ` - ` are real punctuation ("Fondations - L'Appel du Christ").

## Consumers
| | Title end fix | Strip markdown | Split lists |
|---|---|---|---|
| App | no visible change (already caps ends) | none (fold-based alignment) | none |
| Resources site (`audio-player.js`) | **FIXES**: first-match-wins → title lit ~6 s, 1st section heading never lit, verse 1 late, in 1,027 chapters | +3 segments (the confessional statement); list items still unmatched (`li` not a candidate) | RISKY: needs `li` in the selector + `?v=` bump |
| Coram Deo | none (latest-start rule already works around it) | none (Bible has no markdown) | none |
| Institute / Collective-Shared | don't read timestamps | — | — |
Nothing anywhere persists a segment index (resume = seconds in localStorage).

## Proposal
1. Pipeline code: heading sentences keep `text = displayText` but match with the
   SPOKEN needle; strip markdown from the OUTPUT `text` only (never from TTS text — that
   would change chunk hashes/contentHash → paid regeneration). Timestamp-only change.
2. Backfill: for each session whose segment 0 has the fallback fingerprint, read the
   chunk-0 `align.json` (title is always in chunk 0, offset 0), set `segments[0].end` to
   the spoken title's last-char end time. Nothing else changes. Back up each original
   first (`audio/_backup/2026-09-27/...`). Dry-run report → approval → write.
3. Skip list splitting (low value, only risky on the website).

Rollback = copy backups back. No TTS, no manifest change, no refresh needed.
