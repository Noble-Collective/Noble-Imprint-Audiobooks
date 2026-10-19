# ElevenLabs Models — What We Depend On, and Which Model Each Book Uses

Learning doc covering what our pipeline relies on from the ElevenLabs API, and how newer models compare against it. Read this before changing `model_id` for any book.

**Status (2026-10-18):** **the BSB Bible is on `eleven_v4`** — all 66 books re-rendered 2026-10-15 → 16 after Steve preferred the v4 A/B ("C"), fidelity-audited with 0 defects. **Series audiobooks stay on `eleven_multilingual_v2`.** Eleven v3 was evaluated and declined (2026-08-28). §1 describes the v2 contract the pipeline was built on; §3 how v4 differs and what was built to support it.

---

## 1. Our API contract today

Production makes one TTS call: `POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128`
(`src/generate.js` `generateChunk`, ~L329–363). The only other endpoints are `GET /v1/user/subscription` (credit audit) and the voice-search and plain-TTS calls used by the voice-compare and voice-test tools.

Request body:

| Field | Source | Notes |
|---|---|---|
| `model_id` | `meta.model_id` (book-level) | fallback `eleven_multilingual_v2` hard-coded in `generateChunk` |
| `voice_settings` | `meta.voice_settings`, passed through verbatim | BSB `{stability 0.50, similarity 0.5, style 0, speed 0.90}`; series books `{0.71, 0.5, 0, 0.92}` |
| `previous_text` / `next_text` | 200-char neighbour slices | linear: always sent. Section: only across cap-split continuations (`next_text` across a heading caused "fricative bleed", commit 63709ed) |
| `previous_request_ids` | `request-id` response header of the last ≤3 chunks | chain resets at a cached-chunk gap (IDs expire after ~2h). Off only if `request_stitching: false` |

Never sent: `next_request_ids`, `seed`, `language_code`, `pronunciation_dictionary_locators`, `apply_text_normalization`, `use_speaker_boost`. (`meta.pronunciation_dictionary_id` exists in config, but no code reads it.)

Response: `audio_base64` plus `alignment` (**not** `normalized_alignment`). Alignment is cached per chunk as `chunks/{slug}/{hash}.align.json` and feeds `buildTimestampsFromAlignments` (sentence segments, plus Bible `words`).

### Hard dependencies — any replacement model must satisfy these, or we must engineer around them

1. **SSML `<break time="Xs"/>`** carries all heading and section pauses (see `CHUNKING-AND-PAUSES.md`).
2. **The tag's own characters appear in the alignment.** `alignmentConsistent = charTimes.length === flatText.length`, and `cleanToOriginal` maps tag-stripped text back to raw positions. If a model drops, speaks, or normalizes those characters, word timings are disabled and matching degrades.
3. **Alignment is on the input text, not normalized text.** A model that aligns expanded numbers or abbreviations would break the length check.
4. **Request stitching is accepted.** A 4xx is not retried, so the run fails.
5. **Float `stability`** and **`speed`** tuning. The BSB pace depends on speed 0.90, and the section strategy exists *because of* stability 0.50.
6. **Deterministic-enough re-renders.** The hash cache re-renders single chunks (e.g. a pronunciation fix) and splices them between old ones.

### Cache key — fixed 2026-10-15

The chunk hash used to be `sha256(chunkText)` only, so changing the model, voice or settings silently reused old chunks. Now (`generate.js chunkKey`) **any model other than multilingual_v2 folds `model_id` + `voice_id` + `voice_settings` into the hash**; v2 keeps the text-only key so every shipped v2 chunk still matches (proved: 0 of 5,749 hashes changed). The key is stamped on each manifest session as `chunkKey`. Still not in the key: `output_format`, and a v2 settings change (needs `force_regenerate`).

---

## 2. Eleven v3 — declined 2026-08-28

Base `eleven_v3` has no SSML breaks (it uses `[pause]` tags instead), no request stitching, and discrete stability (Creative/Natural/Robust). It has a 5k-character limit, and its timestamps are best served through text-to-dialogue (a different schema, 2k cap). It is "more expressive but less predictable", which is a hallucination risk for scripture. It fails dependencies 1, 4 and 5.

---

## 3. Eleven v4 — researched 2026-09-28, adopted for the Bible 2026-10-16

> The research below is kept as written (2026-09-28). What changed the decision: the A/B showed
> v4 holds its pace through long sections where v2 slows (the "gets slow" complaint); pauses
> became model-aware kinds (`src/pauses.js`), so losing SSML no longer mattered; and v4's natural
> pace (no `speed`) was preferred over a slowed copy. "Why we're not switching" below is the
> pre-A/B reasoning.

Released ~Sept 2026. Sources: elevenlabs.io `/docs/overview/capabilities/text-to-speech/eleven-v4`, `/v4` FAQ, `/blog/eleven-v4`, `/pricing/api`, request-stitching and pronunciation-dictionary guides. Treat the details as point-in-time; ElevenLabs says v4 is under active development.

**Model IDs:** `eleven_v4` (quality; docs list it for audiobooks) and `eleven_v4_turbo` (~100 ms median inference, realtime/agents).

| Our dependency | v4 |
|---|---|
| SSML `<break>` | ❌ **Disabled.** "SSML is not supported." Use `[pause]`, `[short pause]`, `[long pause]` (no exact durations) |
| Request stitching | ✅ **Back** ("context stitching restored"); same rules: ≤3 IDs, <2h, prior request complete |
| Float stability | ❓ Only **stability + similarity** exist. Float vs presets is undocumented |
| `speed` / `style` | ❌ **Removed** ("Style and Speed sliders are not available") |
| `/with-timestamps` char alignment | ❓ Not documented for v4. Endpoint schema unchanged; whether tags appear in `characters` is unknown |
| `previous_text` / `next_text` | ❓ Unverified |
| Char limit | ✅ 10,000 per request |
| Pronunciation | ✅ **Better than v2:** inline IPA `/…/` + dictionary *phoneme* rules (v2 is alias-only) |
| Our voices (Ali, Ollie, Nicolas) | ✅ Library voices work, ⚠ but it's a new architecture, so they **will sound different** |
| Re-render stability | ⚠ "Behavior may shift over time… periodically re-test". Bad for chunk-level patching |
| Scripture fidelity | ❓ Nothing published either way |
| Price | API list $0.08/1k chars (same as v2). Launch promo $0.022/1k **until 2026-10-12**. Credits "same as other TTS models". Impact-plan applicability unknown |
| Deprecation | multilingual_v2 is still the API default and still "most stable on long-form". Not deprecated |

New knobs v4 adds: descriptive inline direction tags (`[Quiet, measured narration]`, `[lower, thoughtful]`, `[measured]`), SFX tags, better IVC/PVC cloning (PVCs made before v4 must be retrained), and 90+ languages.

### (Pre-A/B, 2026-09-28) Why we were not switching

- The full 66-book BSB Bible is rendered, audited (0 defects, Whisper+Vosk), and consistent. A v4 voice sounds different, so partial adoption means an audible voice change mid-Bible. Full adoption means re-rendering the whole Bible.
- It loses both pacing levers we tuned (breaks + speed), and drift over time undermines single-chunk fixes.
- The gains that matter less for steady narration are expressiveness and emotion. The one we'd actually want is **IPA phonemes**, which only helps if the whole book is on v4.

### Engineering path (2026-09-28 plan) — status 2026-10-18: 1 cache key ✓ · 2 pauses ✓ (tags + concat silence) · 3 speed stretch built, unused · 4 IPA pronunciation not done · 5 fidelity audit ✓

1. Fix the cache-key gap (above).
2. **Pauses → real silence:** split generations at every heading and insert ffmpeg `anullsrc` gaps (the section strategy already does this between generations). Remove all `<break>` tags from text sent to v4. Re-check the "drawn-out lone heading" behaviour when a heading is its own generation.
3. **Speed → post-stretch:** ffmpeg `atempo` (pitch-preserving) uniformly after concat, multiplying every timestamp by `1/tempo`. Ear-check for artifacts.
4. Pronunciation: move the respelling map to IPA dictionary rules.
5. Validate fidelity with the dual-engine STT audit before publishing.

Best v4 candidates: **new series books** or a deliberate full re-record of a series book (HomeStead, Oration), where expressiveness adds value. Not the Bible.

### Probe — RUN 2026-10-15 (`v4-probe.yml`, `src/v4-probe.js`, run 38746809091)

Six short `/with-timestamps` calls on `eleven_v4` with the Ali voice. Verified:

| Question | Answer |
|---|---|
| `/v1/models` | `eleven_v4`: 10,000 chars/request, `can_use_style: false`, `character_cost_multiplier: 1` (same rate as v2). `eleven_v4_turbo`: multiplier 0.5 |
| Character alignment | ✅ Returned. `alignment.characters` equals the input text exactly, **pause tags included** — so the same strip-and-map timestamp matching works (`pauses.js`, `PAUSE_MARKUP_RE`) |
| `[long pause]` / `[short pause]` | ✅ Real silence: ≈ **1.8 s** / ≈ **0.7 s**. No duration control |
| SSML `<break>` | Accepted, **ignored** (0 s, not spoken) |
| `speed` / `style` | Accepted (HTTP 200), **ignored** (speed 0.9 run was not slower) |
| Pace | ≈ 20 letters/s articulation — faster than v2 Ali at speed 0.90 |
| Float stability, `previous_text`/`next_text`, `previous_request_ids` | ✅ all accepted |
| Digits | "46,500" read in ~1.9 s, same as the spelled-out words |

What we built from it (2026-10-15): pauses by **kind** (`src/pauses.js`) rendered per model —
`<break>` for v2 (byte-identical to before), `[long pause]`/`[short pause]` for v4 — chosen from
`model_id` (`pause_style` overrides). Speed for v4 = post-render `atempo` (`model-ab.js` C2).

### Whole-chapter A/B — `model-ab.yml` / `src/model-ab.js`

A = live audio, B = v2 + text fixes, C = v4 + same fixes, C2 = C slowed to 0.90. Published to
`/voice-test/ab-{book}-{ch}` with a `metrics.json` (duration, per-generation pacing, timestamp
coverage). First run: Numbers 1 + Acts 27 — results in `plans/2026-10-15-v4-ab-and-narration-fixes.md`.

The page shows A, B and C (C2 was removed from the pages at Steve's request; `model-ab.js`
makes it only when `VARIANTS` includes `C2`). Steve chose **C** (v4, natural pace).

### Rollout + what to know when running v4 (2026-10-15 → 18)

- **Rollout:** Matthew pilot → rest of NT → Genesis–2 Kings → 1 Chronicles–Malachi, via a
  per-book `profile` (`src/audiobook-config.js`); now the BSB block default. 1,189 chapters,
  ≈ 1.95M credits. Details: `plans/2026-10-15-v4-ab-and-narration-fixes.md`.
- **Billing:** v4 bills **~0.475 credits per counted character** (v2: ~0.587) — about 19%
  cheaper per chapter, despite `character_cost_multiplier: 1`.
- **Pauses:** `[long pause]` ≈ 1.8 s, `[short pause]` ≈ 0.7 s (`src/pauses.js` maps kinds →
  tags); section boundaries are exact concat silence; 2 s chapter-end silence (`chapter_end_pause`).
- **Timestamps:** alignment includes the tag characters, so the existing builder works; spelled
  numbers match via `matchText`. `rebuild-timestamps.yml` reproduces v4 chapters (reads
  `pauseStyle` / `chunkKey` from the manifest).
- **Drift:** ElevenLabs says v4 "may shift over time". A chapter re-rendered months later may
  sound slightly different from its neighbours; re-render a whole book if that matters.
- **Fidelity:** `fidelity-audit.yml` after any large render. v4 Bible: 0 defects
  (`plans/2026-10-18-v4-fidelity-audit.md`).
