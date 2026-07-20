/**
 * languages.js — Per-language spoken-text customization layer for TTS.
 *
 * Scripture references and numeric ranges read badly when spoken literally
 * ("Proverbs 1-9" → "Proverbs one dash nine"). Each language config below
 * supplies the vocabulary and book names needed to expand these into natural
 * speech, keyed off the book's `language` field in meta.json (default 'en').
 *
 *   EN:  "Proverbs 1-9"    → "Proverbs, chapters 1 through 9"
 *        "Psalm 78:19-20"  → "Psalm, chapter 78, verses 19 through 20"
 *        "Jude 24-25"      → "Jude, verses 24 through 25"   (single-chapter book)
 *   FR:  "Actes 2:1-47"    → "Actes, chapitre 2, versets 1 à 47"
 *        "Jean 10v27-28"   → "Jean, chapitre 10, versets 27 à 28"
 *
 * To add a language: add an entry to LANGUAGES with its vocabulary + book list.
 */

const EN_BOOKS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges',
  'Ruth', 'Samuel', 'Kings', 'Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job',
  'Psalms', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song of Solomon', 'Isaiah',
  'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai',
  'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans',
  'Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians',
  'Thessalonians', 'Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', 'Peter',
  'Jude', 'Revelation',
];
const EN_SINGLE_CHAPTER = new Set(['Obadiah', 'Philemon', 'Jude']); // "2 John"/"3 John" handled via ordinal+John rare in prose

const FR_BOOKS = [
  'Genèse', 'Exode', 'Lévitique', 'Nombres', 'Deutéronome', 'Josué', 'Juges',
  'Ruth', 'Samuel', 'Rois', 'Chroniques', 'Esdras', 'Néhémie', 'Esther', 'Job',
  'Psaumes', 'Psaume', 'Proverbes', 'Ecclésiaste', 'Cantique des Cantiques',
  'Ésaïe', 'Esaïe', 'Jérémie', 'Lamentations', 'Ézéchiel', 'Daniel', 'Osée',
  'Joël', 'Amos', 'Abdias', 'Jonas', 'Michée', 'Nahum', 'Habacuc', 'Sophonie',
  'Aggée', 'Zacharie', 'Malachie', 'Matthieu', 'Marc', 'Luc', 'Jean', 'Actes',
  'Romains', 'Corinthiens', 'Galates', 'Éphésiens', 'Philippiens', 'Colossiens',
  'Thessaloniciens', 'Timothée', 'Tite', 'Philémon', 'Hébreux', 'Jacques',
  'Pierre', 'Jude', 'Apocalypse',
];
const FR_SINGLE_CHAPTER = new Set(['Abdias', 'Philémon', 'Jude']);

const LANGUAGES = {
  en: {
    code: 'en',
    ordinals: { '1': 'First', '2': 'Second', '3': 'Third' },
    chapter: 'chapter', chapters: 'chapters',
    verse: 'verse', verses: 'verses',
    through: 'through',
    books: EN_BOOKS,
    singleChapter: EN_SINGLE_CHAPTER,
  },
  fr: {
    code: 'fr',
    ordinals: { '1': 'Premier', '2': 'Deuxième', '3': 'Troisième' },
    chapter: 'chapitre', chapters: 'chapitres',
    verse: 'verset', verses: 'versets',
    through: 'à',
    books: FR_BOOKS,
    singleChapter: FR_SINGLE_CHAPTER,
  },
};

export function getLanguage(code) {
  return LANGUAGES[code] || LANGUAGES.en;
}

function buildBookAlternation(books) {
  return books
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(b => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const _refReCache = {};
function refRegex(L) {
  if (_refReCache[L.code]) return _refReCache[L.code];
  const bookAlt = buildBookAlternation(L.books);
  // ordinal? book chapter [ (:|v) verseStart [- verseEnd] | - chapterEnd ]
  const re = new RegExp(
    `\\b(?:([1-3])\\s+)?(${bookAlt})\\s*(\\d+)` +
      `(?:\\s*[:v]\\s*(\\d+)(?:\\s*[-–—]\\s*(\\d+))?|\\s*[-–—]\\s*(\\d+))?`,
    'gi'
  );
  _refReCache[L.code] = re;
  return re;
}

function spokenBook(L, ordinal, book) {
  if (ordinal) return `${L.ordinals[ordinal] || ordinal} ${book}`;
  return book;
}

// Canonical-case lookup so "proverbs" matches the single-chapter set entry.
function isSingleChapter(L, book) {
  for (const b of L.singleChapter) {
    if (b.toLowerCase() === book.toLowerCase()) return true;
  }
  return false;
}

/**
 * Expand scripture references and numeric ranges into natural spoken form.
 * Used both for `<<` attribution lines (whole string is a reference) and for
 * references embedded in body prose. Book names are restricted to the language's
 * known list to avoid false positives (e.g. "Oration 2:16-34" is left alone).
 */
export function normalizeSpoken(text, code = 'en') {
  const L = getLanguage(code);

  // 1) Scripture references (known book names only).
  text = text.replace(refRegex(L),
    (match, ordinal, book, chapter, verseStart, verseEnd, chapterEnd) => {
      const name = spokenBook(L, ordinal, book);
      if (verseStart) {
        let s = `${name}, ${L.chapter} ${chapter}`;
        s += verseEnd
          ? `, ${L.verses} ${verseStart} ${L.through} ${verseEnd}`
          : `, ${L.verse} ${verseStart}`;
        return s;
      }
      if (chapterEnd) {
        // Single-chapter books: "Book N-M" is a verse range, not chapters.
        if (isSingleChapter(L, book)) {
          return `${name}, ${L.verses} ${chapter} ${L.through} ${chapterEnd}`;
        }
        return `${name}, ${L.chapters} ${chapter} ${L.through} ${chapterEnd}`;
      }
      return match; // bare "Book N" — leave untouched
    });

  // 2) Any remaining bare numeric range (page/date/etc.) → "N through/à M".
  text = text.replace(/(\d+)\s*[-–—]\s*(\d+)/g, `$1 ${L.through} $2`);

  return text;
}

/**
 * Convert a standalone reference (a `<<` attribution). Thin wrapper over
 * normalizeSpoken since a whole-string reference is a subset of the prose case.
 */
export function convertReference(text, code = 'en') {
  return normalizeSpoken(text.trim(), code);
}
