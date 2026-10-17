"""Build the chapter list (and the shard matrix) for an audit run.

  python plan.py --filter "" --shards 40 --out chapters.json            # whole Bible
  python plan.py --filter "obadiah,numbers/001" --shards 2 --out chapters.json
  python plan.py --flagged-from pass1/ --shards 30 --out chapters2.json  # Vosk pass: flagged only

Prints a GitHub Actions matrix line to $GITHUB_OUTPUT (shards=[0..n-1], sized so no shard is empty).
"""
import argparse
import glob
import json
import os

from common import BOOKS, fetch_json

FLAG_WER = 0.08


def flagged(r):
    """Whisper disagreed with the text: anything dropped or added, or a high WER."""
    return r['del'] > 0 or r['ins'] > 0 or r['wer'] > FLAG_WER


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--filter', default='')
    ap.add_argument('--flagged-from', default='')
    ap.add_argument('--chapters', default='', help='full chapter list (for --flagged-from)')
    ap.add_argument('--shards', type=int, default=40)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    if a.flagged_from:
        allc = {c['id']: c for c in json.load(open(a.chapters))}
        rows = [json.load(open(p)) for p in glob.glob(os.path.join(a.flagged_from, '**', '*.json'), recursive=True)]
        chapters = [allc[r['id']] for r in rows if flagged(r) and r['id'] in allc]
        print(f'{len(chapters)} of {len(rows)} chapters flagged by pass 1')
    else:
        want = [w.strip() for w in a.filter.split(',') if w.strip()]
        chapters = []
        for slug, name in BOOKS:
            if want and not any(w == slug or w.startswith(slug + '/') for w in want):
                continue
            m = fetch_json(f'bible/bsb/{slug}/manifest.json')
            for s in sorted(m['sessions'], key=lambda s: s['sessionFile']):
                nnn = s['sessionFile'][:3]
                cid = f'{slug}/{nnn}'
                if want and slug not in want and cid not in want:
                    continue
                chapters.append({'id': cid, 'slug': slug, 'book': name, 'chapter': int(nnn),
                                 'mp3': f'bible/bsb/{slug}/{s["audioFile"]}',
                                 'tts': f'bible/bsb/{slug}/{s["ttsFile"]}',
                                 'duration': s.get('durationSeconds') or 0, 'model': s.get('modelId')})
        hours = sum(c['duration'] for c in chapters) / 3600
        print(f'{len(chapters)} chapters, {hours:.1f} h audio')

    json.dump(chapters, open(a.out, 'w'))
    n = max(1, min(a.shards, len(chapters)))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
            f.write(f'shards={json.dumps(list(range(n)))}\n')
            f.write(f'count={len(chapters)}\n')


if __name__ == '__main__':
    main()
