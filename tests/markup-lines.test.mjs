// A line that is only markup has nothing to say. Content can carry such lines (a stray
// `<div class="ig-theme-blush">` wrapper in The Story Behind It All, 2026-11-22; an
// `<!-- @include: Key -->` directive), and before this the narrator read them aloud as text
// ("<div class=…>."). Lines with words keep their words; everything already narrated is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preprocessSession } from '../src/preprocess-tts.js';

const V = 'voice';
const spoken = (md) => preprocessSession(md, V).blocks.map(b => b.nodes[0].text).join(' | ');

test('a line that is only an HTML tag is not read aloud', () => {
  const md = '# Session 2\n\n<div class="ig-theme-blush">\n\n## Overview\n\nSome text.\n\n</div>\n';
  const out = spoken(md);
  assert.ok(!out.includes('<div'), out);
  assert.ok(!out.includes('</div'), out);
  assert.equal(preprocessSession(md, V).blocks.filter(b => b.sub_type === 'p').length, 1);
});

test('a line that is only an HTML comment (an include directive) is not read aloud', () => {
  const out = spoken('# S\n\n<!-- @include: SeriesPreface -->\n\nText.\n');
  assert.ok(!out.includes('@include'), out);
  assert.ok(!out.includes('<!--'), out);
});

test('several tags on one line, and self-closing tags, are markup only', () => {
  const out = spoken('# S\n\n<div class="a"><span>\n\n<PracticeSummary label="Lament" />\n\nText.\n');
  for (const tag of ['<div', '<span', 'PracticeSummary']) assert.ok(!out.includes(tag), out);
  assert.equal(preprocessSession('# S\n\n<div class="a"><span>\n\n<PracticeSummary label="Lament" />\n\nText.\n', V)
    .blocks.filter(b => b.sub_type === 'p').length, 1);
});

test('a markup-only line inside a paragraph does not split it or add words', () => {
  const plain = preprocessSession('# S\n\nOne line\nsecond line.\n', V);
  const tagged = preprocessSession('# S\n\nOne line\n<span class="x">\nsecond line.\n', V);
  assert.deepEqual(tagged.blocks, plain.blocks);
});

test('lines with words keep them', () => {
  const out = spoken('# S\n\n<Callout>Satan is the foe of God.</Callout>\n\n<Question id=Q1>1. Why?</Question>\n');
  assert.ok(out.includes('Satan is the foe of God.'), out);
  assert.ok(out.includes('1. Why?') || out.includes('Why?'), out);
});
