/**
 * preprocess-tts.js — Convert session markdown to ElevenLabs Studio from_content_json structure.
 *
 * Strips all markdown syntax, custom tags, and visual formatting.
 * Preserves text content structured as chapters with typed blocks (headings, paragraphs).
 * Studio handles pauses, pacing, and volume normalization via sub_type.
 */

import { convertBibleRef } from './bible-refs.js';

// Greek Unicode ranges (Basic Greek + Extended Greek)
const GREEK_RE = /[\u0370-\u03FF\u1F00-\u1FFF]{3,}/;

/**
 * Preprocess a single session markdown file into a Studio chapter object.
 * @param {string} markdown - Raw session markdown content
 * @param {string} voiceId - ElevenLabs voice ID for TTS nodes
 * @returns {{ name: string, blocks: Array, plainText: string }}
 */
export function preprocessSession(markdown, voiceId) {
  const lines = markdown.split('\n');
  const blocks = [];
  let chapterName = '';
  let currentParagraph = [];

  function flushParagraph() {
    if (currentParagraph.length === 0) return;
    let text = currentParagraph.join(' ').trim();
    // Add a paragraph break after numbered oration starts (e.g. "103. In the...")
    // so TTS pauses after the number instead of treating it as a list marker
    text = text.replace(/^(\d{1,3}\.)\s+/, '$1\n\n');
    if (text) {
      blocks.push(makeBlock('p', text, voiceId));
    }
    currentParagraph = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip empty lines — flush current paragraph
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    // Skip table rows
    if (trimmed.startsWith('|')) continue;

    // Skip horizontal rules
    if (/^-{3,}$/.test(trimmed)) continue;

    // Parse headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const text = cleanText(headingMatch[2]);

      // H1 = chapter title — extract name, emit with SSML pauses
      // Only H1/H2 get break tags; H3+ rely on period + paragraph separation
      // to avoid overloading ElevenLabs (too many breaks cause speed-up artifacts)
      if (level === 1) {
        chapterName = text;
        const spokenText = /[.!?]$/.test(text) ? text : text + '.';
        blocks.push(makeBlock('h1',
          `<break time="2s"/>${spokenText}<break time="2s"/>`, voiceId));
        continue;
      }

      const subType = `h${Math.min(level, 3)}`;
      const spokenHeading = /[.!?]$/.test(text) ? text : text + '.';
      if (level === 2) {
        // H2 = major section — clear structural transition
        blocks.push(makeBlock(subType,
          `<break time="1.5s"/>${spokenHeading}<break time="1.5s"/>`, voiceId));
      } else {
        // H3-H6 = subsections — 1s pause before only
        blocks.push(makeBlock(subType,
          `<break time="1s"/>${spokenHeading}`, voiceId));
      }
      continue;
    }

    // Regular text line — clean and accumulate into paragraph
    const cleaned = cleanLine(trimmed);
    if (cleaned) {
      currentParagraph.push(cleaned);
    }
  }

  flushParagraph();

  // Build plain text for hashing (all block text concatenated)
  const plainText = blocks.map(b => b.nodes[0].text).join('\n\n');

  // Build sentence index: each sentence gets a blockIndex + sentenceIndex.
  // Headings are single-sentence blocks. Paragraphs are split on sentence
  // boundaries (. ! ? followed by space or end of string).
  const sentences = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const blockText = blocks[bi].nodes[0].text;
    const sents = splitSentences(blockText);
    for (let si = 0; si < sents.length; si++) {
      sentences.push({ blockIndex: bi, sentenceIndex: si, text: sents[si] });
    }
  }

  return {
    name: chapterName || 'Untitled',
    blocks,
    sentences,
    plainText,
  };
}

/**
 * Split text into sentences. Handles abbreviations and quoted speech
 * conservatively — only splits on .!? followed by a space and uppercase
 * letter, or end of string.
 */
function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter(s => s.trim().length > 0).map(s => s.trim());
}

/**
 * Clean a single line of markdown, stripping formatting and tags.
 */
function cleanLine(line) {
  let s = line;

  // Strip <Question> tags (keep content)
  s = s.replace(/<Question[^>]*>/g, '');
  s = s.replace(/<\/Question>/g, '');

  // Strip heading markers that may remain after Question tag removal
  s = s.replace(/^#{1,6}\s+/, '');

  // Normalize specific headings for natural TTS pronunciation
  if (/^Reflection Questions$/i.test(s.trim())) s = 'Reflection questions';

  // Strip <Callout> tags (keep content)
  s = s.replace(/<\/?Callout>/g, '');

  // Convert <ChapterNum>N</ChapterNum> to spoken word form ("Chapter Eighteen")
  const numWords = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen','Twenty'];
  s = s.replace(/<ChapterNum>(\d+)<\/ChapterNum>/g, (_, n) => {
    const word = numWords[parseInt(n)] || n;
    return `Chapter ${word}.`;
  });

  // Strip <sup> verse numbers entirely (tag + content)
  // e.g. <sup>25</sup>, <sup>2:21</sup>
  s = s.replace(/<sup>[^<]*<\/sup>\s*/g, '');

  // Skip footnote definition lines [^1]: ... (must check before stripping references)
  if (/^\[\^\d+\]:/.test(s)) return '';

  // Strip footnote references [^1]
  s = s.replace(/\[\^\d+\]/g, '');

  // Strip <br> tags
  s = s.replace(/<br\s*\/?>/g, '');

  // Strip image references
  s = s.replace(/!\[.*?\]\(.*?\)/g, '');

  // Strip links (keep text)
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Convert attributions to spoken form
  if (s.startsWith('<< ')) {
    s = s.slice(3).trim();
    s = convertBibleRef(s);
    // Ensure attributions end with sentence punctuation for a natural pause
    if (s && !/[.!?]$/.test(s)) s += '.';
  }

  // Strip blockquote markers
  if (s.startsWith('> ')) {
    s = s.slice(2);
  }

  // Strip bold and italic markers
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/\*(.+?)\*/g, '$1');
  s = s.replace(/_(.+?)_/g, '$1');

  // Strip parenthetical verse references from commentary
  // e.g. (2:23), (cf. Hebrews 10:25), (2:22; cf. 2:21, 23–24, 27, 39)
  s = s.replace(/\s*\((?:cf\.\s*)?(?:\d+:\d+|[1-3]?\s*[A-Z][a-z]+\s+\d+)[^)]*\)/g, '');

  // Strip sub-paragraph numbers at start of line (e.g. "2 Hence arose..." → "Hence arose...")
  s = s.replace(/^\d{1,2}\s+(?=[A-Z])/, '');

  // Strip citation markers that weren't caught
  s = s.replace(/^<<\s*/, '');

  // Strip lines that are entirely Greek text
  if (GREEK_RE.test(s) && !s.replace(/[\u0370-\u03FF\u1F00-\u1FFF\s.,;:!?'"()—–\-]/g, '').trim()) {
    return '';
  }

  // Strip Greek text from mixed Greek+English lines (keep the English)
  if (GREEK_RE.test(s)) {
    s = s.replace(/[\u0370-\u03FF\u1F00-\u1FFF·;]+/g, '').replace(/\s+/g, ' ').replace(/^[,.\s]+/, '').trim();
  }

  // Skip lines that are entirely Latin — every word must match Latin vocabulary
  const LATIN_WORD = /^(a|ab|ac|ad|aeque|ante|apud|at|atque|aut|autem|brevem|cum|de|e|eius|enim|ergo|esse|est|et|etiam|ex|facimus|fuit|haec|hic|hoc|id|igitur|ille|illa|in|inopes|inter|ipse|ita|nec|neque|nihil|non|noster|nunc|ob|omnis|per|post|pro|prodigi|quae|quam|quasi|quem|qui|quia|quid|quod|se|sed|si|sic|sine|sub|sumus|sunt|tamen|ut|vel|vita|vitam|accipimus)$/i;
  const words = s.replace(/[.,;:!?'"()—–\-]/g, '').trim().split(/\s+/).filter(w => w);
  if (words.length >= 3 && words.every(w => LATIN_WORD.test(w))) {
    return '';
  }

  return s.trim();
}

/**
 * Clean heading text (strip bold/italic markers).
 */
function cleanText(text) {
  let s = text;
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/\*(.+?)\*/g, '$1');
  s = s.replace(/_(.+?)_/g, '$1');
  return s.trim();
}

/**
 * Create a Studio block.
 */
function makeBlock(subType, text, voiceId) {
  return {
    sub_type: subType,
    nodes: [{
      voice_id: voiceId,
      text,
      type: 'tts_node',
    }],
  };
}

/**
 * Preprocess multiple session files into the full from_content_json array.
 * @param {Array<{filename: string, content: string}>} sessions
 * @param {string} voiceId
 * @returns {{ chapters: Array, hashes: Object<string, string> }}
 */
export async function preprocessBook(sessions, voiceId) {
  const { createHash } = await import('node:crypto');
  const chapters = [];
  const hashes = {};

  for (const { filename, content } of sessions) {
    const chapter = preprocessSession(content, voiceId);
    chapters.push({
      name: chapter.name,
      blocks: chapter.blocks,
    });

    // SHA-256 of preprocessed plain text for change detection
    const hash = createHash('sha256').update(chapter.plainText).digest('hex');
    hashes[filename] = `sha256:${hash}`;
  }

  return { chapters, hashes };
}
