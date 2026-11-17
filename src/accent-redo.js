/**
 * accent-redo.js — the re-render list and the drift check for generate.js
 * (plans/2026-10-26-accent-drift.md).
 *
 * Re-render list (ACCENT_REDO_FILE), written by scripts/accent-check/make-redo.mjs from a scan:
 *   { "chunks": [ { "book": "bible/bsb/colossians", "session": "003.md", "code": "COL",
 *                   "chapter": 3, "chunk": 1, "file": "<stored chunk file name>" }, … ] }
 * detect-changes.js turns it into work items (just those chapters); generate.js renders just
 * those chunks again and reuses every other one from storage.
 *
 * Drift check: a long-lived `python scripts/accent-check/score.py --serve` scores each new take
 * (speaker match to Ali + accent label per ~4 s piece). A take counts as American when ≥ 25% of
 * its pieces are labelled US/Canada — the experiments' rule. Only that rejects a take: tagged takes
 * that sound like Ali score a slightly lower speaker match (0.79–0.84), so "low match" alone would
 * reject good takes.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCENT_QC_MAX_TAKES = parseInt(process.env.ACCENT_QC_MAX_TAKES || '3', 10);
export const AMERICAN_SHARE = 0.25;

export function isAmerican(score) {
  return (score.americanShare ?? 0) >= AMERICAN_SHARE;
}

/** The re-render list, or null when ACCENT_REDO_FILE is unset. */
export function loadRedo(path = process.env.ACCENT_REDO_FILE) {
  if (!path) return null;
  return parseRedo(JSON.parse(readFileSync(path, 'utf-8')));
}

export function parseRedo(json) {
  const rows = Array.isArray(json) ? json : json.chunks || [];
  const by = new Map();
  for (const r of rows) {
    if (!r.book || !r.session || !r.file) throw new Error(`re-render row needs book, session, file: ${JSON.stringify(r)}`);
    const k = `${r.book}|${r.session}`;
    if (!by.has(k)) by.set(k, new Set());
    by.get(k).add(r.file);
  }
  return {
    count: rows.length,
    rows,
    forSession: (book, session) => by.get(`${book}|${session}`) || new Set(),
    /** Bible chapters per book code: { COL: Set(3, …) } — for detect-changes.js */
    chaptersByCode() {
      const out = {};
      for (const r of rows) {
        if (!r.code || !r.chapter) throw new Error(`re-render row needs code + chapter: ${JSON.stringify(r)}`);
        (out[r.code] ||= new Set()).add(Number(r.chapter));
      }
      return out;
    },
  };
}

/** Start the scorer once (model load ~20 s); score(path) → { americanShare, lowShare, meanSim, pieces }. */
export function startScorer() {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, '..', 'scripts', 'accent-check', 'score.py');
  const py = spawn(process.env.ACCENT_PYTHON || 'python', [script, '--serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = [];
  let dead = null;
  createInterface({ input: py.stdout }).on('line', line => {
    if (!line.startsWith('SCORE ')) return;   // model-loading chatter
    const w = waiting.shift();
    if (!w) return;
    const r = JSON.parse(line.slice(6));
    if (r.error) w.reject(new Error(`score.py: ${r.error}`)); else w.resolve(r);
  });
  py.on('exit', code => {
    dead = new Error(`score.py exited (${code})`);
    while (waiting.length) waiting.shift().reject(dead);
  });
  return {
    score(path) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); py.stdin.write(path + '\n'); });
    },
    close() {
      return new Promise(res => { if (dead) return res(); py.on('exit', () => res()); py.stdin.end(); });
    },
  };
}
