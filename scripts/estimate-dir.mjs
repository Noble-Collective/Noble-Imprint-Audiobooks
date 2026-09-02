import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { preprocessSession } from '../src/preprocess-tts.js';

const dir = process.argv[2];
const lang = process.argv[3] || 'en';
const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
const FACTOR = 0.587;
let chars = 0;
console.log('Session\tspokenChars');
for (const f of files) {
  const pre = preprocessSession(readFileSync(join(dir, f), 'utf-8'), 'compare', lang, false);
  chars += pre.plainText.length;
  console.log(`${f}\t${pre.plainText.length}`);
}
const credits = Math.round(chars * FACTOR);
console.log(`\nTotal spoken chars: ${chars.toLocaleString()}`);
console.log(`Est. credits (x0.587): ${credits.toLocaleString()}  ~$${(credits/10000*1.65).toFixed(2)}`);
