# Poetry Couplet Fix (2 Tim 2:11 creed) + Website Parity

**Date:** 2026-08-12
**Status:** Prototyped (uncommitted) + planned; NOT implemented/shipped
**Depends on:** the section chunking strategy (Phase A, done — see
`plans/2026-08-12-audiobook-pipeline-reconciliation.md`).

---

## Problem

USFM poetry (`\q1`/`\q2` lines) is currently grouped into **one flowing stanza block**. For the
2 Timothy 2:11–13 "trustworthy saying" creed — four couplets in the BSB USFM (`562TIBSB.SFM`) — this
reads as a run-on, which is the original "2 Tim 2:11 sounds odd" complaint. The fix splits poetry
into **per-couplet blocks** so each couplet gets a natural pause (cadence from structure, not
`<break>` tags).

Example (creed):
> "If we died with Him, we will also live with Him;" *(pause)* "if we endure, we will also reign
> with Him;" *(pause)* "if we deny Him, He will also deny us;" *(pause)* "if we are faithless, He
> remains faithful, for He cannot deny Himself."

---

## Current state — prototyped, uncommitted, env-gated (`POETRY_COUPLETS=1`)

Two changes in the **audiobooks** repo (uncommitted; `git diff`):

1. **`src/usfm-to-markdown.js`** — flush a poetry block at each `\q1` line, but ONLY when the block
   so far closed with punctuation (`.!?;:,—–`). Enjambment (bare line-end, sentence continues) keeps
   flowing into the next couplet, so a run-on poetic sentence stays one block. `\q2`/`\q3`
   continuations stay grouped, so a `\q1+\q2` couplet becomes one block.
2. **`src/preprocess-tts.js`** — treat `;` and `,` as already-punctuated, so a block ending on a
   semicolon/comma (couplet mid-thought) keeps its lilt instead of a false full-stop (`";."` / `",."`).

Both changes are correct in shape; they just need to be productionized (proper gating, not an env var)
and, critically, **mirrored on the website**.

---

## The hard part — website parity

The website has its **own** USFM parser, `src/server/usfm-audio.js` (`parseUsfmBook`), which
`bible.js` uses to render the reading-view blocks the audio timestamps highlight against. Its header
says it outright: *"Both must produce the same per-chapter blocks."* The two parsers currently match
(both flow poetry into stanzas). **If the audiobook splits couplets but the website doesn't, the DOM
block order diverges from the timestamps → highlighting desyncs.** So the couplet-flush logic must be
ported into `usfm-audio.js` identically.

## The entanglement — Proverbs

`parseUsfmBook` is **global per book**. Flipping couplets on changes **Proverbs'** blocks too, and
Proverbs is live on the old stanza structure — its highlighting would desync until Proverbs is
re-rendered. We're deliberately holding Proverbs. **Solution: a per-book `poetry_couplets` flag** read
by BOTH the audio pipeline and the website. Enable for `2TI`; leave `PRO` off until we re-render
Proverbs later. (2 Tim 1/3/4 are prose — no `\q` — so unaffected regardless.)

---

## Steps

1. **Audiobook — re-gate.** Replace the `POETRY_COUPLETS` env gate with a per-book flag,
   `meta.audiobook.books.2TI.poetry_couplets: true`, threaded into `parseUsfmBook`/preprocess. Commit.
2. **Website — parity port.** Add the identical couplet-flush to `usfm-audio.js` `parseUsfmBook`
   (same `Q1_LINE_RE` + prior-line-closed-with-punctuation guard, at the same spot), gated by the
   same per-book flag; thread the flag from `bible.js` (read the book's meta).
3. **Parity test (non-negotiable).** Run BOTH parsers on `562TIBSB.SFM` with the flag on and diff the
   per-chapter blocks — must be byte-identical. This is what protects highlighting. (Build a small
   harness that requires both modules.)
4. **Enable** `poetry_couplets` for `2TI` only.
5. **Re-render 2 Timothy 2** (`force=true`) → new couplet blocks + timestamps. *(This is the ch2
   render we were holding; now done once, correctly.)* Consider ch3/ch4 in the same pass (prose,
   unaffected by couplets, but stale on old config — they'd also pick up Phase A + version stamp).
6. **Rebuild the website Bible cache + deploy, coordinated with the re-render.** The committed
   `Website/.bible-cache/{tx}-v1.json` bakes in parsed block flags and ships in the Docker image —
   after the parser change it MUST be rebuilt + committed (see BIBLE-AUDIOBOOKS.md §8.3), and the
   in-memory content cache cleared (`/api/refresh`). Blocks and timestamps must go live together.
7. **Verify** highlighting by ear on the live 2 Tim 2 audio view (the creed couplets highlight in
   step with the pauses).

**Later — Proverbs:** flip `PRO`'s `poetry_couplets`, re-render Proverbs (31 chapters — the cap also
kicks in here), rebuild cache, deploy. Same recipe. This is the expensive one; do it deliberately.

---

## Risks & notes

- **Parity is the whole ballgame.** Any block mismatch silently desyncs a live book's highlighting.
  Step 3 gates everything else.
- **Two parser copies must stay in sync** (`usfm-to-markdown.js` ↔ `usfm-audio.js`). A shared module
  would be better long-term but is out of scope here; at minimum, keep the couplet logic identical and
  documented in both.
- **Website deploy required** (Cloud Run) — confirm before deploying (per repo norms).
- **Coordinate the re-render and the deploy** so audio timestamps and website blocks change together;
  a gap between them desyncs 2 Tim 2 briefly.
- 2 Tim 2 re-render is small; the real cost is the eventual Proverbs re-render.
