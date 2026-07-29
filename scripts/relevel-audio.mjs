/**
 * relevel-audio.mjs — Loudness-normalize already-generated chapter MP3s in GCS, in place,
 * WITHOUT re-running ElevenLabs (0 credits). Only files outside the ±tolerance band around
 * the target are re-encoded; in-band files are left untouched. Gain-only (two-pass linear
 * loudnorm) → duration preserved → existing timestamps stay valid.
 *
 * Usage:
 *   FFMPEG=/path/to/ffmpeg node scripts/relevel-audio.mjs bible/bsb/proverbs bible/bsb/2-timothy
 *   (each arg is a GCS book prefix under audio/;   defaults to the two Bible books)
 *
 * Requires: gcloud (authenticated) on PATH, and ffmpeg (via $FFMPEG or PATH).
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const BUCKET = process.env.GCS_BUCKET || 'noble-imprint-audiobooks';
const TARGET_LUFS = -20, TARGET_TP = -1.5, TARGET_LRA = 11, TOLERANCE = 2;

const prefixes = process.argv.slice(2);
if (prefixes.length === 0) prefixes.push('bible/bsb/proverbs', 'bible/bsb/2-timothy');

function sh(cmd) { return execSync(cmd, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }); }

function measure(path) {
  const out = sh(`"${FFMPEG}" -hide_banner -i "${path}" -af loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json -f null - 2>&1`);
  const j = JSON.parse(out.slice(out.lastIndexOf('{'), out.lastIndexOf('}') + 1));
  return { i: parseFloat(j.input_i), tp: parseFloat(j.input_tp), lra: parseFloat(j.input_lra), thr: parseFloat(j.input_thresh), off: parseFloat(j.target_offset) };
}

const work = mkdtempSync(join(tmpdir(), 'relevel-'));
let touched = 0, skipped = 0;
try {
  for (const prefix of prefixes) {
    const dir = `gs://${BUCKET}/audio/${prefix}`;
    const listing = sh(`gcloud storage ls "${dir}/"`).split('\n').map(s => s.trim())
      .filter(s => /\.mp3$/.test(s) && !s.includes('/chunks/'));
    console.log(`\n${prefix}: ${listing.length} chapter MP3(s)`);
    for (const gcsUri of listing) {
      const name = gcsUri.split('/').pop();
      const local = join(work, name);
      sh(`gcloud storage cp "${gcsUri}" "${local}"`);
      const m = measure(local);
      if (Math.abs(m.i - TARGET_LUFS) <= TOLERANCE) {
        console.log(`  ${name}: ${m.i.toFixed(1)} LUFS — in band, skip`);
        skipped++; continue;
      }
      const outPath = join(work, `n-${name}`);
      const filter = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thr}:offset=${m.off}:linear=true`;
      sh(`"${FFMPEG}" -hide_banner -i "${local}" -af "${filter}" -ar 44100 -b:a 128k "${outPath}" -y 2>&1`);
      sh(`gcloud storage cp "${outPath}" "${gcsUri}"`);
      console.log(`  ${name}: ${m.i.toFixed(1)} → ${TARGET_LUFS} LUFS ✓ re-uploaded`);
      touched++;
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nDone. ${touched} normalized, ${skipped} left as-is (in band).`);
