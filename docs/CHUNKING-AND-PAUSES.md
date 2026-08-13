# Chunking Strategies & Pause Model

How a chapter is split into ElevenLabs generations, and how pauses are produced. This is the
authoritative reference for the two chunking strategies and the shared pause model introduced in
the 2026-08 pipeline reconciliation (see `plans/2026-08-12-audiobook-pipeline-reconciliation.md`).

---

## Two chunking strategies

Each book selects one via `meta.audiobook.chunking_strategy`:

| | `"linear"` (regular books) | `"section"` (Bible) |
|---|---|---|
| function | `splitLongBlocks` + `chunkText` | `buildNaturalGenerations` |
| target size | `TARGET_CHUNK_SIZE = 800` | one generation per heading-span, capped at `MAX_GENERATION = 2000` |
| generation shape | many small (~200–800) | few large (a heading + its verses) |
| heading levels that split | h1/h2/h3 | h1/h2/h3 (h4–h6 read inline) |
| pauses | `<break>` tags (both sides) + leading-break seams | concat silence before a section + `<break>` after in-generation headings + light seam at cap-splits |
| used by | Oration II, On the Shortness of Life, HomeStead, … | `bibles/bsb` (2 Timothy, Proverbs) |

Every audiobook `meta.json` declares its strategy explicitly. Legacy `natural_mode: true` maps to
`"section"` for back-compat. Default (absent) is `"linear"`.

**Why two:** the section strategy exists because the Bible voice runs at **stability 0.50**, where
`<break>` tags at a generation *edge* are unreliable, and because verse-dense scripture paces best
as a few long, flat generations. Regular prose books at stability ~0.71 work well with the linear
approach and did not need changing. The two strategies share all downstream machinery (TTS call,
concat, timestamps, loudness, upload); only the split logic and a couple of pause toggles differ.

---

## The section strategy (`buildNaturalGenerations`)

1. **Group into heading-spans.** A "section" is a boundary heading (h1/h2/h3) plus the blocks under
   it, up to the next boundary heading. Adjacent headings (chapter title + first section heading)
   stay together. h4–h6 are **not** boundaries — they read inline within their section.
2. **One generation per section**, so the heading is read INLINE at verse pace. Do NOT isolate a
   heading into its own generation: at stability 0.50 a lone short heading reads slow/drawn-out
   (the chapter title came out ~7.7s).
3. **Cap at `MAX_GENERATION = 2000`.** A section over the cap is packed into sub-generations of
   ≤ 2000 chars at verse boundaries (a single block over the cap is sentence-split via
   `splitLongBlocks`). Chosen from a dry-run: 2 Timothy splits 0 sections; Proverbs' long tail
   ~31%. Every generation stays inside the ~2,200-char range verified to pace flat, and nothing
   approaches the ElevenLabs per-request limit (~10k).

Returns `{ texts[], gaps[], continuations[] }`: `gaps[i]` = silence before generation *i*;
`continuations[i]` = true if *i* is a mid-section cap-split (flows continuously from the previous
generation).

---

## The pause model

The one fact that drives everything: **a `<break>` tag renders reliably INSIDE a generation, but is
trimmed/unreliable AT a generation edge** (ElevenLabs trims edge silence — trailing breaks vanish,
leading breaks render only ~85% and variably). So:

| pause position | mechanism | why |
|---|---|---|
| **after** an in-generation heading (title → greeting → verse 1) | `<break time="Xs"/>` in the text | mid-generation, so it renders reliably |
| **before** a section heading (generation boundary) | real **concat silence** (`gaps[]`) | at an edge, a break can't be trusted → deterministic silence |
| **at a cap-split** (mid-section, no heading) | **light 0.4s concat silence** | continuous content; a breath, not a section pause |

Heading durations (`HEADING_GAP`): h1 = 2.0s, h2 = 1.5s, h3–h6 = 1.0s.

**Sync safety.** Both mechanisms are safe for the web highlighter:
- `<break>` silence is captured by ElevenLabs' returned alignment, so timestamps built from that
  alignment include it automatically.
- concat silence is inserted by `concatenateChunks`, which **returns the actual gap durations**;
  those exact numbers are fed to `buildTimestampsFromAlignments`.
- **Never** put a gap only in the timestamps. A prior bug (`CHUNK_GAP_SECONDS`) added a gap the
  timestamps used but the audio didn't → the web highlight drifted +gap per boundary. The code
  carries a prominent warning about this; `concatenateChunks` returning `actualGaps` is the guard.

**The `previous_text`/`next_text` rule.** These condition a generation's edges on neighboring text
to smooth a *continuous* seam. They are supplied only where audio actually flows:
- linear chunks: always (leading-break seams are continuous);
- section generations: **only across a cap-split** (`continuations[i]`), NOT across a deliberate
  section pause — there, `next_text` made a generation anticipate the next section's first word and
  bled a faint fricative into its tail (an audible "f" from a following "Faithfulness" heading, just
  before the pause). Request stitching (`previous_request_ids`, audio-based tempo continuity) is
  kept regardless; it does not bleed words.

---

## Concatenation

`concatenateChunks` joins generations via the ffmpeg **concat filter (re-encode once)**, inserting
sample-exact `anullsrc` silence for each gap. It does **not** byte-concat (`-c copy`): libmp3lame
silence files carry a Xing/LAME header, and a header frame landing mid-stream made players mis-read
duration and stop early (audio played fast and cut off after the first chunk). The filter produces a
single clean stream, and the inserted silence is sample-exact, so the returned gaps are exact.

---

## Version stamp & staleness

Each manifest session records `pipelineVersion` (bumped when generation LOGIC changes) and
`chunkingStrategy`. This makes staleness queryable — which shipped books would change on re-render.

**Caveat:** the chunk cache is keyed on chunk **text** only (`hashChunk = sha256(text)`). A **text**
edit correctly re-renders the affected generation(s). A **logic/settings** change that alters audio
but not chunk text (voice settings, concat method, loudness) does **not** invalidate the cache —
those need `force_regenerate`. So a normal (push-triggered) regen after a pipeline change refreshes
only text-changed parts; to fully adopt a logic change, force a re-render per book.

---

## Incremental re-render granularity

Generation reuse is keyed on exact chunk text; only changed hashes hit ElevenLabs.

- **Linear:** a typo fix usually re-renders **1 small chunk**. If the edit shifts a size boundary,
  the cascade of downstream chunks is bounded by the next h1/h2/h3 (the walker resets at headings).
- **Section:** a fix re-renders the **whole heading-span generation** (~1,300–2,000 chars) — coarser
  per edit, but more robust to partial re-renders: a reused generation resets the request-stitch
  chain, and the deliberate silence between sections hides any prosody mismatch that a linear
  continuous seam would expose.
