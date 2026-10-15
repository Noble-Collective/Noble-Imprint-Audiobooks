// Eleven v4 migration plumbing: per-book profiles + a model-aware chunk cache key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookAudiobookConfig } from '../src/audiobook-config.js';
import { chunkKey, hashChunk } from '../src/generate.js';

const AB = {
  enabled: true, voice_id: 'ALI', model_id: 'eleven_multilingual_v2', chunking_strategy: 'section',
  language_normalization: true,
  voice_settings: { stability: 0.5, similarity_boost: 0.5, style: 0, speed: 0.9 },
  profiles: { v4: { model_id: 'eleven_v4', spell_numbers: true, clean_terminal_punctuation: true,
    voice_settings: { stability: 0.5, similarity_boost: 0.5 } } },
  books: { MAT: { enabled: true, profile: 'v4' }, MRK: { enabled: true }, LUK: { enabled: true, chapters: '1-3' } },
};

test('a book without a profile gets the translation block unchanged', () => {
  const c = bookAudiobookConfig(AB, 'MRK');
  assert.equal(c.model_id, 'eleven_multilingual_v2');
  assert.deepEqual(c.voice_settings, AB.voice_settings);
  assert.equal(c.spell_numbers, undefined);
  assert.equal(c.books, undefined);
  assert.equal(c.chapters, undefined);
});

test('a book with the v4 profile: model, fixes and voice_settings replaced, rest inherited', () => {
  const c = bookAudiobookConfig(AB, 'MAT');
  assert.equal(c.model_id, 'eleven_v4');
  assert.equal(c.spell_numbers, true);
  assert.equal(c.clean_terminal_punctuation, true);
  assert.deepEqual(c.voice_settings, { stability: 0.5, similarity_boost: 0.5 });   // no speed/style
  assert.equal(c.voice_id, 'ALI');
  assert.equal(c.chunking_strategy, 'section');
  assert.equal(c.profile, 'v4');
});

test('an unknown profile is an error, not a silent v2 render', () => {
  assert.throws(() => bookAudiobookConfig({ ...AB, books: { MAT: { enabled: true, profile: 'v5' } } }, 'MAT'), /profile "v5"/);
});

test('chunk key: v2 keeps the text-only hash (shipped chunks reused), v4 never collides with it', () => {
  const text = 'Paul and Barnabas went on to Antioch.';
  const v2 = bookAudiobookConfig(AB, 'MRK');
  const v4 = bookAudiobookConfig(AB, 'MAT');
  assert.equal(chunkKey(v2, 'ALI'), '');
  assert.equal(hashChunk(text, chunkKey(v2, 'ALI')), hashChunk(text));
  assert.deepEqual([text].map(hashChunk), [hashChunk(text)]);   // .map passes an index — ignored
  assert.notEqual(hashChunk(text, chunkKey(v4, 'ALI')), hashChunk(text));
  assert.notEqual(chunkKey(v4, 'ALI'), chunkKey(v4, 'OTHER'));   // voice is part of it
  assert.notEqual(chunkKey(v4, 'ALI'), chunkKey({ ...v4, voice_settings: { stability: 0.3 } }, 'ALI'));
});
