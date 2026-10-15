/**
 * pauses.js — the narration's pauses, by KIND rather than by hard-coded markup.
 *
 * Preprocessing and chunking ask for a kind of pause ("title", "section", …); how that
 * pause is written into the text depends on what the model understands:
 *   - 'ssml' (eleven_multilingual_v2): <break time="Xs"/> with an exact duration. These are
 *     the durations the whole library was rendered with — the ssml output is byte-for-byte
 *     the markup that used to be written inline, so existing chunk hashes are unchanged.
 *   - 'tags' (eleven_v4 / eleven_v3): no SSML ("SSML is not supported"); the model takes
 *     [long pause] / [short pause]. No duration control — measured on v4 with the Ali voice
 *     (v4-probe, 2026-10-15): [long pause] ≈ 1.8s, [short pause] ≈ 0.7s.
 *
 * Section-boundary pauses in the "section" chunking strategy are not markup at all — they
 * are real silence inserted when the generations are joined (generate.js concatenateChunks),
 * using `seconds` below. That works the same on every model.
 *
 * Both markup forms appear in ElevenLabs' character alignment, so the timestamp builder
 * strips them with PAUSE_MARKUP_RE (and maps positions back) whichever style was used.
 */

export const PAUSES = {
  title:      { seconds: 2.0, tag: '[long pause]' },   // h1 — chapter title
  section:    { seconds: 1.5, tag: '[long pause]' },   // h2 — section heading
  subsection: { seconds: 1.0, tag: '[short pause]' },  // h3–h6
  transition: { seconds: 2.0, tag: '[long pause]' },   // blockquote summary → body text (Seneca)
  seam:       { seconds: 0.5, tag: '[short pause]' },  // linear chunk seam at a paragraph
  midSeam:    { seconds: 0.3, tag: '[short pause]' },  // linear chunk seam inside a paragraph
  breath:     { seconds: 0.4, tag: null },             // section strategy cap-split (concat silence only)
  // Silence after the last word of a chapter file (concat silence only). ElevenLabs trims
  // generation edges to ~0.1s, so without it the next chapter starts almost at once when a
  // player auto-advances. Tail only: every timestamp is measured from the start, so none move.
  // Opt-in per book: meta.audiobook.chapter_end_pause (on in the BSB "v4" profile).
  chapterEnd: { seconds: 2.0, tag: null },
};

// Heading level → pause kind.
export const HEADING_PAUSE = { h1: 'title', h2: 'section', h3: 'subsection', h4: 'subsection', h5: 'subsection', h6: 'subsection' };

// Measured tag lengths (see header) — used where code compares two adjacent pauses.
const TAG_SECONDS = { '[long pause]': 1.8, '[short pause]': 0.7, '[pause]': 1.0 };

export const PAUSE_MARKUP_RE = /<break[^>]*\/>|\[(?:short |long )?pause\]/g;
// Same, anchored for "is there pause markup at this exact position" scans.
const PAUSE_AT_RE = /<break[^>]*\/>|\[(?:short |long )?pause\]/y;

/** Which markup a model understands. */
export function pauseStyleForModel(modelId) {
  return /^eleven_v[34]/.test(modelId || '') ? 'tags' : 'ssml';
}

/** The markup for one pause of `kind` in `style` ('ssml' | 'tags'). */
export function pause(kind, style = 'ssml') {
  const p = PAUSES[kind];
  if (!p) throw new Error(`unknown pause kind: ${kind}`);
  if (style === 'tags') {
    if (!p.tag) throw new Error(`pause kind ${kind} has no tag form`);
    return p.tag;
  }
  return `<break time="${p.seconds}s"/>`;
}

/** Text with every pause (either style) removed. */
export function stripPauses(text) {
  return text.replace(PAUSE_MARKUP_RE, '');
}

/** Length of the pause markup starting exactly at `index`, or 0. */
export function pauseMarkupLengthAt(text, index) {
  PAUSE_AT_RE.lastIndex = index;
  const m = PAUSE_AT_RE.exec(text);
  return m ? m[0].length : 0;
}

/** Seconds a single piece of pause markup stands for. */
export function pauseSecondsOf(markup) {
  const m = markup.match(/<break time="([0-9.]+)s"\/>/);
  if (m) return parseFloat(m[1]);
  return TAG_SECONDS[markup] ?? 0;
}
