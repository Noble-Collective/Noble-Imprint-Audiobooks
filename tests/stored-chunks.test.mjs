// A run that fails after rendering (Come, Let Us Adore Him run 45628944512 failed at Part Two's
// timestamps) never writes the manifest, and reuse came only from the manifest — so the re-run
// paid for all 1,129 chunks again (~197K credits). Chunks are stored under their content hash
// (text + model + voice + settings), so a stored file with the right hash IS that chunk: reuse it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reuseStoredChunks } from '../src/accent.js';

const exists = stored => async hash => stored.has(hash);

test('a chunk not in the manifest but stored under its hash is reused', async () => {
  const picks = [{ hash: 'a', reuse: 'a' }, { hash: 'b', reuse: null }, { hash: 'c', reuse: null }];
  const n = await reuseStoredChunks(picks, exists(new Set(['b'])));
  assert.equal(n, 1);
  assert.deepEqual(picks.map(p => p.reuse), ['a', 'b', null]);
});

test('never on a forced run or an accent re-render (those must render again)', async () => {
  for (const opts of [{ force: true }, { redo: true }]) {
    const picks = [{ hash: 'b', reuse: null }];
    assert.equal(await reuseStoredChunks(picks, exists(new Set(['b'])), opts), 0);
    assert.equal(picks[0].reuse, null);
  }
});

test('a storage error means render, not fail', async () => {
  const picks = [{ hash: 'b', reuse: null }];
  assert.equal(await reuseStoredChunks(picks, async () => { throw new Error('503'); }), 0);
  assert.equal(picks[0].reuse, null);
});
