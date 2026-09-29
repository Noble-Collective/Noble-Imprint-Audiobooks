# ElevenLabs Models — What We Depend On & Why We Stay on multilingual_v2

Learning doc covering what our pipeline relies on from the ElevenLabs API, and how newer models compare against it. Read this before changing `model_id` for any book.

**Status (2026-09-28):** all books use `eleven_multilingual_v2`. Eleven v3 was evaluated and declined (2026-08-28). Eleven v4 was researched and **not adopted**. An optional low-cost probe is described below; it has not been run.

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

### ⚠ Cache-key gap (fix before any model experiment)

The chunk hash is `sha256(chunkText)` only. **`model_id`, `voice_id`, `voice_settings` and `output_format` are NOT in the key.** Changing the model without `force_regenerate` silently reuses old-model chunks and mixes them with new ones. Fix: fold model, voice and settings into the chunk hash (this invalidates the whole cache once, so plan the rollout) or make a model change force regeneration.

---

## 2. Eleven v3 — declined 2026-08-28

Base `eleven_v3` has no SSML breaks (it uses `[pause]` tags instead), no request stitching, and discrete stability (Creative/Natural/Robust). It has a 5k-character limit, and its timestamps are best served through text-to-dialogue (a different schema, 2k cap). It is "more expressive but less predictable", which is a hallucination risk for scripture. It fails dependencies 1, 4 and 5.

---

## 3. Eleven v4 — researched 2026-09-28, not adopted

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

### Why we're not switching (the Bible especially)

- The full 66-book BSB Bible is rendered, audited (0 defects, Whisper+Vosk), and consistent. A v4 voice sounds different, so partial adoption means an audible voice change mid-Bible. Full adoption means re-rendering the whole Bible.
- It loses both pacing levers we tuned (breaks + speed), and drift over time undermines single-chunk fixes.
- The gains that matter less for steady narration are expressiveness and emotion. The one we'd actually want is **IPA phonemes**, which only helps if the whole book is on v4.

### If we revisit — engineering path

1. Fix the cache-key gap (above).
2. **Pauses → real silence:** split generations at every heading and insert ffmpeg `anullsrc` gaps (the section strategy already does this between generations). Remove all `<break>` tags from text sent to v4. Re-check the "drawn-out lone heading" behaviour when a heading is its own generation.
3. **Speed → post-stretch:** ffmpeg `atempo` (pitch-preserving) uniformly after concat, multiplying every timestamp by `1/tempo`. Ear-check for artifacts.
4. Pronunciation: move the respelling map to IPA dictionary rules.
5. Validate fidelity with the dual-engine STT audit before publishing.

Best v4 candidates: **new series books** or a deliberate full re-record of a series book (HomeStead, Oration), where expressiveness adds value. Not the Bible.

### Probe (not run — needs Steve's approval, < $1)

A few hundred characters on `eleven_v4` via `/with-timestamps` to answer the unknowns:

- Is character alignment returned, and do `[pause]` tags appear in it?
- Are `speed`/`style` rejected or silently ignored?
- What type does stability take?
- Are `previous_text`/`next_text` accepted?
- What is the actual credit delta?

Then an A/B listen of v2 vs v4 on a Bible prose chapter, a poetry passage, and a HomeStead excerpt through the `/voice-test` page (see `VOICE-COMPARE.md`; note `voice-compare.js` hard-codes `MODEL_ID`, so it would need a model override).
