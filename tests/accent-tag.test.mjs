// Accent tag for the Ali voice on Eleven v4 (plans/2026-10-26-accent-drift.md).
// v4 sometimes drops Ali's accent for a whole generation; "[Saudi Arabic accent]" before the
// text holds it (1 drift in 43 tagged takes vs 9 in 15 untagged). Only re-rendered sections
// carry the tag, so every chapter mixes tagged and untagged chunks — these tests pin how the
// tag is chosen, cached, re-rendered, skipped by the timestamps, and found again by the
// timestamps-only rebuild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPauses, pauseMarkupLengthAt } from '../src/pauses.js';
import { accentTagFor, withAccentTag, pickChunk, resolveChunkHashes } from '../src/accent.js';
import { buildTimestampsFromAlignments, buildNaturalGenerations, hashChunk } from '../src/generate.js';
import { preprocessSession } from '../src/preprocess-tts.js';

const TAG = '[Saudi Arabic accent]';
const ALI = 'MI88rOZjXbH22N8KHXUo';
const V4 = { model_id: 'eleven_v4', voice_settings: { stability: 0.5, similarity_boost: 0.5 } };

test('the accent tag is markup, not words: stripped like a pause tag, with its trailing space', () => {
  assert.equal(stripPauses(`${TAG} Genesis, Chapter 1`), 'Genesis, Chapter 1');
  assert.equal(pauseMarkupLengthAt(`${TAG} Genesis`, 0), TAG.length + 1);
  // Only a bracketed "… accent" tag — ordinary bracketed words stay.
  assert.equal(stripPauses('[the accent fell] x'), '[the accent fell] x');
});

test('which tag: Ali on v4 gets the Saudi tag; v2, other voices and an explicit false get none', () => {
  assert.equal(accentTagFor(V4, ALI), TAG);
  assert.equal(accentTagFor({ ...V4, model_id: 'eleven_multilingual_v2' }, ALI), '');
  assert.equal(accentTagFor({}, ALI), '');
  assert.equal(accentTagFor(V4, 'someOtherVoice'), '');
  assert.equal(accentTagFor({ ...V4, accent_tag: false }, ALI), '');
  assert.equal(accentTagFor({ ...V4, accent_tag: '[British accent]' }, 'someOtherVoice'), '[British accent]');
  assert.equal(withAccentTag('Hello.', TAG), `${TAG} Hello.`);
  assert.equal(withAccentTag('Hello.', ''), 'Hello.');
});

test('pickChunk: an untagged chunk already in storage is reused as is (no re-render, no credits)', () => {
  const key = 'k\n', text = 'In the beginning.';
  const h0 = hashChunk(text, key);
  const p = pickChunk({ text, key, tag: TAG, existing: { [h0]: h0 } });
  assert.deepEqual(p, { text, hash: h0, reuse: h0 });
});

test('pickChunk: a tagged take already in storage is preferred over the untagged one', () => {
  const key = 'k\n', text = 'In the beginning.';
  const h0 = hashChunk(text, key), h1 = hashChunk(withAccentTag(text, TAG), key);
  const p = pickChunk({ text, key, tag: TAG, existing: { [h0]: h0, [h1]: h1 } });
  assert.deepEqual(p, { text: withAccentTag(text, TAG), hash: h1, reuse: h1 });
});

test('pickChunk: a chunk on the re-render list is generated again, with the tag', () => {
  const key = 'k\n', text = 'In the beginning.';
  const h0 = hashChunk(text, key), h1 = hashChunk(withAccentTag(text, TAG), key);
  const p = pickChunk({ text, key, tag: TAG, existing: { [h0]: h0 }, redo: new Set([h0]) });
  assert.deepEqual(p, { text: withAccentTag(text, TAG), hash: h1, reuse: null });
  // A tagged take that still drifted can be listed too — it is rendered again under the same name.
  const again = pickChunk({ text, key, tag: TAG, existing: { [h1]: h1 }, redo: new Set([h1]) });
  assert.deepEqual(again, { text: withAccentTag(text, TAG), hash: h1, reuse: null });
});

test('pickChunk: a new chunk (nothing stored) gets the tag; with no tag it is unchanged', () => {
  const key = 'k\n', text = 'In the beginning.';
  assert.deepEqual(pickChunk({ text, key, tag: TAG, existing: {} }),
    { text: withAccentTag(text, TAG), hash: hashChunk(withAccentTag(text, TAG), key), reuse: null });
  assert.deepEqual(pickChunk({ text, key, tag: '', existing: {} }),
    { text, hash: hashChunk(text, key), reuse: null });
  // force (re-render everything) ignores storage.
  const h0 = hashChunk(text, key);
  assert.equal(pickChunk({ text, key, tag: '', existing: { [h0]: h0 }, force: true }).reuse, null);
});

test('resolveChunkHashes: the timestamps-only rebuild finds a chapter that mixes tagged and untagged chunks', () => {
  const key = 'k\n', chunks = ['One.', 'Two.', 'Three.'];
  const want = new Set([hashChunk(chunks[0], key), hashChunk(withAccentTag(chunks[1], TAG), key), hashChunk(chunks[2], key)]);
  const r = resolveChunkHashes(chunks, key, want, TAG);
  assert.deepEqual(r.chunks, ['One.', withAccentTag('Two.', TAG), 'Three.']);
  assert.deepEqual(new Set(r.hashes), want);
  assert.equal(resolveChunkHashes(chunks, key, new Set(['nope']), TAG), null);
  // No tag known: plain chunks only (every shipped chapter before this change).
  const plain = new Set(chunks.map(c => hashChunk(c, key)));
  assert.deepEqual(resolveChunkHashes(chunks, key, plain, '').chunks, chunks);
});

test('re-render list: files per chapter for generate.js, chapters per book for detect-changes.js', async () => {
  const { parseRedo, isAmerican } = await import('../src/accent-redo.js');
  const r = parseRedo({ chunks: [
    { book: 'bible/bsb/colossians', session: '003.md', code: 'COL', chapter: 3, chunk: 1, file: 'aaa' },
    { book: 'bible/bsb/colossians', session: '003.md', code: 'COL', chapter: 3, chunk: 2, file: 'bbb' },
    { book: 'bible/bsb/psalms', session: '024.md', code: 'PSA', chapter: 24, chunk: 1, file: 'ccc' },
  ] });
  assert.equal(r.count, 3);
  assert.deepEqual([...r.forSession('bible/bsb/colossians', '003.md')], ['aaa', 'bbb']);
  assert.equal(r.forSession('bible/bsb/colossians', '001.md').size, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(r.chaptersByCode()).map(([k, v]) => [k, [...v]])), { COL: [3], PSA: [24] });
  assert.throws(() => parseRedo({ chunks: [{ book: 'x' }] }));
  // The drift check's rule = the experiments': ≥ 25% of pieces labelled US/Canada.
  assert.equal(isAmerican({ americanShare: 0.25 }), true);
  assert.equal(isAmerican({ americanShare: 0.2, lowShare: 0.9 }), false);
});

// Synthetic alignment: every character 0.05 s; the tag's characters are reported too (as for
// [long pause]), so the builder must index by the tagged text and skip the tag when matching.
function fakeAlignment(text) {
  const starts = [], ends = [];
  let t = 0;
  for (let i = 0; i < text.length; i++) { starts.push(t); ends.push(t += 0.05); }
  return { characters: [...text], character_start_times_seconds: starts, character_end_times_seconds: ends, duration: t };
}

test('timestamps: a tagged chunk is timed from its audio, every sentence matched exactly, words included', () => {
  const md = '# Colossians 3\n\n## Put On the New Self\n\nTherefore, since you have been raised with Christ, strive for the things above. Set your minds on things above.\n\n## Christian Households\n\nWives, submit to your husbands, as is fitting in the Lord.\n';
  const pre = preprocessSession(md, ALI, 'en', false, { pauseStyle: 'tags' });
  const gen = buildNaturalGenerations(pre.blocks, 2000, 'tags');
  assert.ok(gen.texts.length >= 2, 'two sections → two generations');
  // Second generation re-rendered with the tag; first left as it was.
  const texts = gen.texts.map((t, i) => (i === 1 ? withAccentTag(t, TAG) : t));
  const aligns = texts.map(fakeAlignment);
  const gaps = gen.gaps.map((g, i) => (i === 0 ? 0 : g));
  const stats = { matched: 0, estimated: 0 };
  const r = buildTimestampsFromAlignments(aligns, texts, aligns.map(a => a.duration), pre.sentences, gaps, { words: true, stats });
  assert.equal(stats.estimated, 0, 'no sentence fell back to an estimate');
  const wives = r.segments.find(s => s.text.startsWith('Wives'));
  assert.ok(wives.words && wives.words.length > 0, 'word times kept');
  // "Wives" starts after the first chunk, the gap, and the tag's own characters.
  const tagChars = TAG.length + 1;
  const firstCharOfSection = texts[1].indexOf('Christian');
  assert.ok(firstCharOfSection > tagChars - 1);
  const chunk1Start = aligns[0].duration + gaps[1];
  const headingSeg = r.segments.find(s => s.text === 'Christian Households');
  assert.equal(headingSeg.start, Math.round((chunk1Start + firstCharOfSection * 0.05) * 100) / 100);
  assert.equal(wives.words[0][2], 'Wives,');
});
