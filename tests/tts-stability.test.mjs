// Guard: timestamp-side changes must NEVER change what ElevenLabs is asked to say. A change
// in block text / plainText alters chunk hashes + contentHash, and the next generate run
// would pay to re-narrate those chunks. Golden = scripts/tts-golden.mjs over the whole
// library; skipped when the Resources checkout is at a different commit (content moved on —
// regenerate the golden deliberately, from a commit where the code is known-good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { computeGolden, resourcesHead, RESOURCES_PATH } from '../scripts/tts-golden.mjs';

const golden = JSON.parse(readFileSync(new URL('./fixtures/tts-golden.json', import.meta.url), 'utf-8'));
const head = existsSync(RESOURCES_PATH) ? resourcesHead() : null;

test('narrated text + sentence index unchanged for every session in the library', {
  skip: head !== golden.resourcesHead && `Resources at ${head}, golden at ${golden.resourcesHead}`,
}, () => {
  const now = computeGolden();
  assert.equal(Object.keys(now).length, Object.keys(golden.sessions).length);
  const diffs = Object.entries(golden.sessions)
    .filter(([k, v]) => JSON.stringify(now[k]) !== JSON.stringify(v))
    .map(([k]) => k);
  assert.deepEqual(diffs, []);
});
