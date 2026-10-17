"""Shared helpers for the audio-fidelity audit (does the narration say exactly the text?).

Method (plans/2026-09-14-audio-fidelity-validation.md): transcribe each chapter with two
independent speech recognisers (Whisper, then Vosk on chapters Whisper flags), normalise
reference and transcripts identically, align word-by-word, and only call something a
defect where BOTH engines disagree with the text at the same place. Single-engine
disagreement is recogniser noise.

Inputs are fetched through the resources site's public signed-URL API (no GCP creds):
  manifest.json, NNN.mp3, NNN.tts.json  under  bible/bsb/{slug}/
Reference text = the .tts.json plainText — exactly what was sent to ElevenLabs.
"""
import json
import os
import re
import time
import urllib.request

import jiwer
from whisper_normalizer.english import EnglishTextNormalizer

API = os.environ.get('AUDIO_API', 'https://resources.noblecollective.org/api/audio/url/')
HERE = os.path.dirname(os.path.abspath(__file__))
BOOKS = json.load(open(os.path.join(HERE, 'books.json')))   # [[slug, display name], …] canonical order

_norm = EnglishTextNormalizer()
PAUSE = re.compile(r'<break[^>]*/>|\[(?:short |long )?pause\]')


def _get(url, binary=False, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
                return data if binary else data.decode('utf-8')
        except Exception:  # noqa: BLE001 — network blips; retry with backoff
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def signed(path):
    return json.loads(_get(API + path))['url']


def fetch_json(path):
    return json.loads(_get(signed(path)))


def download(path, dest):
    with open(dest, 'wb') as f:
        f.write(_get(signed(path), binary=True))


def reference_text(tts):
    """The words ElevenLabs was asked to say: plainText minus pause markup. Bracket
    characters are dropped (the Whisper normaliser deletes whole bracketed spans, which
    once produced a phantom 9-word 'insertion' in Genesis 13)."""
    t = PAUSE.sub(' ', tts['plainText'])
    return re.sub(r'[\[\]()]', ' ', t)


def normalize(text):
    return _norm(text).split()


def align(ref, hyp):
    """Word alignment → per-ref-word ok flags + deletion/insertion/substitution runs.
    Runs carry ref positions so the two engines can be compared position by position."""
    ok = [False] * len(ref)
    dels, ins, subs = [], [], []
    hyp_at = [None] * len(ref)   # hyp word index aligned to each ref word (equal/sub)
    if not ref or not hyp:
        if ref:
            dels.append({'ref_start': 0, 'ref_end': len(ref), 'words': ref})
        return {'ok': ok, 'dels': dels, 'ins': ins, 'subs': subs, 'hyp_at': hyp_at}
    out = jiwer.process_words(' '.join(ref), ' '.join(hyp))
    for c in out.alignments[0]:
        if c.type == 'equal':
            for k in range(c.ref_end_idx - c.ref_start_idx):
                ok[c.ref_start_idx + k] = True
                hyp_at[c.ref_start_idx + k] = c.hyp_start_idx + k
        elif c.type == 'delete':
            dels.append({'ref_start': c.ref_start_idx, 'ref_end': c.ref_end_idx,
                         'words': ref[c.ref_start_idx:c.ref_end_idx]})
        elif c.type == 'insert':
            ins.append({'after_ref': c.ref_start_idx - 1, 'words': hyp[c.hyp_start_idx:c.hyp_end_idx]})
        else:  # substitute
            for k in range(c.ref_end_idx - c.ref_start_idx):
                hyp_at[c.ref_start_idx + k] = c.hyp_start_idx + k
            subs.append({'ref_start': c.ref_start_idx, 'ref_end': c.ref_end_idx,
                         'ref': ref[c.ref_start_idx:c.ref_end_idx], 'hyp': hyp[c.hyp_start_idx:c.hyp_end_idx]})
    return {'ok': ok, 'dels': dels, 'ins': ins, 'subs': subs, 'hyp_at': hyp_at}


def score(ref, hyp):
    a = align(ref, hyp)
    n_del = sum(len(d['words']) for d in a['dels'])
    n_ins = sum(len(i['words']) for i in a['ins'])
    n_sub = sum(len(s['ref']) for s in a['subs'])
    wer = (n_del + n_ins + n_sub) / max(len(ref), 1)
    return a, {'wer': round(wer, 5), 'n_ref': len(ref), 'del': n_del, 'ins': n_ins, 'sub': n_sub}


def chapter_record(chapter, engine, ref_raw, words, times):
    """One chapter's result, exactly as transcribe.py writes it (and selftest.py checks it).
    `del`/`ins`/`sub` are word COUNTS; the alignment runs are `*_runs`."""
    a, m = score(normalize(ref_raw), words)
    return {'id': chapter['id'], 'slug': chapter['slug'], 'book': chapter['book'], 'chapter': chapter['chapter'],
            'duration': chapter['duration'], 'engine': engine, **m,
            'ok': ''.join('1' if x else '0' for x in a['ok']),
            'del_runs': a['dels'], 'ins_runs': a['ins'], 'sub_runs': a['subs'],
            'hyp_at': a['hyp_at'], 'hyp': words, 'hyp_times': times, 'ref_raw': ref_raw}


def shard(items, n, k, weight):
    """Deterministic duration-balanced split: longest first, onto the lightest shard."""
    loads = [[0.0, []] for _ in range(n)]
    for it in sorted(items, key=lambda x: (-weight(x), x['id'])):
        loads.sort(key=lambda l: l[0])
        loads[0][0] += weight(it)
        loads[0][1].append(it)
    # Re-sort shards by first id so shard k is stable regardless of tie order.
    loads.sort(key=lambda l: l[1][0]['id'] if l[1] else '~')
    return loads[k][1]
