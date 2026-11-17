/**
 * merge-scan.mjs — joins list-chunks.mjs rows with score.py --list results and classifies each
 * stored generation (plans/2026-10-26-accent-drift.md):
 *   clear    ≥ 25% of its ~4 s pieces labelled US/Canada (the experiments' "American take")
 *   likely   not clear, but ≥ 50% of pieces match Ali < 0.78 (score.py's low-match rule)
 *   unscored fewer than 2 pieces (very short) or a scoring error
 *   ok       everything else
 * Writes accent-scan.json (every row + its scores), summary.md, and two re-render lists for
 * generate.js (ACCENT_REDO_FILE): redo-clear.json and redo-clear-likely.json.
 *
 * usage: node merge-scan.mjs chunks.json <scores dir> <out dir>
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [chunksPath, scoresDir, outDir] = process.argv.slice(2);
const rows = JSON.parse(readFileSync(chunksPath, 'utf-8'));
const scores = new Map();
for (const f of readdirSync(scoresDir).filter(f => f.endsWith('.json'))) {
  for (const s of JSON.parse(readFileSync(join(scoresDir, f), 'utf-8'))) scores.set(s.file.replace(/\.mp3$/, ''), s);
}

const CREDITS_PER_CHAR = 0.475;
for (const r of rows) {
  const s = scores.get(r.file);
  if (!s || s.error || (s.pieces ?? 0) < 2) {
    r.tier = 'unscored'; r.why = s?.error || (s ? `${s.pieces} piece(s)` : 'not scored');
    if (s && !s.error) Object.assign(r, { pieces: s.pieces, meanSim: s.meanSim, americanShare: s.americanShare, lowShare: s.lowShare });
    continue;
  }
  Object.assign(r, { pieces: s.pieces, meanSim: s.meanSim, americanShare: s.americanShare, lowShare: s.lowShare, detail: s.detail });
  r.tier = s.americanShare >= 0.25 ? 'clear' : s.lowShare >= 0.5 ? 'likely' : 'ok';
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'accent-scan.json'), JSON.stringify(rows));
const redo = tiers => ({ chunks: rows.filter(r => tiers.includes(r.tier)).map(({ book, session, code, chapter, chunk, file }) => ({ book, session, code, chapter, chunk, file })) });
writeFileSync(join(outDir, 'redo-clear.json'), JSON.stringify(redo(['clear']), null, 1));
writeFileSync(join(outDir, 'redo-clear-likely.json'), JSON.stringify(redo(['clear', 'likely']), null, 1));

const tally = tier => {
  const t = rows.filter(r => tier.includes(r.tier));
  const chars = t.reduce((n, r) => n + r.chars, 0);
  return { sections: t.length, chapters: new Set(t.map(r => `${r.book}|${r.session}`)).size, chars, credits: Math.round(chars * CREDITS_PER_CHAR) };
};
const line = (label, t) => `| ${label} | ${t.sections} | ${t.chapters} | ${t.chars.toLocaleString()} | ~${Math.round(t.credits / 1000)}K |`;
const byBook = {};
for (const r of rows) if (r.tier === 'clear' || r.tier === 'likely') (byBook[r.code] ||= { clear: 0, likely: 0 })[r.tier]++;
const md = [
  '# Accent-drift scan — every stored generation', '',
  '| Tier | Sections | Chapters | Spoken chars | Credits |', '|---|---|---|---|---|',
  line('Clear (American)', tally(['clear'])),
  line('Likely (low match)', tally(['likely'])),
  line('Clear + likely', tally(['clear', 'likely'])),
  line('Unscored (very short)', tally(['unscored'])),
  line('All', tally(['clear', 'likely', 'ok', 'unscored'])), '',
  '## By book (clear / likely)', '',
  ...Object.entries(byBook).sort((a, b) => (b[1].clear + b[1].likely) - (a[1].clear + a[1].likely)).map(([c, v]) => `- ${c}: ${v.clear} / ${v.likely}`),
].join('\n');
writeFileSync(join(outDir, 'summary.md'), md + '\n');
console.log(md);
