# Eleven v4 Bible — audio fidelity audit (2026-10-18)

**Result: 0 confirmed defects.** The v4 narration of all 1,189 BSB chapters (77.4 h) says the
text. Same conclusion as the Sept 2026 audit of the v2 audio.

Run: `fidelity-audit.yml` run 39025540819 (GitHub Actions, free — public repo). Whisper small.en
on every chapter (40 shards); Vosk en-us-0.22 re-checked the 884 chapters Whisper flagged
(30 shards); only places where BOTH disagree with the text count. Code: `scripts/fidelity/`.
Method + v2 history: `plans/2026-09-14-audio-fidelity-validation.md`.

| | v4 (2026-10-18) | v2 (2026-09-16) |
|---|---|---|
| Whisper mean WER | 1.84% | 1.83% |
| Whisper median WER | 1.09% | 1.16% |
| Chapters under 3% WER | 89.3% | 87% |
| Tier 1 as first reported | 10 | 22 |
| Confirmed defects after review | **0** | **0** |

## The 10 first-pass Tier 1 items — all recogniser artefacts

Checked against both engines' transcripts at each spot:

| Item | What the engines heard |
|---|---|
| Romans 9 0:36 "theirs are the patriarchs" | both: "there is other patriarchs" — sound-alike |
| Genesis 23 2:05 "Ephron's field at" | "Ephron is feel that" / "l forums feel that" — sound-alike |
| Ezra 2 2:43 / Nehemiah 7 3:50 "Immer, 1,052" | name heard as "I am going to" / "ima"; the number is right |
| Mark 4 / Matthew 13 "thirtyfold … hundredfold" | compound split as "30 fold" / "100 fold" |
| Numbers 31 "72; 30,500" | our normaliser merged the two numbers; recognisers kept them apart |
| Psalm 119 "Taw" | Hebrew letter heading heard as "te a" |
| Nehemiah 11 / 12 | lists of names, re-spelled by both engines |

`report.py` now classifies these patterns itself (2026-10-18): a run where both engines heard
other words is "misheard", not a skip; "-fold" compounds, Psalm 119 letters and digit-only
additions next to a number are vocabulary; names after `;`/`,` count as names. Re-scored on the
same transcripts: **Tier 1 = 0**, Tier 2 1,250 (single-engine-agreeing noise), names 5,605,
vocabulary 255. A dropped negation is always Tier 1 — there were none.

## Whisper-only gaps (not defects)

The highest-WER chapters (Psalms 113, 124, 125, 146, 135, 66; Hosea 11; 1 Thessalonians 2;
Ezekiel 30) are Whisper skipping 30–80 words — mostly the opening right after the chapter title.
Vosk heard them (e.g. Psalm 125: 68/68 words), so the audio is complete. Genealogy / name-list
chapters (1 Chronicles 1–8, Joshua 15/19, Ezra 10, Nehemiah 10–11) are high for the same reason
as in Sept: both recognisers mishear rare Hebrew names.

## Re-running

Actions → "Audio fidelity audit (Whisper + Vosk)" → Run workflow (filter empty = whole Bible,
~2–3 h). Report = run summary + `fidelity-report` artifact (audit.md / .csv / .json).
To re-score without re-transcribing: download the `pass1-*`/`pass2-*` artifacts and run
`python report.py --pass1 … --pass2 … --out …`.
