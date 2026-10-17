"""Transcribe one shard of chapters with one engine and score it against the text.

  python transcribe.py --engine whisper|vosk --chapters chapters.json --shard K --of N --out DIR

Writes DIR/{slug}__{NNN}.json per chapter: metrics, alignment runs, the hypothesis words
with their times (to locate a finding in the audio), and the reference text.
Resumable: a chapter whose output already exists is skipped.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

from common import chapter_record, download, fetch_json, normalize, reference_text, shard


def whisper_engine():
    from faster_whisper import WhisperModel
    model = WhisperModel(os.environ.get('WHISPER_MODEL', 'small.en'), device='cpu', compute_type='int8',
                         cpu_threads=os.cpu_count() or 4)

    def run(mp3):
        segs, _ = model.transcribe(mp3, language='en', beam_size=5, vad_filter=True,
                                   condition_on_previous_text=False)
        words, times = [], []
        for s in segs:
            # Silence hallucinations: low confidence AND likely no speech. No compression-ratio
            # test — scripture is legitimately repetitive (the Numbers 1 census compresses well),
            # and dropping those segments manufactured 84 "missing" words in the pilot. Loops are
            # already handled by faster-whisper's own temperature fallback.
            if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
                continue
            w = normalize(s.text)
            words += w
            times += [round(s.start, 2)] * len(w)
        return words, times
    return run


def vosk_engine():
    from vosk import KaldiRecognizer, Model, SetLogLevel
    SetLogLevel(-1)
    model = Model(os.environ['VOSK_MODEL'])

    def run(mp3):
        rec = KaldiRecognizer(model, 16000)
        rec.SetWords(True)
        p = subprocess.Popen(['ffmpeg', '-loglevel', 'quiet', '-i', mp3, '-ar', '16000', '-ac', '1', '-f', 's16le', '-'],
                             stdout=subprocess.PIPE)
        results = []
        while True:
            data = p.stdout.read(8000)
            if not data:
                break
            if rec.AcceptWaveform(data):
                results.append(json.loads(rec.Result()))
        results.append(json.loads(rec.FinalResult()))
        words, times = [], []
        for r in results:
            for w in r.get('result', []):
                n = normalize(w['word'])
                words += n
                times += [round(w['start'], 2)] * len(n)
        return words, times
    return run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--engine', required=True, choices=['whisper', 'vosk'])
    ap.add_argument('--chapters', required=True)
    ap.add_argument('--shard', type=int, default=0)
    ap.add_argument('--of', type=int, default=1)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    chapters = shard(json.load(open(a.chapters)), a.of, a.shard, lambda c: c['duration'])
    todo = [c for c in chapters if not os.path.exists(os.path.join(a.out, c['id'].replace('/', '__') + '.json'))]
    total = sum(c['duration'] for c in chapters)
    print(f'[{a.engine}] shard {a.shard}/{a.of}: {len(chapters)} chapters, {total / 3600:.2f} h audio, {len(todo)} to do', flush=True)
    run = whisper_engine() if a.engine == 'whisper' else vosk_engine()
    t0 = time.time()
    done_audio = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for i, c in enumerate(todo):
            mp3 = os.path.join(tmp, 'ch.mp3')
            download(c['mp3'], mp3)
            tts = fetch_json(c['tts'])
            ref_raw = reference_text(tts)
            words, times = run(mp3)
            out = chapter_record(c, a.engine, ref_raw, words, times)
            m = out
            with open(os.path.join(a.out, c['id'].replace('/', '__') + '.json'), 'w') as f:
                json.dump(out, f)
            done_audio += c['duration']
            el = time.time() - t0
            print(f'  {c["id"]}: WER {m["wer"]:.3f} del {m["del"]} ins {m["ins"]} sub {m["sub"]}  '
                  f'({i + 1}/{len(todo)}, {done_audio / max(el, 1):.2f}x realtime)', flush=True)


if __name__ == '__main__':
    sys.exit(main())
