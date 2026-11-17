# Ali accent drift on Eleven v4 (2026-10-26)

> **Open items consolidated (2026-10-27):** this doc's still-open items are tracked in ONE list, `Collective-Shared/plans/2026-10-27-loose-ends.md`. Strike an item there and here when it's done; add new loose ends there.

## Problem

Steve heard Colossians 1 in Ali's voice, but Colossians 3 in what sounded like an American version of him. Ali
(`MI88rOZjXbH22N8KHXUo`, library "Ali – calm & Deep Arabic Saudi Narrator") is an Arabic-language voice. The
ElevenLabs v4 docs say v4 deliberately does not carry a reference voice's accent into another language: "fluent,
natural-sounding speech in the target language … not a bug". In practice v4 decides per request, so a whole
generation (one section between headings) comes out North American, and the next heading often snaps back.

## Whole-Bible scan (0 credits)

The live MP3s were streamed from the site and cut into ~4 s sentence windows (every 3rd window; all windows in COL and PHM).
Each window was scored by two models:

- speechbrain ECAPA (VoxCeleb), speaker match against the Ali reference: Colossians 1, 2 and 4, now in
  `scripts/accent-check/ali-ref.json`;
- speechbrain CommonAccent ECAPA. Normal Ali reads as "england"; this model has no Arabic class.

The two models agree. At a match ≥ 0.85, 0% of windows are labelled American; at 0.70–0.78, 23%; below 0.70, 50%.

A chapter was flagged when ≥ 30% of its windows scored below 0.78. **214 / 1,189 chapters were flagged: 121 "clear"
(the accent model heard US/Canada) and 93 "likely".** The worst books were Psalms (49), Job (16), Jeremiah, Isaiah and
Ezekiel. The list and clips are in artifact https://claude.ai/artifact/L88JLXqFTbFGELFvbejbLA. The scan script was a
local scratch script, and its data was not kept in the repo.

## Experiment 1 — `accent-exp.yml` run 40332535188 (49,424 credits)

Five sections that drifted in the live audio, rendered with the production text via `buildNaturalGenerations`, with no
stitching:

- COL 3 g1
- PSA 24
- 1CO 13
- GEN 1 g7
- ISA 53 g1

Each section got 3 takes under each of 5 setups. Scoring was done by `scripts/accent-check/score.py`. A take counts as
American when the accent model hears US/Canada in ≥ 25% of its pieces.

| Setup | American takes |
|---|---|
| Live (stability 0.5, similarity 0.5) | 9 / 15 (COL 3 = 3/3) |
| Similarity 0.9 | 10 / 15 |
| Stability 0.75 + similarity 0.9 | 11 / 15 |
| `[Saudi Arabic accent]` tag + similarity 0.9 | 1 / 15 |
| **`[Saudi Arabic accent]` tag, live settings** | **0 / 15** |

- The tag is not spoken: the model spends 0.08–0.3 s on its characters.
- Pace is within −7% / +1% of the live settings.
- Re-rolling alone is unreliable, because COL 3 drifted 3 times out of 3.
- Results page: https://claude.ai/artifact/Uzyo4kArYcuw1GXiJacEX7

## Experiment 2 — tag only, live settings (run 40339023942, 19,776 credits)

Steve asked for a bigger check of the tag alone, with no other setting changes. It covered 14 new sections with 2 takes
each:

- 10 sections that drifted in the live audio: JOS 1 g1, 1SA 6 g2, JOB 28 g1, PSA 46 g1, ISA 6 g1, JON 3 g1, 1TH 1 g1,
  JHN 7 g3, REV 7 g2, 2CO 4 g2;
- 4 that never drifted: PSA 23 g1, ACT 2 g2, PRO 3 g2, EPH 1 g2.

**Result: 1 of 28 takes was American.** 1SA 6 take 1 was 100% American; take 2 was fine. All 8 takes of the
never-drifted sections still sound like Ali (match 0.79–0.84, 0–8% American), so the tag does no harm there.

A check of the speech activity confirmed the tag is not spoken: Job 28's 0.44 s tag timing is the same "Job, …
Chapter 28" shape as its other take.

**Combined: 1 drift in 43 tagged takes (~2%), against 9 in 15 untagged (~60%).** The tag alone isn't a guarantee,
so the pipeline needs the tag plus a QC re-render of any section that still drifts.

## Build + full scan (2026-11-17)

Steve: re-render everything questionable, check it with the scorer. Built (commit 16c7fbe):
src/accent.js (tag for Ali on v4, reuse stored takes, tagged preferred), generate.js
`ACCENT_REDO_FILE` / `DRY_RUN` / `ACCENT_QC` (drift check, up to 3 takes) / backup of replaced
chunks to `audio/_backup/2026-11-accent-redo`, `accent-scan.yml` (every stored generation, whole).

Scan run 44009801527 scored all 3,711 generations in full (not sampled). Results in
`data/accent/scan-2026-11-17.json`. Drift is two-humped: a drifted section is ≥ 80% American at
match 0.60–0.70; normal Ali sits at match 0.74–0.84. The old "likely" rule (≥ 50% pieces < 0.78)
mostly caught normal Ali's low tail, so the re-render list uses:

| Kind | Rule | Sections |
|---|---|---|
| clear | ≥ 25% of pieces US/Canada | 177 |
| low-match | match < 0.72 | 15 |
| mixed | ≥ 10% US and match < 0.76 | 22 |
| borderline | match 0.72–0.74 | 25 |
| **Total** (`data/accent/redo-full.json`) | | **239 sections, 196 chapters, 46 books** |

Dry run 44015576585: 239 chunks, 257,264 spoken chars ≈ **122K credits** before retries; every
listed chunk found, nothing unlisted would render. Balance then 776K. Pilot list
`data/accent/redo-pilot.json` = the 5 experiment sections + 6 others (~5K credits).

### Pilot (run 44070540096, 2026-11-17, ~5.1K credits + 1 retry)

11 sections re-rendered with the tag and drift check, published live (website notified), every
chapter's timestamps from the alignment. Report `data/accent/pilot-qc-2026-11-17.json`.
COL 3 #1 drifted AGAIN even tagged (97% US, match 0.65); the check caught it and take 2 was fine
(3% US, 0.82) — the QC gate earns its keep. The other 10 passed first take (0–17% US).
Note: the name-list sections (JOS 15 #3 0.68, 1CH 1 #3/#4 0.71–0.73, SNG 1 #9 0.64 on 2 pieces)
still score low match with ~0% US — low match there is the content (place/person names, very
short), not drift. So the low-match/borderline tiers are largely scorer noise; ear check decides.

Steve listened to the pilot: "They sound good definitely run the full set".

### Full re-render (2026-11-17) — DONE, LIVE

- Remaining 228 sections in 3 batches (`data/accent/redo-batch-{1,2,3}.json`), runs 44076670387,
  44082894714, 44090267415, ~40–57 min each. 255 takes; 18 sections needed a re-take; 6 kept "still
  American" after 3 takes. Report `data/accent/full-qc-2026-11-17.json`.
- Of those 6, 4 are 2–4-piece sections where one piece reads US every take at normal match (DAN 12
  #2, LUK 4 #2, NUM 26 #11, PRO 24 #2) — scorer noise, not drift. 2 were real: LEV 15 #1 and NUM 3 #7.
  Retry run 44100017689 (`redo-retry-1.json`, new `accent_qc_max_takes` input = 8): LEV 15 passed
  take 1; NUM 3 #7 drifted 7 of 8 takes and passed on take 8 (12% US, match 0.80).
- Credits ≈ 133K all in (pilot ~6K, batches ~125K incl. retries, retry run ~2.5K).

### Re-score (run 44100867560, whole Bible, 3,711 generations)

`data/accent/scan-2026-11-17-after.json`. With the same tiers as the redo list:

| | Before | After |
|---|---|---|
| clear (≥ 25% US) | 177 | 4 (2–4 pieces each, the noise above) |
| low-match | 15 | 7 |
| mixed | 22 | 6 |
| borderline | 25 | 13 |

All 30 still flagged are fresh tagged takes the drift check already passed: short sections and name
lists (JOS 15, 1CH 1/9, SNG 1–2, GEN 10/46, NUM 26). Steve heard JOS 15, 1CH 1, SNG 1, MRK 9 in the
pilot and approved them. No section anywhere is ≥ 50% American except DAN 12 #2 (1 of 2 pieces).
No untouched section was newly flagged. **Done.** Anything new rendered for Ali on v4 now gets the
tag automatically; run with `accent_qc=true` to also check it.

## Original next steps (all done)

1. Steve listens to tag takes to check that the accent isn't overdone and still sounds like the Ali he chose.
2. Pipeline changes:
   - put the tag before each generation's text;
   - make the timestamp builder skip it, as `PAUSE_MARKUP_RE` does for the pause tags;
   - fold it into the chunk key;
   - add a drift QC gate built on `score.py` that re-renders a generation that still comes back American.
3. Re-render only the drifted sections of the flagged chapters. This needs per-generation targeting, because whole
   chapters would be wasteful.
