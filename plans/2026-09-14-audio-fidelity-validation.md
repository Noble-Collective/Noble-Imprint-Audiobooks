# Validating That the Bible Audio Is Faithful to the Text

> **Open items consolidated (2026-10-27):** this doc's still-open items are tracked in ONE list, `Collective-Shared/plans/2026-10-27-loose-ends.md`. Strike an item there and here when it's done; add new loose ends there.

> **2026-10-17 — productionized.** The dual-engine audit (Whisper small.en + Vosk en-us-0.22,
> both-engine consensus, tiering) built in Sept 2026 lived only in a session scratchpad and was
> lost. It is now committed as `scripts/fidelity/` + `.github/workflows/fidelity-audit.yml`
> (sharded on GitHub Actions, free on this public repo, no secrets), and was re-run on the
> whole Bible after the Eleven v4 re-render. Sept result (v2): 1,189 chapters, mean WER 1.83%,
> 0 confirmed defects (22 Tier-1 items, all recogniser artefacts).

**Date:** 2026-09-14
**Question:** Is there a way to automatically validate that the generated Bible audio actually
speaks the correct words — no dropped words (a missing "not"), no hallucinated/added phrases, no
meaning-changing substitutions? How would we do it?

**Short answer:** Yes. The established, industry-standard method is **ASR back-transcription**:
transcribe the generated audio with a speech-to-text engine, normalize both sides, align them, diff
them, and classify each difference. It's feasible, cheap, and runs on what we already produce. A
**live proof-of-concept on real Obadiah 1 audio scored 0.80% WER with zero dropped/added words** — see §3.

---

## 1. Why the current pipeline can't catch this today

The generator has one validation guard (`generate.js:488-512`), but it is a **self-consistency check
on the timestamp list, not a fidelity check against the audio**. It verifies only:
- no leftover SSML/markup tags in a segment's text, and
- segment start times are monotonic (within 0.5s).

It does **not**:
- compare the spoken audio to the source text at all (no transcription anywhere in the pipeline);
- detect a mispronounced, dropped, or hallucinated word by ElevenLabs;
- notice a missing verse/sentence (a dropped sentence simply isn't a segment — nothing flags the gap);
- verify audio coverage/duration. When a sentence fails to match, it silently substitutes a
  **proportional time estimate** (`generate.js:454-467`) that passes the guard.

So today, an ElevenLabs-side error (the model skips a clause, repeats a phrase, or mis-says a word)
ships undetected. That's the gap this fills. Industry note: **ACX/Audible QC and Faith Comes By
Hearing both catch misreads only with human proof-listeners** — there is no built-in word-accuracy
check in any TTS or audiobook platform. You build the ASR-diff layer yourself.

---

## 2. The validated approach

Two independent layers. Layer B is free and should exist regardless; Layer A is the real audio check.

### Layer A — Audio fidelity (does the audio speak what we sent?)
`ASR(mp3)` vs the exact intended spoken text → this catches ElevenLabs-side defects.

Pipeline (matches commercial proofers Pozotron / ST Mastering / TTSAudit and the TTS-robustness literature):

1. **Transcribe** each chapter MP3 with a speech-to-text engine that produces word-level timestamps.
2. **Normalize both sides identically** (numbers→words, strip punctuation/quotes/verse-numbers,
   lowercase, British→American). *Mismatched normalization alone swings WER ~10 points — it is the #1
   false-positive source.*
3. **Align** reference↔hypothesis with minimum-edit-distance and **diff**.
4. **Classify** every difference: **deletion = dropped word (real TTS skip), insertion =
   hallucination/repeat (real), substitution = mostly ASR/normalization noise.** Deletions and
   insertions carry the signal; substitutions are the floor.
5. **Triage**: alarm per chapter on relative error; route only the worst spans to a human to re-listen.

### Layer B — Text fidelity (did our preprocessing preserve the words?) — FREE, deterministic
`plainText` (what we send to ElevenLabs) vs the **BSB source-of-truth text**. This is pure text-vs-text,
no audio, no ASR, zero cost, and catches any bug in USFM→markdown→preprocess that corrupts wording
(e.g., a normalization rule that eats a word). The website already has a BSB text-validation suite
(`bible-validation.js`, `references.json`) to build on. Run it once per book at generation time.

---

## 3. Proof of concept — it works on our real audio

Ran locally (Python 3.11, `faster-whisper` small.en + `jiwer`, CPU, free) against **real Obadiah 1
audio pulled from production** via the website's unauthenticated signed-URL route
(`/api/audio/url/bible/bsb/obadiah/001.mp3` — no gcloud needed). Reference = the chapter's
`plainText` from `001.tts.json` (the exact text we sent ElevenLabs), break-tags stripped.

```
=== obadiah-001 :: audio-fidelity report ===
ref words: 625   hyp words: 625
WER: 0.80%    CER: 0.19%
substitutions=5 deletions=0 insertions=0 hits=620

--- differences (ref -> hyp) ---
[substitute] ref: 'an envoy'  hyp: 'and anvoy'   # ASR mishearing
[substitute] ref: 'oh'        hyp: 'o'           # trivial ASR spelling
[substitute] ref: 'teman'     hyp: 'taman'       # proper noun, ASR
[substitute] ref: 'esau'      hyp: 'esir'        # proper noun, ear-check candidate
```

**Interpretation:** 0.80% WER sits right in the "clean render" floor (research predicts 2-6% with a
basic normalizer; ours is under 1%). **Zero deletions and zero insertions = no dropped words and no
hallucinations.** The four residual substitutions are all ASR mishearings or proper-noun pronunciations
— exactly the low-priority noise the triage rules down-weight (single word, substitution, proper noun).
A genuine defect — a dropped "not" or an added clause — would appear as a **deletion/insertion span far
above this <1% floor** and be trivially visible. (The "Esau→esir" item is the kind of thing a human
would spend 10 seconds ear-checking; almost certainly the small model just not knowing the name.)

POC script: `scratchpad/validate_poc.py` (portable; `<repo>/scripts/` on productionization).

---

## 4. What we reuse for free vs. what's net-new

**Already produced (reuse):**
- **Chapter MP3** per chapter — the audio under test.
- **`{slug}.tts.json` → `plainText`** — the exact intended spoken text (the Layer-A reference), already uploaded.
- **`chunks/{slug}/{hash}.align.json` `characters[]`** — the exact per-chunk character stream sent to
  ElevenLabs, with char-level timing. Highest-fidelity record of intent.
- **`{slug}.timestamps.json`** — sentence↔time map, to localize a flagged span to a place in the audio.
- **`manifest.json`** — `contentHash`, `hashToFile`, `pipelineVersion` for change detection.
- **Signed-URL API** (`/api/audio/url/...`, unauthenticated) — pull any artifact without gcloud.
- **BSB source text + text-validation suite** on the website — the Layer-B reference.
- **Deterministic source pipeline** — USFM→markdown→preprocess is re-runnable at 0 cost.

**Net-new (the validator adds):**
- The **ASR/transcription step** — nothing today converts audio→text.
- **Normalization + align/diff + classify** module (jiwer).
- **Coverage/gap checks** — flag proportional-estimated segments and audio-length deltas (not persisted today).
- **A per-chapter validation report/score** — none is emitted today.
- (Optional) **per-verse mapping** — verse numbers are stripped pre-TTS, so verse spans must be
  re-derived from USFM if we want verse-level localization.

---

## 5. Recommended tooling & thresholds

**ASR engine:** **WhisperX** (Whisper large-v3 accuracy + wav2vec2 forced alignment → precise word
timestamps + VAD to suppress silence-hallucination) as primary. For higher confidence, add a **second
engine of a different family** (NVIDIA Parakeet local, or Deepgram/AssemblyAI API) and **flag a defect
only where both engines disagree with the source at the same span** — this is the core false-positive
suppressor. faster-whisper (used in the POC) is the lightweight local option.

**Normalization:** Whisper's `EnglishTextNormalizer` (`whisper_normalizer` on PyPI) + explicit
verse/chapter-number stripping + boundary-quote stripping (the POC showed dialogue quotes alone
accounted for most spurious diffs).

**Diff:** `jiwer.process_words()` → keep `.alignments` (per-difference spans map back to source location)
+ per-class counts. `jiwer.visualize_error_counts()` across a whole book surfaces a systematically
mispronounced name vs. one-offs.

**Alarms (tune on our corpus, these are starting points):**
- **Per chapter:** flag if WER exceeds *corpus median + N·MAD* (~**>8-10% WER** or **CER >3-4%**), or
  any WER far above 100% (= broken/looping segment).
- **Per verse:** do **not** hard-gate (short segments are noisy); use as a **localizer** — prefer CER,
  prioritize verses with **deletions**, **insertion**, or **consecutive-verse** error runs.
- Discard ASR segments with `avg_logprob < -1.0` or `compression_ratio > 2.2` (Whisper hallucination/loop filters).

**Confounds to design around (ranked):**
1. Whisper hallucination on silence → phantom insertions. *Fix: VAD gating + logprob/compression filters.*
2. Normalization mismatch → phantom substitutions. *Fix: identical normalization, verse-number stripping.*
3. **ASR masking a real misread** (its language model silently "corrects" a wrong reading — the
   dangerous false-negative for a dropped "not"). *Fix: dual-engine, re-transcribe the flagged span
   without surrounding context, audio-first human review.*
4. Forced alignment force-fitting text and hiding an omission. *Fix: read acoustic-score/duration outliers, cross-check with the free-transcription diff.*
5. Per-verse WER noise on short verses. *Fix: CER, relative thresholds, localizer-not-gate.*

---

## 6. Implementation options (pick a tier)

**Tier 0 — One-off audit of the whole Bible we just generated (recommended first step).**
A standalone script (extends the POC): for each of the 66 books × chapters, pull the MP3 + tts.json via
signed URL, transcribe with faster-whisper, normalize + jiwer-diff, emit a per-chapter CSV/JSON report
ranked by deletion/insertion count. Run once, locally or in a throwaway GitHub Actions job. Output = a
worklist of the N chapters worth a human listen. **No pipeline change, no credits, ~cost = compute time.**
Estimate: ~1,200 chapters; faster-whisper small.en ≈ a few× realtime on CPU (~1-3 min/chapter) →
roughly a day of unattended CPU, or a few hours on a GPU runner / with `base.en`.

**Tier 1 — Wire it into generation as a post-step (gate).**
After a chapter uploads, transcribe + diff; if it trips the alarm threshold, mark the chapter in the
manifest (`validation: {wer, deletions, insertions, flagged}`) and optionally fail the run for review.
Adds Layer B (plainText-vs-BSB) as a free pre-check. Turns fidelity into a standing quality gate for
every future book/regeneration.

**Tier 2 — Dual-engine + forced-alignment confirmation + a small review UI.**
Add the second ASR engine consensus filter, forced-align flagged spans for exact timestamps, and a tiny
page that lists flagged spans with an inline audio player seeked to the moment — so a human review is
"listen to these 12 clips" instead of re-listening to books. Highest confidence; most build.

**Recommendation:** do **Tier 0 now** (it directly answers "is the Bible we just shipped faithful?"),
then decide on Tier 1 based on what Tier 0 finds. Tier 2 only if the base rate of real defects justifies it.

---

## 7. Prior art (this is a solved, established pattern)
- **Pozotron / ST Mastering "Advanced Proof" / TTSAudit** — commercial ASR-vs-manuscript audiobook
  proofers; TTSAudit is AI-narration-specific and cites a 5-15% chapter-regeneration base rate.
- **US Patent 10,922,484** — "error detection in human voice recordings of manuscripts" via
  transcribe-and-compare (the exact approach).
- **aeneas** (SIL Scripture App Builder, Faith Comes By Hearing) — Scripture audio↔text aligner, but
  **timing/localization only, no defect detection** (it force-fits text). Use it to locate, not to judge.
- **Academic TTS robustness** — skipping/repeating/deletion are canonical failure modes; the field uses
  **Word Deletion Rate (WDR)** to isolate under-generation. Worst on long/archaic text — directly
  relevant to long Scripture passages.
- **ElevenLabs docs** — acknowledge long-form degradation, prescribe <800-900 char chunks (we already
  do), and warn too many `<break>` tags cause instability (relevant to our SSML pipeline). No built-in
  accuracy eval — you build the ASR-diff layer.

---

## Appendix — reproduce the POC
```
py -3.11 -m venv asrpoc
asrpoc/Scripts/pip install faster-whisper jiwer
# pull a chapter with no gcloud auth:
curl -s https://resources.noblecollective.org/api/audio/url/bible/bsb/obadiah/001.mp3   # -> {"url": signed}
curl -s https://resources.noblecollective.org/api/audio/url/bible/bsb/obadiah/001.tts.json
python validate_poc.py obadiah-001 small.en
```
`validate_poc.py`: strip `<break>`/SSML from `plainText` → reference; faster-whisper (VAD on) →
hypothesis; normalize both (lowercase, drop punctuation, strip boundary quotes); `jiwer.process_words`
→ WER/CER + per-difference spans classified insertion/deletion/substitution.
