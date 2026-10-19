# Eleven v4 evaluation + Bible narration fixes (2026-10-15)

**Status: CLOSED 2026-10-18 — the whole BSB Bible is on Eleven v4.** See "Outcome" at the end.

Steve's ask: evaluate Eleven v4 against today's pipeline on the Bible, which still has issues —
**Numbers 1's large numbers** read poorly, and the narration **gets slow at times** — and replace
the hard-coded pause durations with kinds of pause that each model can render.

## What was wrong (measured on the live Numbers 1)

1. **Large numbers** went to ElevenLabs as raw digits ("numbered 46,500"), crammed straight
   after "numbered" with < 0.1 s pause. 619 numerals across the BSB narration text (322
   comma-grouped, in 71 chapters); no references or decimals.
2. **Within-generation slowdown.** Articulation rate falls inside each ~2,000-char section
   generation, e.g. 20 → 14 letters/s (3 of 5 sections in Numbers 1). Same effect as the
   2 Timothy finding in 2026-08.
3. **Stray periods.** `preprocess-tts.js` appended "." to any paragraph not ending in
   `. ! ? : … —` — so `;`, `,` and closing quotes got one: `Shedeur;.`, `Enan.”.` (11 in Numbers 1).

## What was built (all opt-in, production unchanged)

- `src/pauses.js` — pauses by kind (title / section / subsection / transition / seams / breath).
  v2 renders `<break time>` with the shipped durations; v4 renders `[long pause]`/`[short pause]`.
  Style comes from `model_id` (`pause_style` overrides). Timestamp builder + guard handle both.
- `meta.audiobook.spell_numbers` — numerals → words in the spoken text only
  (`languages.js numberToWords/spellNumbers`); sentences keep the digits as `text` and the
  words as `matchText`, so the highlight still matches the page.
- `meta.audiobook.clean_terminal_punctuation` — no stray period after `; ,` or a closing quote.
- Proof of no production change: TTS fingerprint 0/1,234 sessions differ; chunk hashes
  0/5,749 differ (old vs new code over the whole Bible + series). 18 tests pass.
- `v4-probe.yml` (API facts — see docs/ELEVENLABS-MODELS.md §3) and `model-ab.yml` (this A/B).

## The A/B (run 38748183774)

Pages: https://resources.noblecollective.org/voice-test/ab-numbers-1 and
https://resources.noblecollective.org/voice-test/ab-acts-27 (metrics.json alongside in GCS).

| | Model | Fixes | Numbers 1 | Acts 27 | Timestamps matched |
|---|---|---|---|---|---|
| A | v2 (live) | — | 446 s | 426 s | (live) |
| B | v2 | ✅ | 487 s | 430 s | 52/52, 62/62 |
| C | **eleven_v4** | ✅ | 402 s | 357 s | 52/52, 62/62 |
| C2 | v4, atempo 0.90 | ✅ | 446 s | 397 s | (scaled from C) |

Articulation rate per section, by fifths (letters/s):

- **A live, Numbers 1:** 17.5 19 15.4 14 15.5 · 17.1 13.3 14.4 12 16.4 · 14.5 … 18.6 · … · 20 16.6 14.9 15 14.2
- **B v2+fixes, Numbers 1:** 16.5 19.5 15 14.1 13.4 · 16.9 13.8 15.1 11.3 17.1 · 14.6–15.9 · 14.7–15.5 · 16.1 … 14.7
- **C v4, Numbers 1:** 18.5 21.1 18.7 20.2 20.2 · (name list) 18.6 14.3 15.7 13.7 22.7 · 18.9 21.2 22.4 22 22.9 · 21.7 22.7 22.2 21.6 21 · 20.9 21.2 20.3 21.8 20
- **C v4, Acts 27:** 20.2 22.4 19.2 20.1 20.2 · 20.1 21.4 19.3 18.5 16.4 · 21.6 21.1 20.7 23.3 21.2

Reading of the numbers (the ear decides):
- **v4 holds its pace through a long section** — no wind-down in the 2,000-char census
  sections (19–23 throughout) where v2 sags to 11–14. That is the "gets slow" symptom.
- **v4 is ~30 % faster** (≈ 20–21 vs ≈ 15–16 letters/s) and ignores `speed`. C2 slows it
  after rendering to roughly the live chapter length (Numbers 446 s = A exactly).
- B is longer than A on Numbers (+41 s): the spelled-out counts are more syllables than the
  model's rushed digit reading, and v2 sags more in the two long census sections.
- v4 timestamps work through the existing builder: 100 % matched, guard passed.
- v4 renders louder than v2 for this voice (≈ -32 vs -39 LUFS); both normalized to -20.

Spend: probe ~69+ credits; A/B **11,090 credits measured (≈ $1.83)**.

## Decisions (as they were open on 2026-10-15)

1. Listen: A vs B and B vs C/C2. → **Steve: "we really like C"** (v4, natural pace). C2 was
   dropped from the pages.
2. v4 is all-66-books or nothing. → **All 66**, prerequisites done first (below).
3. Staying on v2 with the fixes. → Not needed; the fixes ship with v4.

## Outcome — the whole Bible on v4 (2026-10-15 → 18) — CLOSED

**Prerequisites (0 credits)**, audiobooks commits 68ce2d2 + follow-ups: model-aware chunk cache
key (v2 hashes unchanged, 0/5,749 changed); per-book `profile` config (`src/audiobook-config.js`)
so books could move one at a time; manifest sessions stamped `modelId` / `pauseStyle` /
`chunkKey`; `rebuild-timestamps` handles v4 + current-algorithm files; v2 audio backed up.

**Chapter-end pause** (Steve noticed Matthew 2 starting right after Matthew 1): ElevenLabs trims
edge silence to ~0.1 s on both models. Added `chapterEnd` = 2 s after the last word (tail only,
so no timestamp moves; all three players advance on the audio's real end). New renders get it via
`chapter_end_pause`; Matthew was padded from its stored chunks at 0 credits (`pad-chapter-tail.yml`).

**Rollout** (all `generate.yml` runs succeeded, verified per batch: every chapter `modelId:
eleven_v4` + `tailSilenceSeconds: 2`):

| Batch | Books / chapters | Credits (balance-measured) |
|---|---|---|
| Matthew (pilot) | 1 / 28 | 59,634 |
| Mark – Revelation | 26 / 232 | 402,544 |
| Genesis – 2 Kings | 12 / 338 | 694,822 |
| 1 Chronicles – Malachi | 27 / 591 | ≈ 791,000 (7 auto top-ups ≈ $140) |
| **Whole Bible** | **66 / 1,189 (77.4 h)** | **≈ 1.95M** |

v4 bills **~0.475 credits per counted character** (v2: ~0.587); estimates were within ~1%.

**Verification:** `fidelity-audit.yml` (Whisper + Vosk) — **0 confirmed defects**; mean WER 1.84%
vs v2's 1.83% (`plans/2026-10-18-v4-fidelity-audit.md`).

**Tidy-up (2026-10-18):** the v4 settings are the BSB block default and the profiles are gone
(Resources dc5d883, effective config identical for all 66 books); every `audio/_backup/` folder
deleted on Steve's go — rolling back to v2 would now be a paid re-render.

**Left open:** a check of highlighting on a v4 chapter in the mobile app (Steve, on device).
Series audiobooks remain on multilingual v2.
