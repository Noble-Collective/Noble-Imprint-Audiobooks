# Audiobook Pipeline Reconciliation — Chunking + Pauses

**Date:** 2026-08-12
**Status:** Proposed (not yet implemented)
**Context:** After the 2 Timothy 1 work landed a new, well-liked chunking + pause
approach for the Bible, we reviewed how much it diverges from the standard
(non-Bible) book pipeline and whether the two can be unified.

---

## Background — how we got here

- **`a5311be` (2026-06-27):** standard books designed around **~800-char** linear
  block chunking, force-split at h1/h2/h3, 250-char min. This is what the existing
  library was rendered with, and what `docs/ARCHITECTURE.md` still documents (~800).
- **`5ceba5a` (2026-08-11, this session):** dropped `TARGET_CHUNK_SIZE` to **400** +
  added `splitLongBlocks()` — a fix for the **Bible's** "robot battery dying"
  deceleration. Because `TARGET_CHUNK_SIZE` is shared, this silently changed the
  standard path too. **No regular book has been re-rendered since, so it has shaped
  zero shipped audio** — the 400 is dormant in the regular path.
- **`836ae2f` → `f45bd6b` (this session):** added `natural_mode` for the Bible, then
  switched it to **section-based** generations with real concat-silence at section
  boundaries. That switch **dropped the size cap** for the Bible (sections are emitted
  whole; 2 Tim 1's middle generation is 1,353 chars).
- **`63709ed` (this session):** disabled `previous_text`/`next_text` in natural_mode
  (they bled a fricative across the deliberate silence gaps).

**Net result today:**
- Regular books: shipped at ~800 + break-tags-both-sides headings; code now says 400
  (dormant), docs say 800 (drifted).
- Bible: uncapped heading-delimited sections + hybrid pauses (concat-silence before
  section headings, `<break>` after in-generation headings).

---

## Current architecture

### Shared core (both paths, single call sites)
`generateChunk` (TTS + request stitching) · `concatenateChunks` (filter re-encode) ·
`buildTimestampsFromAlignments` · loudness normalization · GCS upload · manifest ·
content-hash caching · `force_regenerate` · sentence splitting · validation guards.

### Divergences
| dimension | Standard (regular books) | Section (Bible) |
|---|---|---|
| chunking | `splitLongBlocks` + `chunkText`, ~400 target | `buildNaturalGenerations`, **uncapped** |
| generation shape | many small (~200–400) | few large (one per heading-span) |
| **heading levels that split** | **h1/h2/h3** (`FORCE_SPLIT_TYPES`) | **all h1–h6** (`HEADING_GAP`) |
| heading pause | `<break>` both sides (preprocess-tts) | concat-silence **before** + `<break>` **after** |
| seams | leading `<break>` (0.5s / 0.3s mid-para) | none (deliberate silence gaps) |
| prev/next_text | on | off |
| stability (voice) | 0.71 | 0.50 |

The pause divergence traces to one fact: `<break>` tags render reliably **inside** a
generation but are trimmed/unreliable **at a generation edge** (trailing vanish,
leading render ~85%). The Bible puts headings on generation edges (each section = its
own generation), so it needs deterministic concat-silence there. Regular books keep
headings mid-generation and run at 0.71 where edge breaks survive, so break tags work.

---

## Target architecture

Keep **two chunking strategies** (they genuinely serve different content) but make the
choice explicit, cap the section strategy, align its heading-level rule, and unify the
pause model so both strategies feed one pause engine.

### 1. Per-book `chunking_strategy` property
In each book's `meta.json` audiobook block:
- `"linear"` — regular books: `chunkText` + `splitLongBlocks`, target **800**
  (restores the validated/documented value; removes the dormant 400 regression).
- `"section"` — Bible: `buildNaturalGenerations`, **with a cap** (below).
- Back-compat: map existing `natural_mode: true` → `"section"`.
- Optional per-book overrides: `chunk_target` (linear) / `max_generation` (section).

### 2. Size cap on the section strategy — `max_generation = 2000` (DECIDED)
- A "section" = a heading-span (see #3). If its text exceeds `max_generation` (**2,000
  chars**), pack its blocks into sub-generations of ≤ 2,000 at **verse/sentence
  boundaries** (whole verses kept together; a single block over 2,000 is sentence-split
  via `splitLongBlocks`).
- **Sub-generation seam** (cap-forced, mid-section, no heading): a **light ~0.4s
  concat-silence** — a breath, not a section pause. Request-stitching stays ON across it
  (continuous content), and `previous_text`/`next_text` may stay on there too — unlike
  true section boundaries, which keep them off (the "f"-bleed fix).
- **Cap chosen from a no-credit dry-run** (2026-08-12) over real `tts.json` blocks:

  | | 2 Timothy (11 sections) | Proverbs (66 sections) |
  |---|---|---|
  | median | 958 | 962 |
  | p90 | 1,353 | 2,837 |
  | max | 1,693 | 3,329 |

  At **2,000**: 2 Timothy splits **0** sections (renders identically); Proverbs splits
  **21/66 (31%)**, each at a verse boundary. Every resulting generation stays inside the
  ~2,200-char range where we've *verified* flat pacing, and nothing approaches the
  ElevenLabs limit (~10k). Worked case — Prov 30 (3,329) → two sub-gens of 1,934 + 1,393.
- Higher caps (2,500 → 18% Proverbs split, 3,000 → 1%) were rejected: they'd leave
  2,500–3,300-char generations whose pacing we haven't confirmed. Revisit only after an
  empirical long-generation pacing test if the Proverbs seams prove undesirable.

### 3. Heading-level rule for the section strategy
- **Boundaries: h1/h2/h3 only** (match `FORCE_SPLIT_TYPES`).
- **h4/h5/h6: inline sub-headings** — read inside their parent generation with a
  break-after tag (the section strategy already adds break-after to in-generation
  headings, so no new mechanism needed).
- Avoids over-fragmentation on deep hierarchies (without this, every h4–h6 would start
  a new generation + concat-silence — the choppy isolated-heading failure mode).
- Zero change to 2 Timothy (no h4–h6 present).

### 4. Unified pause model (one engine, both strategies)
Given a list of generations + boundary metadata, emit break tags + concat gaps:
- in-generation heading → `<break>` after (duration by level)
- generation boundary **at a heading** → concat-silence before (heading duration)
- generation boundary **mid-paragraph** (a split seam, no heading) → **light**
  concat-silence (~0.3–0.5s), replacing today's leading-break seam
- Sync-safe throughout: break silence is captured by ElevenLabs' alignment; concat
  silence is returned by `concatenateChunks` and fed to `buildTimestampsFromAlignments`
  (never a timestamp-only gap — see the CHUNK_GAP warning in code).

---

## Sequencing

**Phase A — ✅ DONE (2026-08-12)** — implemented in `generate.js` (commit a6070d7) + Bible
meta migrated to `chunking_strategy: "section"` (Resources f1da3a9). Verified end-to-end:
2 Tim 1 force-regen ran the section path, stamped `pipelineVersion: 2026-08-12-section-cap-v1`,
identical structure (3 gens, 1.5s/1.5s), timestamps in sync. Regular books unchanged (default
`linear`/800). Stale Bible chapters (2 Tim 2–4, Proverbs) NOT re-rendered — deferred by choice.

Original checklist (safe, needed; no regular-book behavior change):
1. Add `chunking_strategy` property; set regular books `"linear"`/800, Bible `"section"`.
2. Add `max_generation = 2000` cap to `buildNaturalGenerations` (+ sub-generation split
   at verse/sentence boundaries + ~0.4s light seam). ✅ cap number decided via dry-run.
3. Section strategy splits at h1–h3 only; h4–h6 inline.
4. **Stamp `pipeline_version` into each book's manifest at render time** so staleness is
   queryable (which books would change on re-render). Informational — see caveat under
   "Incremental re-render behavior."
5. ~~Dry-run generation sizes~~ ✅ **Done (2026-08-12)** — `max_generation = 2000` chosen;
   see the cap table under "Size cap." 2 Timothy unaffected; Proverbs long tail (31%)
   splits at verse boundaries.
6. Regenerate 2 Timothy 1 to confirm no regression; validate pauses + timestamp sync.

**Phase B — later (opt-in, validate first):**
6. Unify the pause model in code so both strategies use concat-silence-at-boundaries +
   break-after. **Regular books don't need this** (break tags work at 0.71), so it's a
   robustness/consistency upgrade, not a fix.
7. Prove on **one** prose book: dry-run sizes → one real re-render → listen. Only then
   let it govern the library.

---

## Risks & decisions

- **Do not bulk re-render the library.** It sounds good and costs ElevenLabs credits.
  All changes take effect lazily on the next per-book regen.
- **Pause unification changes regular-book re-render output** (break-both-sides →
  concat-before + break-after). Shipped audio is untouched; validate before trusting.
- **Cap number** (`max_generation`) is a pacing/safety tradeoff — larger keeps the Bible's
  flat-pacing benefit, smaller is safer for the API limit. Confirm with the dry-run.
- **Content-specificity:** the "long generation stays flat" result was measured on
  scripture (short verse sentences). Validate on prose before assuming it holds.

---

## Incremental re-render behavior (both strategies)

Generation reuse is keyed on the **exact chunk text**: `hashChunk = sha256(text)[:16]`.
On a regen, any generation whose text-hash matches the previous manifest is **reused**
(downloaded, not re-rendered); only changed hashes hit ElevenLabs. So the cost of a text
edit = how many generations' text changed. The two strategies differ in granularity:

- **Linear (regular books):** a typo/word fix usually changes just the one ~800-char
  chunk containing it → **1 chunk re-renders**. If the edit shifts a chunk past the size
  boundary, the split point moves and downstream chunks change too — but the cascade is
  **bounded by the next h1/h2/h3** (the chunker resets its packing at every force-split).
- **Section (Bible):** the generation *is* the heading-span, so a one-word fix
  re-renders that **whole section** (~1,300–2,500 chars). Coarser per edit; cascade
  bounded by the section.

Counterintuitive upside of the section strategy: it's **more robust to partial
re-renders**. Reusing a cached generation resets the request-stitch chain
(`generate.js` — "cached gap breaks the stitch chain"). In the linear path a lone
re-rendered chunk between two cached ones may not tempo-match at its continuous seam; in
the section path the deliberate silence between generations hides any mismatch. Section
pays more per edit but always sounds seamless.

**Caveat for turning auto-regen back on:** the cache is keyed on chunk **text** only.
- A **text** edit correctly invalidates + re-renders the affected generation(s). ✓
- A **logic/settings** change that alters audio but not chunk text (voice_settings,
  concat method, loudness target) does **not** invalidate the cache — those generations
  keep their old audio unless `force_regenerate`. So after a pipeline change, a normal
  push-triggered regen refreshes only text-changed parts, leaving the rest on old logic
  (mixed provenance). To fully realize a logic change, do one deliberate **force**
  re-render per book. `pipeline_version` makes this visible; it does not by itself force
  a re-render.

## Documentation to update
- `docs/ARCHITECTURE.md` — currently says ~800 everywhere; document both strategies and
  the `chunking_strategy` property.
- `docs/BIBLE-AUDIOBOOKS.md` — document the section strategy, cap, and h1–h3 boundary rule.
- Note the two-path rationale so the divergence isn't re-litigated next time.
