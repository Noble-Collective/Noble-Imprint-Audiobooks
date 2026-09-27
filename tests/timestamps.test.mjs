import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimestampsFromAlignments, buildNaturalGenerations } from '../src/generate.js';
import { preprocessSession } from '../src/preprocess-tts.js';

// A synthetic ElevenLabs alignment for `text`: every character takes 0.05 s, except the
// characters of an SSML break tag, which together take the break's duration (ElevenLabs
// reports the tag's characters in its alignment — that's why generate.js indexes charTimes
// by the TAGGED text).
function fakeAlignment(text) {
  const chars = [], starts = [], ends = [];
  let t = 0;
  const re = /<break time="([0-9.]+)s"\/>/g;
  let i = 0;
  for (const m of text.matchAll(re)) {
    for (; i < m.index; i++) { chars.push(text[i]); starts.push(t); ends.push(t += 0.05); }
    const per = parseFloat(m[1]) / m[0].length;
    for (; i < m.index + m[0].length; i++) { chars.push(text[i]); starts.push(t); ends.push(t += per); }
  }
  for (; i < text.length; i++) { chars.push(text[i]); starts.push(t); ends.push(t += 0.05); }
  return { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends, duration: t };
}

function build(markdown, opts) {
  const pre = preprocessSession(markdown, 'v');
  const gen = buildNaturalGenerations(pre.blocks);
  const aligns = gen.texts.map(fakeAlignment);
  const gaps = gen.gaps.map((g, i) => (i === 0 ? 0 : g));
  const r = buildTimestampsFromAlignments(aligns, gen.texts, aligns.map(a => a.duration), pre.sentences, gaps, opts);
  return { ...r, gen, aligns };
}

const GEN28 = '# Genesis 28\n\n## Jacob’s Departure\n\nSo Isaac called for Jacob and blessed him. He commanded him.\n';

test('a chapter title spoken differently ("Genesis, Chapter 28") is timed from its own audio, not guessed', () => {
  const { segments, gen, aligns } = build(GEN28);
  const spoken = 'Genesis, Chapter 28';
  assert.ok(gen.texts[0].startsWith(spoken), gen.texts[0]);
  const exactEnd = Math.round(aligns[0].character_end_times_seconds[spoken.length - 1] * 100) / 100;
  assert.equal(segments[0].text, 'Genesis 28');            // consumers still see the display text
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].end, exactEnd);
  assert.ok(segments[0].end <= segments[1].start, `title ${segments[0].end} overlaps heading ${segments[1].start}`);
  assert.equal(segments[1].text, 'Jacob’s Departure');
});

test('segments keep their shape: same count, text, blockIndex, sentenceIndex as the sentence index', () => {
  const pre = preprocessSession(GEN28, 'v');
  const { segments } = build(GEN28);
  assert.deepEqual(
    segments.map(s => [s.blockIndex, s.sentenceIndex, s.text]),
    pre.sentences.map(s => [s.blockIndex, s.sentenceIndex, s.text]),
  );
});

test('words: every word of a sentence with its own times, in order, covering the text', () => {
  const { segments, aligns } = build(GEN28, { words: true });
  const s = segments[2];
  assert.equal(s.text, 'So Isaac called for Jacob and blessed him.');
  assert.deepEqual(s.words.map(w => w[2]), s.text.split(' '));
  assert.equal(s.words[0][0], s.start);
  assert.equal(s.words.at(-1)[1], s.end);
  for (let i = 1; i < s.words.length; i++) assert.ok(s.words[i][0] >= s.words[i - 1][1] - 1e-9);
  // "Isaac" = the 2nd word; its start is the alignment time of its "I".
  const flat = aligns[0].characters.join('');
  const at = flat.indexOf('So Isaac') + 3;
  assert.equal(s.words[1][0], Math.round(aligns[0].character_start_times_seconds[at] * 100) / 100);
});

test('words: off by default (series files stay as they are); none on a heading read differently', () => {
  assert.equal(build(GEN28).segments[2].words, undefined);
  assert.equal(build(GEN28, { words: true }).segments[0].words, undefined);
});

test('words: a sentence spanning a generation boundary still gets exact word times', () => {
  const long = Array.from({ length: 140 }, (_, i) => `Verse number ${i} is here.`).join(' ');
  const md = `# Genesis 1\n\n## Title\n\n${long}\n`;
  const { segments, gen } = build(md, { words: true });
  assert.ok(gen.texts.length > 1, 'expected a cap split');
  for (const s of segments.slice(2)) {
    assert.deepEqual(s.words.map(w => w[2]), s.text.split(' '), s.text);
    assert.ok(s.words[0][0] >= s.start - 1e-9 && s.words.at(-1)[1] <= s.end + 1e-9);
  }
});

test('leftover markdown is removed from segment text (the audio is untouched)', () => {
  const cases = [
    ['>Disciples of Christ: >earnestly receive salvation.', 'Disciples of Christ: earnestly receive salvation.'],
    ['Publishing and Licensing ###', 'Publishing and Licensing'],
    ['- Goad, Keith.', 'Goad, Keith.'],
    ['Fondations - L’Appel du Christ : Un voyage.', 'Fondations - L’Appel du Christ : Un voyage.'], // real dash stays
    ['self-control and 3 - 4 things.', 'self-control and 3 - 4 things.'],
  ];
  for (const [raw, want] of cases) {
    const chunk = `${raw}`;
    const a = fakeAlignment(chunk);
    const { segments } = buildTimestampsFromAlignments([a], [chunk], [a.duration],
      [{ blockIndex: 0, sentenceIndex: 0, text: raw }], [0]);
    assert.equal(segments[0].text, want);
    assert.equal(segments[0].start, 0);                                 // still found (not guessed)
    assert.equal(segments[0].end, Math.round(a.duration * 100) / 100);
  }
});
