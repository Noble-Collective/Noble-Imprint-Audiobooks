/**
 * usfm-to-markdown.js — Convert a book of the Bible (USFM) into per-chapter session
 * markdown in the exact convention the audiobook pipeline already consumes
 * (see samples/psalm-1-2.md and HomeStead scripture):
 *
 *   # {Book} {N}                         ← H1 chapter title (spoken, paused)
 *   ## {section heading}                 ← from \s1 (spoken, paused)
 *   ### {sub heading}                    ← from \s2
 *   <sup>1</sup>Verse text… <sup>2</sup>…  ← paragraph; verse numbers are SILENT
 *
 * This is the ONLY genuinely new logic for Bible audiobooks. Everything downstream
 * (preprocess-tts.js → generate.js → the web player) already handles this shape:
 * `<sup>…</sup>` verse numbers are stripped to silent, headings get SSML pauses, and
 * the highlight sync matches sentences against <h1–h6>/<p> blocks.
 *
 * Design notes (verified against bibles/bsb/content/*.SFM):
 *  - Poetry: consecutive \q1/\q2/\qr/… lines are grouped into ONE stanza paragraph.
 *    Paragraphs break only on prose markers (\p, \m…), \b, headings, chapter — NOT on
 *    every \q (that per-line
 *    break is the "one verse per line" look we are deliberately moving away from).
 *  - cleanInline() strips ALL USFM markers (footnotes \f…\f*, xrefs \x…\x*, char styles
 *    \add \nd \wj, etc.) but keeps inner text. It runs on every content segment, so no
 *    text is ever lost even if a line is misclassified — classification only affects
 *    paragraph grouping.
 *  - \d superscriptions (Psalms) are emitted as spoken paragraphs (the Coram-Deo ingest
 *    drops these — we must not).
 *  - Guard-safety: output contains ONLY <sup>…</sup> + markdown headings. A self-check
 *    rejects any residual "\" USFM marker or non-<sup> tag before the markdown is used,
 *    so we never trip generate.js's hard-fail timestamp guard.
 *
 * Usage:
 *   node src/usfm-to-markdown.js --tx bsb --book 2TI [--chapters 1-2] [--out DIR]
 *                                [--resources PATH] [--print]
 *   --tx         translation folder under bibles/ (default: bsb)
 *   --book       3-letter USFM book code (e.g. PRO, 2TI, PSA)
 *   --chapters   range like "1" or "1-4" (default: all)
 *   --resources  path to Noble-Imprint-Resources (default: ../Noble-Imprint-Resources)
 *   --out        write NNN.md per chapter to DIR (default: dry-run, no files)
 *   --print      print each chapter's markdown to stdout
 * Always prints a spoken-text + char/credit estimate summary (via preprocessSession).
 * This tool spends NO ElevenLabs credits.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preprocessSession } from './preprocess-tts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- USFM cleaning ------------------------------------------------------------

/**
 * Strip all USFM markup from an inline text segment, keeping the readable text.
 * Order matters: footnotes/xrefs (which contain \fr \ft sub-markers whose TEXT we do
 * NOT want spoken) are removed as whole spans first, then any remaining char-style /
 * paragraph markers are stripped generically (inner text preserved).
 */
function cleanInline(raw) {
  let t = raw || '';
  // Footnotes: \f + \fr REF \ft TEXT\f*  (non-greedy; handles BSB "1:3" & KJV "1.1" refs,
  // mid-verse notes, and back-to-back \f*\f+). The opening is "\f " (marker + space);
  // "\ft"/"\fr" won't false-match because a letter, not whitespace, follows the f.
  t = t.replace(/\\f\s.*?\\f\*/g, '');
  // Inline cross-references: \x … \x*
  t = t.replace(/\\x\s.*?\\x\*/g, '');
  // Any remaining closing char-style markers, e.g. \wj* \add* \nd* \tl* \it*
  t = t.replace(/\\[a-z]+\d*\*/gi, '');
  // Any remaining opening/standalone markers, e.g. \p \q1 \m \add \nd \wj \li1
  t = t.replace(/\\[a-z]+\d*\s?/gi, ' ');
  // Literal pilcrow used by some editions for paragraph breaks
  t = t.replace(/¶\s*/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

// Lines that begin a new PROSE paragraph (poetry \q* deliberately excluded so stanzas
// stay grouped; \b is the stanza/paragraph separator inside poetry).
const NEW_PARA_RE = /^\\(p|pi\d?|pc|pmo|pmc|pmr|pm|m|mi|nb|b)\b/;
// Break poetry into per-couplet blocks by flushing at each level-1 poetry line
// (\q1). \q2/\q3 continuation lines stay grouped, so a \q1+\q2 couplet becomes one
// block and gets a natural pause after it — cadence from structure, not <break>
// tags. Default off keeps flowing poetry (stanza grouping). Gated per-call via
// opts.poetryCouplets (falls back to the POETRY_COUPLETS=1 env var for CLI use).
const Q1_LINE_RE = /^\\q1\b/;

// ---- Parse a whole book into ordered per-chapter blocks -----------------------

/**
 * @param {string} usfmText raw USFM/SFM file contents
 * @param {{bookLabel?: string}} [opts] override the H1 book label (default: \h value)
 * @returns {{ bookName: string, chapters: Array<{num:number, blocks:Array<{type:string,text:string}>}> }}
 */
export function parseUsfmBook(usfmText, opts = {}) {
  // Per-couplet poetry blocks: opt-in per call (opts.poetryCouplets), env fallback.
  const poetryCouplets = opts.poetryCouplets ?? (process.env.POETRY_COUPLETS === '1');
  const lines = usfmText.split(/\r?\n/);
  let bookName = '';
  let chapterNum = 0;
  let cur = null;                 // current chapter { num, blocks }
  const chapters = [];
  let para = '';                  // accumulating paragraph string (with inline <sup>)

  function flushPara() {
    const t = para.trim();
    if (t && cur) cur.blocks.push({ type: 'p', text: t });
    para = '';
  }
  // Append text to the current paragraph. `label` (verse number/range) → inline <sup>.
  function append(text, label) {
    if (label) {
      para += (para ? ' ' : '') + `<sup>${label}</sup>` + text;
    } else if (text) {
      para += (para ? ' ' : '') + text;
    }
  }
  // Split a content line on \v markers (keeping verse bridges like "3-4") and append
  // leading continuation text + each verse to the current paragraph.
  function processContent(line) {
    const parts = line.split(/\\v\s+(\d+(?:[-–]\d+)?)\s*/);
    const leading = cleanInline(parts[0]);
    if (leading) append(leading, null);
    for (let i = 1; i < parts.length; i += 2) {
      append(cleanInline(parts[i + 1] || ''), parts[i]);
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('\\h ')) { bookName = line.slice(3).trim(); continue; }

    if (line.startsWith('\\c ')) {
      flushPara();
      chapterNum = parseInt(line.slice(3).trim(), 10);
      cur = { num: chapterNum, blocks: [] };
      chapters.push(cur);
      continue;
    }

    if (chapterNum === 0) continue; // front matter before first \c (\id \toc \mt …)

    // Book-division super-headings (Psalms "\ms BOOK I" / "\mr Psalms 1—41") — drop.
    // Require the "s"/"r" so the prose marker "\m " is NOT swallowed here.
    if (/^\\ms\d?\s/.test(line) || line.startsWith('\\mr ')) continue;

    // Section headings → spoken, paused.
    if (line.startsWith('\\s1 ') || line.startsWith('\\s2 ')) {
      flushPara();
      const level = line.startsWith('\\s1') ? 'h2' : 'h3';
      cur.blocks.push({ type: level, text: cleanInline(line.replace(/^\\s[12]\s+/, '')) });
      continue;
    }

    // Cross-reference line under a heading — silent, drop.
    if (line.startsWith('\\r ')) continue;

    // Psalm superscription → its own spoken paragraph (strip any embedded footnote first).
    if (line.startsWith('\\d ')) {
      flushPara();
      const text = cleanInline(line.slice(3));
      if (text) cur.blocks.push({ type: 'p', text });
      continue;
    }

    // Prose paragraph / stanza boundary.
    if (NEW_PARA_RE.test(line)) flushPara();
    // Per-couplet poetry blocks — flush at each \q1 line start, but ONLY when the
    // block so far has closed with punctuation. If it's still "open" (bare line end
    // = enjambment, sentence continues), keep flowing into the next couplet so a
    // run-on poetic sentence stays one block. No false full-stops.
    if (poetryCouplets && Q1_LINE_RE.test(line) && /[.!?;:,—–]["'”’)\]]*\s*$/.test(para)) {
      flushPara();
    }

    // Everything else is content (verses, poetry lines, continuations). cleanInline
    // strips the leading marker (\q1, \m, \p, …) and any inline styles.
    processContent(line);
  }
  flushPara();

  return { bookName: opts.bookLabel || bookName, chapters };
}

// ---- Serialize a chapter to session markdown ----------------------------------

export function chapterToMarkdown(bookName, chapter) {
  const out = [`# ${bookName} ${chapter.num}`];
  for (const b of chapter.blocks) {
    if (b.type === 'h2') out.push(`## ${b.text}`);
    else if (b.type === 'h3') out.push(`### ${b.text}`);
    else out.push(b.text);
  }
  return out.join('\n\n') + '\n';
}

// Guard-safety self-check: the pipeline strips <sup> and headings; anything else that
// looks like a leftover USFM marker or stray tag would either be spoken literally or
// (for tags) trip generate.js's timestamp validation. Reject before use.
export function assertClean(markdown, where) {
  const problems = [];
  const bs = markdown.match(/\\[a-zA-Z]+/g);
  if (bs) problems.push(`leftover USFM marker(s): ${[...new Set(bs)].slice(0, 5).join(', ')}`);
  // Allow only <sup>/</sup>; flag any other tag.
  const tags = markdown.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g) || [];
  const bad = tags.filter(t => !/^<\/?sup>$/.test(t));
  if (bad.length) problems.push(`unexpected tag(s): ${[...new Set(bad)].slice(0, 5).join(', ')}`);
  if (problems.length) throw new Error(`Unclean output in ${where}: ${problems.join('; ')}`);
}

/** Full book → [{ chapter, markdown }] with self-check applied. */
export function usfmBookToChapters(usfmText, opts = {}) {
  const { bookName, chapters } = parseUsfmBook(usfmText, opts);
  return chapters.map(ch => {
    const markdown = chapterToMarkdown(bookName, ch);
    assertClean(markdown, `${bookName} ${ch.num}`);
    return { chapter: ch.num, markdown, bookName };
  });
}

// ---- CLI ----------------------------------------------------------------------

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      a[key] = val;
    }
  }
  return a;
}

export function findBookFile(contentDir, tx, code) {
  const files = readdirSync(contentDir);
  const upperCode = code.toUpperCase();
  // BSB: "20PROBSB.SFM" / "562TIBSB.SFM"; KJV: "20-PSAeng-kjv.usfm"
  const marker = tx === 'kjv' ? 'ENG-KJV' : 'BSB';
  const hit = files.find(f => {
    const u = f.toUpperCase();
    return (u.endsWith('.SFM') || u.endsWith('.USFM')) && u.includes(upperCode) && u.includes(marker);
  });
  if (!hit) throw new Error(`No ${tx} file for book code "${code}" in ${contentDir}`);
  return join(contentDir, hit);
}

export function parseChapterRange(spec, max) {
  if (!spec || spec === 'true') return null; // all
  const m = spec.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`Bad --chapters "${spec}"`);
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  return { lo, hi };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const tx = (a.tx || 'bsb').toLowerCase();
  const code = a.book;
  if (!code) { console.error('Missing --book (3-letter USFM code, e.g. PRO, 2TI)'); process.exit(1); }
  const resources = resolve(a.resources || join(__dirname, '..', '..', 'Noble-Imprint-Resources'));
  const contentDir = join(resources, 'bibles', tx, 'content');

  const file = findBookFile(contentDir, tx, code);
  const usfm = readFileSync(file, 'utf-8');
  let chapters = usfmBookToChapters(usfm, a.label ? { bookLabel: a.label } : {});

  const range = parseChapterRange(a.chapters);
  if (range) chapters = chapters.filter(c => c.chapter >= range.lo && c.chapter <= range.hi);

  console.log(`Source: ${file}`);
  console.log(`Book: ${chapters[0]?.bookName}  |  chapters: ${chapters.length}${range ? ` (${range.lo}-${range.hi})` : ' (all)'}\n`);

  let totalChars = 0;
  const outDir = (a.out && a.out !== 'true') ? resolve(a.out) : null;
  if (outDir) mkdirSync(outDir, { recursive: true });

  for (const { chapter, markdown } of chapters) {
    const pre = preprocessSession(markdown, 'compare', 'en', true);
    const chars = pre.plainText.length;
    totalChars += chars;
    console.log(`  ch ${String(chapter).padStart(3)}  blocks=${markdown.split('\n\n').length - 1}  spokenChars=${chars}`);
    if (a.print === 'true') {
      console.log('\n----- MARKDOWN -----\n' + markdown);
      console.log('----- SPOKEN -----\n' + pre.plainText + '\n');
    }
    if (outDir) {
      const fp = join(outDir, `${String(chapter).padStart(3, '0')}.md`);
      writeFileSync(fp, markdown);
    }
  }

  const cost = (totalChars / 10000 * 1.65).toFixed(2);
  console.log(`\nTotal spoken chars: ${totalChars}  ≈  ${totalChars} credits  ≈  $${cost}  (no credits spent by this tool)`);
  if (outDir) console.log(`Wrote ${chapters.length} chapter file(s) to ${outDir}`);
}

// Run as CLI only when invoked directly.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1]?.endsWith('usfm-to-markdown.js')) {
  main();
}
