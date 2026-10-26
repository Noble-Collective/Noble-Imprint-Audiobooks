"""Accent-drift score for narration MP3s: how close each one sounds to the Ali voice.

Cuts each file into ~4 s pieces (silence skipped) and scores every piece with two models:
  - speaker match: cosine of a speechbrain ECAPA (VoxCeleb) embedding vs ali-ref.json
    (normal Ali ≈ 0.85–0.95; the 2026-10-26 whole-Bible scan flagged pieces < 0.78)
  - accent: speechbrain CommonAccent ECAPA; normal Ali reads as "england" (no Arabic class),
    drifted pieces as "us"/"canada"
A file is DRIFTED when ≥ 25% of its pieces sound American/Canadian, or ≥ 50% score < 0.78.
Calibrated on the live Colossians audio (fixed 4 s pieces): ch 1/2/4 = 3–4% American, 21–25% low;
ch 3 (first section drifted) = 69% American, 78% low.

usage: python score.py <dir> [out.json]   (scores every *.mp3 in <dir>)
needs: torch, torchaudio, speechbrain, soundfile, numpy; ffmpeg on PATH (or FFMPEG=...)
"""
import glob, json, os, subprocess, sys
import numpy as np, torch
from speechbrain.inference.speaker import EncoderClassifier
from speechbrain.utils.fetching import LocalStrategy

HERE = os.path.dirname(os.path.abspath(__file__))
FF = os.environ.get("FFMPEG", "ffmpeg")
LOW, LOW_SHARE, NA_SHARE, SR, WIN = 0.78, 0.50, 0.25, 16000, 4.0
MODELS = os.environ.get("ACCENT_MODELS", os.path.join(HERE, ".models"))

ref = np.array(json.load(open(os.path.join(HERE, "ali-ref.json")))["embedding"])
spk = EncoderClassifier.from_hparams("speechbrain/spkrec-ecapa-voxceleb", savedir=f"{MODELS}/spk", local_strategy=LocalStrategy.COPY)
acc = EncoderClassifier.from_hparams("Jzuluaga/accent-id-commonaccent_ecapa", savedir=f"{MODELS}/acc", local_strategy=LocalStrategy.COPY)
labels = acc.hparams.label_encoder.ind2lab

def pcm(path):
    raw = subprocess.run([FF, "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)

def pieces(x):
    """~4 s pieces; skips near-silent ones (pauses)."""
    n = int(WIN * SR)
    for i in range(0, len(x) - SR, n):
        seg = x[i:i + n]
        if len(seg) < 2 * SR or np.sqrt(np.mean(seg ** 2)) < 0.01:
            continue
        yield i / SR, seg

def score(path):
    rows = []
    for t, seg in pieces(pcm(path)):
        w = torch.tensor(seg.copy()).unsqueeze(0)
        with torch.no_grad():
            e = spk.encode_batch(w).squeeze().numpy()
            p = acc.classify_batch(w)[0].squeeze()
        p = torch.softmax(p, -1).numpy() if (p.min() < 0 or p.sum() > 1.01) else p.numpy()
        rows.append({"t": round(t, 1), "sim": round(float(e @ ref / np.linalg.norm(e)), 4), "accent": labels[int(p.argmax())]})
    sims = np.array([r["sim"] for r in rows]) if rows else np.array([0.0])
    low = float(np.mean(sims < LOW))
    na = float(np.mean([r["accent"] in ("us", "canada") for r in rows])) if rows else 0.0
    return {"file": os.path.basename(path), "pieces": len(rows), "meanSim": round(float(sims.mean()), 3),
            "lowShare": round(low, 2), "americanShare": round(na, 2), "drifted": na >= NA_SHARE or low >= LOW_SHARE, "detail": rows}

if __name__ == "__main__":
    d = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(d, "scores.json")
    res = [score(f) for f in sorted(glob.glob(os.path.join(d, "*.mp3")))]
    json.dump(res, open(out, "w"), indent=1)
    for r in res:
        print(f"{r['file']:40s} match {r['meanSim']:.3f}  low {r['lowShare']:.0%}  american {r['americanShare']:.0%}  {'DRIFTED' if r['drifted'] else 'ok'}")
