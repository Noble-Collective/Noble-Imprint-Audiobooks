import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, splitLongBlocks } from '../src/generate.js';

const collapse = s => s.replace(/\s+/g, ' ').trim();

// The exact pattern that broke The Call of Christ: a decimal like "4.0" inside a
// sentence made the old .match-based splitter drop everything before it.
const LICENSE = 'A core objective of this series is to establish believers. To facilitate ' +
  'this vision, we have taken a strategic stance on copyright and licensing. As part of a ' +
  'larger effort to provide unrestricted resources for the global church, we are publishing ' +
  'the content of the Narrative Journey series under a Creative Commons Attribution-ShareAlike ' +
  'license (CC BY-SA), version 4.0. A large amount of quality Christian content already exists ' +
  'in the world. The nature of this license allows us to "lock open" this content for the church.';

test('splitSentences is non-lossy (reconstructs the input word-for-word)', () => {
  const parts = splitSentences(LICENSE);
  assert.equal(collapse(parts.join(' ')), collapse(LICENSE),
    'joined sentences must equal the original — no text may be dropped');
});

test('splitSentences keeps the sentence spanning a decimal ("...version 4.0.")', () => {
  const parts = splitSentences(LICENSE);
  const joined = collapse(parts.join(' '));
  assert.ok(joined.includes('As part of a larger effort to provide unrestricted resources'),
    'the sentence before the "4.0" decimal must not be dropped');
  assert.ok(joined.includes('version 4.0'), 'the decimal itself must survive');
});

test('splitLongBlocks preserves all text when splitting a >target paragraph', () => {
  const long = LICENSE + ' ' + LICENSE; // force > target so it splits into pieces
  const block = { sub_type: 'p', nodes: [{ text: long }] };
  const pieces = splitLongBlocks([block], 300);
  assert.ok(pieces.length > 1, 'paragraph should be split into multiple pieces');
  const rejoined = collapse(pieces.map(p => p.nodes[0].text).join(' '));
  assert.equal(rejoined, collapse(long), 'no text may be lost across the split pieces');
});
