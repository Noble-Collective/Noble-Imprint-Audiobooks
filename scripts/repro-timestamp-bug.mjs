import { readFileSync } from 'node:fs';
import { preprocessSession } from '../src/preprocess-tts.js';
import { splitLongBlocks, chunkText } from '../src/generate.js';

const TARGET_CHUNK_SIZE = 800, CHUNK_SIZE = 4500;
const file = process.argv[2];
const md = readFileSync(file, 'utf-8');
const pre = preprocessSession(md, 'compare', 'en', false);

// Replicate generate.js LINEAR chunk assembly.
const splitBlocks = splitLongBlocks(pre.blocks, TARGET_CHUNK_SIZE);
const chunks = chunkText(pre.plainText, CHUNK_SIZE, splitBlocks);
// (seam breaks are stripped by the matcher, so skip prepending them here)

const flatText = chunks.join('');
const flatCleanLower = flatText.replace(/<break[^>]*\/>/g, '').toLowerCase();
const flatNoWs = flatCleanLower.replace(/\s+/g, '');

let fails = 0, wsFixable = 0, other = 0;
for (const sent of pre.sentences) {
  const needle = sent.text.toLowerCase().replace(/<break[^>]*\/>/g, '');
  if (flatCleanLower.includes(needle)) continue;
  fails++;
  const needleNoWs = needle.replace(/\s+/g, '');
  const wsOk = flatNoWs.includes(needleNoWs);
  if (wsOk) wsFixable++; else other++;
  console.log(`\n[FAIL${wsOk ? ' — whitespace-only' : ' — OTHER'}] "${sent.text.slice(0, 70)}..."`);
  if (!wsOk) {
    // show where it diverges
    const at = flatNoWs.indexOf(needleNoWs.slice(0, 20));
    console.log('   needleNoWs head:', JSON.stringify(needleNoWs.slice(0, 40)));
    console.log('   haystack near  :', JSON.stringify(flatNoWs.slice(Math.max(0, at), at + 40)));
  }
}
console.log(`\n=== ${fails} sentence(s) fail exact match | ${wsFixable} whitespace-only (fix works) | ${other} other ===`);
