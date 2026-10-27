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

## Next (awaiting Steve)

1. Steve listens to tag takes to check that the accent isn't overdone and still sounds like the Ali he chose.
2. Pipeline changes:
   - put the tag before each generation's text;
   - make the timestamp builder skip it, as `PAUSE_MARKUP_RE` does for the pause tags;
   - fold it into the chunk key;
   - add a drift QC gate built on `score.py` that re-renders a generation that still comes back American.
3. Re-render only the drifted sections of the flagged chapters. This needs per-generation targeting, because whole
   chapters would be wasteful.
