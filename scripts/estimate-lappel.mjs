import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { preprocessSession } from '../src/preprocess-tts.js';

const dir = process.argv[2];
const VOICE = 'aQROLel5sQbj1vuIVi6B';
const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();

let withBreaks = 0, textOnly = 0;
console.log('Session\twithBreaks\ttextOnly');
for (const f of files) {
  const md = readFileSync(join(dir, f), 'utf-8');
  const pre = preprocessSession(md, VOICE, 'fr', false); // fr, language_normalization=false per meta
  const wb = pre.plainText.length;
  const to = pre.plainText.replace(/<break[^>]*>/g, '').length;
  withBreaks += wb; textOnly += to;
  console.log(`${f}\t${wb}\t${to}`);
}
const FACTOR = 0.587;
const usd = c => (c / 10000 * 1.65).toFixed(2);
console.log(`\nTotal plainText (with breaks): ${withBreaks.toLocaleString()}`);
console.log(`Total text-only (breaks stripped): ${textOnly.toLocaleString()}`);
console.log(`Break-tag chars: ${(withBreaks - textOnly).toLocaleString()} (${((withBreaks-textOnly)/withBreaks*100).toFixed(1)}% of plainText)`);
console.log(`\nEstimate @ 0.587x plainText:  ${Math.round(withBreaks*FACTOR).toLocaleString()} credits  ~$${usd(withBreaks*FACTOR)}`);
console.log(`Estimate @ 0.587x text-only:  ${Math.round(textOnly*FACTOR).toLocaleString()} credits  ~$${usd(textOnly*FACTOR)}`);
