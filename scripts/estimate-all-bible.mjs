import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { usfmBookToChapters } from '../src/usfm-to-markdown.js';
import { preprocessSession } from '../src/preprocess-tts.js';

const contentDir = process.argv[2];

// Canonical order + testament + display name, keyed by USFM code.
const BOOKS = [
  ['GEN','Genesis','OT'],['EXO','Exodus','OT'],['LEV','Leviticus','OT'],['NUM','Numbers','OT'],['DEU','Deuteronomy','OT'],
  ['JOS','Joshua','OT'],['JDG','Judges','OT'],['RUT','Ruth','OT'],['1SA','1 Samuel','OT'],['2SA','2 Samuel','OT'],
  ['1KI','1 Kings','OT'],['2KI','2 Kings','OT'],['1CH','1 Chronicles','OT'],['2CH','2 Chronicles','OT'],['EZR','Ezra','OT'],
  ['NEH','Nehemiah','OT'],['EST','Esther','OT'],['JOB','Job','OT'],['PSA','Psalms','OT'],['PRO','Proverbs','OT'],
  ['ECC','Ecclesiastes','OT'],['SNG','Song of Solomon','OT'],['ISA','Isaiah','OT'],['JER','Jeremiah','OT'],['LAM','Lamentations','OT'],
  ['EZK','Ezekiel','OT'],['DAN','Daniel','OT'],['HOS','Hosea','OT'],['JOL','Joel','OT'],['AMO','Amos','OT'],
  ['OBA','Obadiah','OT'],['JON','Jonah','OT'],['MIC','Micah','OT'],['NAM','Nahum','OT'],['HAB','Habakkuk','OT'],
  ['ZEP','Zephaniah','OT'],['HAG','Haggai','OT'],['ZEC','Zechariah','OT'],['MAL','Malachi','OT'],
  ['MAT','Matthew','NT'],['MRK','Mark','NT'],['LUK','Luke','NT'],['JHN','John','NT'],['ACT','Acts','NT'],
  ['ROM','Romans','NT'],['1CO','1 Corinthians','NT'],['2CO','2 Corinthians','NT'],['GAL','Galatians','NT'],['EPH','Ephesians','NT'],
  ['PHP','Philippians','NT'],['COL','Colossians','NT'],['1TH','1 Thessalonians','NT'],['2TH','2 Thessalonians','NT'],['1TI','1 Timothy','NT'],
  ['2TI','2 Timothy','NT'],['TIT','Titus','NT'],['PHM','Philemon','NT'],['HEB','Hebrews','NT'],['JAS','James','NT'],
  ['1PE','1 Peter','NT'],['2PE','2 Peter','NT'],['1JN','1 John','NT'],['2JN','2 John','NT'],['3JN','3 John','NT'],
  ['JUD','Jude','NT'],['REV','Revelation','NT'],
];

const DONE = new Set(['PRO','2TI']); // already generated & live

// Map code -> file by reading each SFM's \id line
const files = readdirSync(contentDir).filter(f => /\.sfm$/i.test(f));
const byCode = {};
for (const f of files) {
  const txt = readFileSync(join(contentDir, f), 'utf-8');
  const m = txt.match(/\\id\s+(\S+)/);
  if (m) byCode[m[1].toUpperCase()] = { f, txt };
}

function bookChars(txt) {
  const chapters = usfmBookToChapters(txt);
  let chars = 0, chs = 0;
  for (const { markdown } of chapters) {
    const pre = preprocessSession(markdown, 'compare', 'en', true);
    chars += pre.plainText.length;
    chs++;
  }
  return { chars, chs };
}

const rows = [];
for (const [code, name, test] of BOOKS) {
  const rec = byCode[code];
  if (!rec) { rows.push({ code, name, test, chs: 0, chars: 0, missing: true }); continue; }
  const { chars, chs } = bookChars(rec.txt);
  rows.push({ code, name, test, chs, chars, done: DONE.has(code) });
}

// Empirically, ElevenLabs bills ~0.587x the spoken-char count on this account.
// Refined from the full NT batch (2026-09-01): balance-based actual 572,654 credits for
// 976,076 chars = 0.5867. (The earlier 0.567 came from just Proverbs + 2 Tim.)
const FACTOR = 0.587;
// MEASURED billed credits from reliable full-book run AUDIT logs (big books only —
// small-book per-run deltas are corrupted by ElevenLabs usage-counter lag across fast runs).
const MEASURED = { PRO: 45979, MAT: 73477, MRK: 47100, LUK: 80269, JHN: 58578 };

const usd = c => (c / 10000 * 1.65);
const fmt = n => n.toLocaleString('en-US');
const credits = r => MEASURED[r.code] != null ? MEASURED[r.code] : Math.round(r.chars * FACTOR);

console.log('CODE\tBook\tT\tCh\tChars\tCredits\t$\tSrc');
for (const r of rows) {
  const c = r.missing ? 0 : credits(r);
  const src = MEASURED[r.code] != null ? 'MEASURED' : (r.missing ? 'MISSING' : 'est');
  console.log(`${r.code}\t${r.name}\t${r.test}\t${r.chs}\t${r.chars}\t${c}\t${usd(c).toFixed(2)}\t${src}${r.done?' (done)':''}`);
}

const sum = (pred) => rows.filter(pred).reduce((a, r) => a + (r.missing ? 0 : credits(r)), 0);
const otAll = sum(r => r.test === 'OT');
const ntAll = sum(r => r.test === 'NT');
const otRem = sum(r => r.test === 'OT' && !r.done);
const ntRem = sum(r => r.test === 'NT' && !r.done);
console.log('\n--- TOTALS (credits ≈ chars; $ = c/10000*1.65) ---');
console.log(`OT all 39:     ${fmt(otAll)}  $${usd(otAll).toFixed(2)}`);
console.log(`OT remaining:  ${fmt(otRem)}  $${usd(otRem).toFixed(2)}   (minus Proverbs)`);
console.log(`NT all 27:     ${fmt(ntAll)}  $${usd(ntAll).toFixed(2)}`);
console.log(`NT remaining:  ${fmt(ntRem)}  $${usd(ntRem).toFixed(2)}   (minus 2 Timothy)`);
console.log(`WHOLE BIBLE:   ${fmt(otAll+ntAll)}  $${usd(otAll+ntAll).toFixed(2)}`);
console.log(`REMAINING:     ${fmt(otRem+ntRem)}  $${usd(otRem+ntRem).toFixed(2)}   (64 books, minus Proverbs + 2 Timothy)`);
