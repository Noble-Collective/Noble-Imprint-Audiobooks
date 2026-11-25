// v4 has no speed setting: a book's voice_settings.speed is applied after rendering
// (ffmpeg atempo, pitch-preserving) and the timestamps are stretched to match.
// Series books on v4 also carry Ollie's reading direction tag (the "B3" sample, 2026-11-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrationTempo, apiVoiceSettings, scaleTimestamps } from '../src/tempo.js';
import { accentTagFor } from '../src/accent.js';

const OLLIE = 'jRAAK67SEFE9m7ci5DhD';

test('v4 takes speed as a post-render tempo; v2 sends it to the API', () => {
  assert.equal(narrationTempo('eleven_v4', { stability: 0.5, speed: 0.92 }), 0.92);
  assert.equal(narrationTempo('eleven_v4', { stability: 0.5 }), 1);
  assert.equal(narrationTempo('eleven_multilingual_v2', { speed: 0.92 }), 1);
  assert.equal(narrationTempo(undefined, { speed: 0.92 }), 1);
});

test('speed is not sent to v4 (the request matches the B3 sample)', () => {
  assert.deepEqual(apiVoiceSettings('eleven_v4', { stability: 0.5, similarity_boost: 0.5, speed: 0.92 }),
    { stability: 0.5, similarity_boost: 0.5 });
  const v2 = { stability: 0.71, similarity_boost: 0.5, style: 0, speed: 0.92 };
  assert.deepEqual(apiVoiceSettings('eleven_multilingual_v2', v2), v2);
  assert.equal(apiVoiceSettings('eleven_v4', undefined), undefined);
});

test('timestamps stretch by 1/tempo, words too', () => {
  const ts = { segments: [{ blockIndex: 0, start: 0.92, end: 1.84, text: 'a', words: [[0.92, 1.38, 'a']] }] };
  assert.deepEqual(scaleTimestamps(ts, 0.92), {
    segments: [{ blockIndex: 0, start: 1, end: 2, text: 'a', words: [[1, 1.5, 'a']] }],
  });
  assert.equal(scaleTimestamps(ts, 1), ts);
});

test('Ollie on v4 reads with the calm direction tag; on v2 no tag', () => {
  assert.equal(accentTagFor({ model_id: 'eleven_v4' }, OLLIE), '[calm, reverent narration]');
  assert.equal(accentTagFor({ model_id: 'eleven_multilingual_v2' }, OLLIE), '');
});
