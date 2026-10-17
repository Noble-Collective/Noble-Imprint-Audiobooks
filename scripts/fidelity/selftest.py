"""Offline self-test of scoring + consensus + tiering (no audio, no network).

  python selftest.py      → exits non-zero on failure
"""
import json
import os
import subprocess
import sys
import tempfile

from common import chapter_record, normalize
from plan import flagged

RAW = ('Then Elizur son of Shedeur said, The LORD did not forsake us in the land of Egypt. '
       'And Moses went up the mountain alone. They numbered forty-six thousand, five hundred.')


CHAPTER = {'id': 'test/001', 'slug': 'test', 'book': 'Test', 'chapter': 1, 'duration': 10}


def record(d, engine, hyp):
    h = normalize(hyp)
    r = chapter_record(CHAPTER, engine, RAW, h, [float(i) for i in range(len(h))])
    # Counts must stay numbers (a run list once overwrote `ins` and broke the Vosk planning).
    assert all(isinstance(r[k], int) for k in ('del', 'ins', 'sub')), r
    json.dump(r, open(os.path.join(d, 't.json'), 'w'))
    return r


def main():
    with tempfile.TemporaryDirectory() as t:
        p1, p2, out = (os.path.join(t, x) for x in ('p1', 'p2', 'out'))
        os.makedirs(p1); os.makedirs(p2)
        # Both engines garble the names and miss "not"; both hear two extra words at the end;
        # only Whisper misses "alone" (single-engine → must NOT be reported); digits vs words agree.
        r1 = record(p1, 'whisper', 'then elisa son of shadow said the lord did forsake us in the land of egypt and moses '
                                   'went up the mountain they numbered 46,500 and then')
        assert flagged(r1), 'a chapter with dropped/added words must go to the Vosk pass'
        record(p2, 'vosk', 'then eliza son of shed or said the lord did forsake us in the land of egypt and moses '
                           'went up the mountain alone they numbered forty six thousand five hundred and then')
        subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'report.py'),
                        '--pass1', p1, '--pass2', p2, '--out', out], check=True, capture_output=True)
        items = json.load(open(os.path.join(out, 'audit.json')))['items']
    got = sorted((i['tier'], i['kind'], i['words']) for i in items)
    for g in got:
        print(*g)
    assert ('tier1', 'missing', 'not') in got, 'dropped negation must be tier 1'
    assert ('tier1', 'added', 'and then') in got, 'two added words heard by both must be tier 1'
    assert not any('alone' in w for _, _, w in got), 'a single-engine miss must not be reported'
    assert not any('46500' in w for _, _, w in got), 'digits vs spelled numbers must match'
    assert all(t != 'tier1' for t, k, w in got if 'shedeur' in w or 'elizur' in w), 'names are not tier 1'
    print('selftest ok')


if __name__ == '__main__':
    main()
