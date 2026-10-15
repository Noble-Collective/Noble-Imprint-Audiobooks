// Opt-in narration options (meta.audiobook.spell_numbers / clean_terminal_punctuation /
// pause style). All default OFF — tests/tts-stability.test.mjs guards that the deployed
// narration is unchanged; these cover what each option does when switched on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberToWords, spellNumbers } from '../src/languages.js';
import { preprocessSession, narrationOptions } from '../src/preprocess-tts.js';
import { buildNaturalGenerations, buildTimestampsFromAlignments } from '../src/generate.js';
import { pause, pauseStyleForModel, stripPauses } from '../src/pauses.js';

test('numbers read as words, American style, a comma after each scale word', () => {
  assert.equal(numberToWords(46500), 'forty-six thousand, five hundred');
  assert.equal(numberToWords(603550), 'six hundred three thousand, five hundred fifty');
  assert.equal(numberToWords(1775), 'one thousand, seven hundred seventy-five');
  assert.equal(numberToWords(600000), 'six hundred thousand');
  assert.equal(numberToWords(930), 'nine hundred thirty');
  assert.equal(numberToWords(21), 'twenty-one');
});

test('spellNumbers leaves references, decimals and ordinals alone', () => {
  assert.equal(spellNumbers('those registered numbered 46,500.'), 'those registered numbered forty-six thousand, five hundred.');
  assert.equal(spellNumbers('300 cubits long, 50 cubits wide'), 'three hundred cubits long, fifty cubits wide');
  assert.equal(spellNumbers('2 Timothy 1:15'), '2 Timothy 1:15');
  assert.equal(spellNumbers('1.5 talents'), '1.5 talents');
  assert.equal(spellNumbers('the 3rd day'), 'the 3rd day');
});

const NUM = '# Numbers 1\n\n## The Number of Every Tribe\n\n' +
  '<sup>21</sup>those registered to the tribe of Reuben numbered 46,500.\n\n' +
  'From the tribe of Reuben, Elizur son of Shedeur;\n\n' +
  '<sup>15</sup>and from Naphtali, Ahira son of Enan.”\n';

test('options off: digits spoken as-is, stray periods as before (deployed behavior)', () => {
  const pre = preprocessSession(NUM, 'v', 'en', true);
  assert.match(pre.plainText, /numbered 46,500\./);
  assert.match(pre.plainText, /Shedeur;\./);
  assert.match(pre.plainText, /Enan\.”\./);
});

test('spell_numbers: narrator says words, highlight text keeps the digits', () => {
  const pre = preprocessSession(NUM, 'v', 'en', true, narrationOptions({ spell_numbers: true }));
  assert.match(pre.plainText, /numbered forty-six thousand, five hundred\./);
  const s = pre.sentences.find(x => /Reuben numbered/.test(x.text));
  assert.equal(s.text, 'those registered to the tribe of Reuben numbered 46,500.');
  assert.equal(s.matchText, 'those registered to the tribe of Reuben numbered forty-six thousand, five hundred.');
});

test('clean_terminal_punctuation: no period after ; , or a closing quote', () => {
  const pre = preprocessSession(NUM, 'v', 'en', true, narrationOptions({ clean_terminal_punctuation: true }));
  assert.match(pre.plainText, /Shedeur;(\n|$)/);
  assert.match(pre.plainText, /Enan\.”(\n|$)/);
});

test('pause kinds: v2 gets <break> with the shipped durations, v4 gets [long pause]/[short pause]', () => {
  assert.equal(pauseStyleForModel('eleven_multilingual_v2'), 'ssml');
  assert.equal(pauseStyleForModel('eleven_v4'), 'tags');
  assert.equal(pause('title'), '<break time="2s"/>');
  assert.equal(pause('section'), '<break time="1.5s"/>');
  assert.equal(pause('subsection'), '<break time="1s"/>');
  assert.equal(pause('title', 'tags'), '[long pause]');
  assert.equal(pause('subsection', 'tags'), '[short pause]');
  const tags = preprocessSession(NUM, 'v', 'en', true, narrationOptions({ model_id: 'eleven_v4' }));
  assert.ok(!/<break/.test(tags.plainText), tags.plainText);
  const gen = buildNaturalGenerations(tags.blocks, 2000, 'tags');
  assert.match(gen.texts[0], /^Numbers, Chapter 1\.\[long pause\]/);
  assert.ok(!/<break/.test(gen.texts.join('')));
});

// Synthetic alignment, tag characters included (as ElevenLabs v2 AND v4 both return them).
function fakeAlignment(text) {
  const chars = [], starts = [], ends = [];
  let t = 0;
  for (const c of text) { chars.push(c); starts.push(t); ends.push(t += 0.05); }
  return { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends, duration: t };
}

test('v4 tags + spelled numbers: every sentence matched in order, display text kept, no markup leaks', () => {
  const opts = narrationOptions({ model_id: 'eleven_v4', spell_numbers: true, clean_terminal_punctuation: true });
  const pre = preprocessSession(NUM, 'v', 'en', true, opts);
  const gen = buildNaturalGenerations(pre.blocks, 2000, opts.pauseStyle);
  const aligns = gen.texts.map(fakeAlignment);
  const stats = { matched: 0, estimated: 0 };
  const { segments } = buildTimestampsFromAlignments(aligns, gen.texts, aligns.map(a => a.duration),
    pre.sentences, gen.gaps.map((g, i) => (i ? g : 0)), { stats });
  assert.equal(stats.estimated, 0);
  assert.equal(stats.matched, pre.sentences.length);
  assert.ok(segments.some(s => s.text.endsWith('numbered 46,500.')));
  for (let i = 1; i < segments.length; i++) assert.ok(segments[i].start >= segments[i - 1].start);
  for (const s of segments) assert.equal(stripPauses(s.text), s.text);
});
