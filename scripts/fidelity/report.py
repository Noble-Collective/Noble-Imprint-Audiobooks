"""Combine the two passes into a ranked report.

  python report.py --pass1 pass1/ --pass2 pass2/ --out report/

Consensus: a source word is a candidate MISSING word only if BOTH engines fail to match it;
a candidate ADDED word only if both engines insert words at the same place (±1 word).
Candidates are then tiered by meaning, using what the September (v2) audit learned:
  - recognisers fail on rare Hebrew names together, so name-dominated runs are noise;
  - units (ephah, seah …), BSB compounds (freewill, firstfruits …), ordinals → noise;
  - a dropped negation ("not", "no", "never") always matters; so do 3+ word drops and
    2+ word additions.
Tier 1 = listen to these. Tier 2 = probably recogniser noise. Name/vocab = known noise.
"""
import argparse
import csv
import glob
import json
import os
import re
import statistics

NEG = {'not', 'no', 'never', 'nor', 'neither', 'none', 'nothing', 'cannot'}
VOCAB = {'ephah', 'ephahs', 'seah', 'seahs', 'cor', 'cors', 'homer', 'homers', 'omer', 'hin', 'bath', 'baths',
         'gerah', 'gerahs', 'log', 'cubit', 'cubits', 'shekel', 'shekels', 'talent', 'talents', 'mina', 'minas',
         'freewill', 'firstfruits', 'firstborn', 'menservants', 'maidservants', 'facedown', 'manservant',
         'maidservant', 'ephod', 'ephods', 'teraphim', 'asherah', 'asherim', 'selah', 'hallelujah', 'shiggaion',
         'miktam', 'maskil', 'gittith', 'sheminith', 'alamoth', 'mahalath', 'jeduthun', 'lo', 'behold'}
V2_BASELINE = {'mean_wer': 0.0183, 'median_wer': 0.0116, 'tier1': 22, 'confirmed': 0,
               'source': 'plans/2026-09-14-audio-fidelity-validation.md (Sept 2026, multilingual v2)'}


def load(d):
    out = {}
    for p in glob.glob(os.path.join(d, '**', '*.json'), recursive=True):
        r = json.load(open(p))
        out[r['id']] = r
    return out


def proper_nouns(raw):
    """Lower-cased capitalised words that aren't sentence-initial — names, places."""
    names = set()
    for m in re.finditer(r'(?<![.!?:;“"]\s)(?<!^)\b([A-Z][a-z’\'-]+)', raw):
        names.add(m.group(1).lower().replace('’', "'"))
        for part in re.split(r'[-’\']', m.group(1).lower()):
            if part:
                names.add(part)
    return names


def runs(idx):
    out, cur = [], []
    for i in idx:
        if cur and i != cur[-1] + 1:
            out.append(cur)
            cur = []
        cur.append(i)
    if cur:
        out.append(cur)
    return out


def classify_missing(words, names):
    if any(w in NEG for w in words):
        return 'tier1', 'dropped negation'
    named = sum(1 for w in words if w in names)
    vocab = sum(1 for w in words if w in VOCAB or re.fullmatch(r'\d+(st|nd|rd|th)?', w))
    if named * 2 >= len(words):
        return 'name', 'proper noun(s)'
    if vocab * 2 >= len(words):
        return 'vocab', 'unit / compound / number'
    if len(words) >= 3:
        return 'tier1', f'{len(words)} consecutive words not heard'
    return 'tier2', 'short miss'


def time_at(r, i):
    """Audio time near ref word i, from the engine's aligned hypothesis word."""
    for d in range(0, 40):
        for j in (i - d, i + d):
            if 0 <= j < len(r['hyp_at']) and r['hyp_at'][j] is not None and r['hyp_at'][j] < len(r['hyp_times']):
                return r['hyp_times'][r['hyp_at'][j]]
    return None


def mmss(t):
    return '—' if t is None else f'{int(t // 60)}:{int(t % 60):02d}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pass1', required=True)
    ap.add_argument('--pass2', default='')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    p1 = load(a.pass1)
    p2 = load(a.pass2) if a.pass2 and os.path.isdir(a.pass2) else {}
    from common import normalize  # noqa: E402 — after argparse so --help works without deps

    items = []
    for cid, w in sorted(p1.items()):
        v = p2.get(cid)
        if not v:
            continue
        ref = normalize(w['ref_raw'])
        names = proper_nouns(w['ref_raw'])
        n = min(len(w['ok']), len(v['ok']))
        both_miss = [i for i in range(n) if w['ok'][i] == '0' and v['ok'][i] == '0']
        for run in runs(both_miss):
            words = [ref[i] for i in run]
            tier, why = classify_missing(words, names)
            lo, hi = max(0, run[0] - 8), min(len(ref), run[-1] + 9)
            ctx = ' '.join(ref[lo:run[0]] + ['[[' + ' '.join(words) + ']]'] + ref[run[-1] + 1:hi])
            items.append({'id': cid, 'book': w['book'], 'chapter': w['chapter'], 'kind': 'missing',
                          'tier': tier, 'why': why, 'words': ' '.join(words), 'n': len(words),
                          'time': time_at(w, run[0]), 'context': ctx})
        vins = {}
        for x in v['ins_runs']:
            vins.setdefault(x['after_ref'], []).extend(x['words'])
        for x in w['ins_runs']:
            g = x['after_ref']
            vw = vins.get(g) or vins.get(g - 1) or vins.get(g + 1)
            if not vw:
                continue
            n_add = min(len(x['words']), len(vw))
            tier = 'tier1' if n_add >= 2 else 'tier2'
            lo, hi = max(0, g - 7), min(len(ref), g + 9)
            ctx = ' '.join(ref[lo:g + 1] + ['++' + ' '.join(x['words']) + '++'] + ref[g + 1:hi])
            items.append({'id': cid, 'book': w['book'], 'chapter': w['chapter'], 'kind': 'added',
                          'tier': tier, 'why': f'both engines heard extra words (vosk: "{" ".join(vw)}")',
                          'words': ' '.join(x['words']), 'n': n_add, 'time': time_at(w, max(g, 0)), 'context': ctx})

    wers = [r['wer'] for r in p1.values()]
    hours = sum(r['duration'] for r in p1.values()) / 3600
    by = lambda t: [i for i in items if i['tier'] == t]  # noqa: E731
    summary = {
        'chapters': len(p1), 'audio_hours': round(hours, 1),
        'whisper_mean_wer': round(statistics.mean(wers), 4) if wers else None,
        'whisper_median_wer': round(statistics.median(wers), 4) if wers else None,
        'pct_under_3': round(100 * sum(1 for x in wers if x < 0.03) / max(len(wers), 1), 1),
        'over_10': sum(1 for x in wers if x > 0.10),
        'vosk_checked': len(p2),
        'tier1': len(by('tier1')), 'tier2': len(by('tier2')), 'name': len(by('name')), 'vocab': len(by('vocab')),
        'v2_baseline': V2_BASELINE,
    }
    json.dump({'summary': summary, 'items': items}, open(os.path.join(a.out, 'audit.json'), 'w'), indent=1)
    with open(os.path.join(a.out, 'audit.csv'), 'w', newline='', encoding='utf-8') as f:
        wr = csv.DictWriter(f, fieldnames=['tier', 'kind', 'book', 'chapter', 'time', 'n', 'words', 'why', 'context', 'id'])
        wr.writeheader()
        for i in sorted(items, key=lambda i: (i['tier'], i['id'])):
            wr.writerow({**i, 'time': mmss(i['time'])})

    L = ['# Bible audio fidelity audit — Eleven v4', '',
         f'{summary["chapters"]} chapters, {summary["audio_hours"]} h audio. Whisper small.en on every chapter; '
         f'Vosk (en-us-0.22) re-checked the {summary["vosk_checked"]} chapters Whisper flagged. '
         'A finding needs BOTH engines to disagree with the text at the same place.', '',
         '| | v4 (now) | v2 (Sept 2026) |', '|---|---|---|',
         f'| Whisper mean WER | {100 * (summary["whisper_mean_wer"] or 0):.2f}% | {100 * V2_BASELINE["mean_wer"]:.2f}% |',
         f'| Whisper median WER | {100 * (summary["whisper_median_wer"] or 0):.2f}% | {100 * V2_BASELINE["median_wer"]:.2f}% |',
         f'| Chapters under 3% WER | {summary["pct_under_3"]}% | 87% |',
         f'| Tier 1 (listen) | {summary["tier1"]} | {V2_BASELINE["tier1"]} (all verified as recogniser artefacts) |',
         f'| Tier 2 / names / vocab | {summary["tier2"]} / {summary["name"]} / {summary["vocab"]} | 275 / 546 / — |', '',
         '## Tier 1 — listen to these', '',
         '| Where | Time | Kind | Why | Text ([[missing]] / ++added++) |', '|---|---|---|---|---|']
    for i in sorted(by('tier1'), key=lambda i: i['id']):
        L.append(f'| {i["book"]} {i["chapter"]} | {mmss(i["time"])} | {i["kind"]} | {i["why"]} | {i["context"]} |')
    L += ['', '## Highest-WER chapters (Whisper)', '', '| Chapter | WER | del | ins | sub |', '|---|---|---|---|---|']
    for r in sorted(p1.values(), key=lambda r: -r['wer'])[:25]:
        L.append(f'| {r["book"]} {r["chapter"]} | {100 * r["wer"]:.1f}% | {r["del"]} | {r["ins"]} | {r["sub"]} |')
    open(os.path.join(a.out, 'audit.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
