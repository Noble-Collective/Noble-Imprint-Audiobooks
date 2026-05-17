/**
 * bible-refs.js — Convert Bible reference strings to spoken form.
 *
 * "1 Corinthians 4:1–2" → "First Corinthians, chapter 4, verses 1 through 2."
 * "Acts 2:1-13" → "Acts, chapter 2, verses 1 through 13."
 * "Romans 8:28" → "Romans, chapter 8, verse 28."
 */

const NUMBER_WORDS = {
  '1': 'First',
  '2': 'Second',
  '3': 'Third',
};

// Match: optional number prefix + book name + chapter:verse[-verse]
const REF_RE = /^([1-3])?\s*([A-Za-z][A-Za-z .]+?)\s+(\d+):(\d+)(?:\s*[–—\-]\s*(\d+))?(.*)$/;

/**
 * Convert a Bible reference string to spoken form.
 * If not a recognizable reference, returns the input unchanged.
 */
export function convertBibleRef(text) {
  const m = text.match(REF_RE);
  if (!m) return text;

  const [, numPrefix, bookName, chapter, verseStart, verseEnd, remainder] = m;

  let spoken = '';

  // Book name with optional number prefix
  if (numPrefix && NUMBER_WORDS[numPrefix]) {
    spoken += `${NUMBER_WORDS[numPrefix]} ${bookName.trim()}`;
  } else if (numPrefix) {
    spoken += `${numPrefix} ${bookName.trim()}`;
  } else {
    spoken += bookName.trim();
  }

  // Chapter
  spoken += `, chapter ${chapter}`;

  // Verse(s)
  if (verseEnd) {
    spoken += `, verses ${verseStart} through ${verseEnd}`;
  } else {
    spoken += `, verse ${verseStart}`;
  }

  spoken += '.';

  // Append any trailing text (rare)
  if (remainder && remainder.trim()) {
    spoken += ' ' + remainder.trim();
  }

  return spoken;
}
