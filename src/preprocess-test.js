/**
 * preprocess-test.js — Test the preprocessor against Oration II chapters.
 * Reads session files from the Resources repo and outputs the Studio JSON.
 *
 * Usage: node src/preprocess-test.js [path-to-resources-repo]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { preprocessSession, preprocessBook } from './preprocess-tts.js';

const resourcesPath = process.argv[2] || '../Noble-Imprint-Resources';
const bookPath = join(resourcesPath, 'series/A Library of Classics/A Pastoral Shelf/Oration II/sessions');
const outputDir = join(process.cwd(), 'test-output');

const VOICE_ID = 'test-voice-id';
const SKIP = ['01-FrontMatter.md', '08-Bibliography.md'];

try {
  mkdirSync(outputDir, { recursive: true });
} catch { /* exists */ }

// Read session files
const files = readdirSync(bookPath)
  .filter(f => f.endsWith('.md') && !SKIP.includes(f))
  .sort();

console.log(`Found ${files.length} session files to process:\n`);

let totalBlocks = 0;
let totalChars = 0;
const sessions = [];

for (const file of files) {
  const content = readFileSync(join(bookPath, file), 'utf-8');
  const chapter = preprocessSession(content, VOICE_ID);

  const charCount = chapter.plainText.length;
  const blockCount = chapter.blocks.length;
  totalBlocks += blockCount;
  totalChars += charCount;

  console.log(`  ${file}`);
  console.log(`    Chapter: "${chapter.name}"`);
  console.log(`    Blocks: ${blockCount}`);
  console.log(`    Characters: ${charCount.toLocaleString()}`);

  // Show block type distribution
  const typeCounts = {};
  for (const b of chapter.blocks) {
    typeCounts[b.sub_type] = (typeCounts[b.sub_type] || 0) + 1;
  }
  console.log(`    Types: ${Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // Write individual TTS JSON
  const outFile = file.replace('.md', '.tts.json');
  writeFileSync(join(outputDir, outFile), JSON.stringify(chapter, null, 2));
  console.log(`    Output: test-output/${outFile}`);
  console.log();

  sessions.push({ filename: file, content });
}

// Write full from_content_json
const { chapters, hashes } = await preprocessBook(sessions, VOICE_ID);
writeFileSync(
  join(outputDir, 'from_content_json.json'),
  JSON.stringify(chapters, null, 2)
);
writeFileSync(
  join(outputDir, 'content_hashes.json'),
  JSON.stringify(hashes, null, 2)
);

console.log('Summary:');
console.log(`  Sessions: ${files.length}`);
console.log(`  Total blocks: ${totalBlocks}`);
console.log(`  Total characters: ${totalChars.toLocaleString()}`);
console.log(`  from_content_json: test-output/from_content_json.json`);
console.log(`  Content hashes: test-output/content_hashes.json`);

// Show first few blocks of Chapter One for manual inspection
console.log('\n--- Sample output (Chapter One, first 5 blocks) ---\n');
const ch1 = chapters[0];
for (const block of ch1.blocks.slice(0, 5)) {
  const text = block.nodes[0].text;
  const preview = text.length > 120 ? text.slice(0, 120) + '...' : text;
  console.log(`  [${block.sub_type}] ${preview}`);
}
