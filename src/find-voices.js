/**
 * find-voices.js — Search ElevenLabs for British male narrator voices.
 * Run via: node src/find-voices.js
 * Requires ELEVENLABS_API_KEY environment variable.
 */

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) { console.error('Set ELEVENLABS_API_KEY'); process.exit(1); }

async function search(query) {
  const url = `https://api.elevenlabs.io/v1/shared-voices?page_size=50&gender=male&language=en&search=${encodeURIComponent(query)}&sort=usage_character_count_7d`;
  const res = await fetch(url, { headers: { 'xi-api-key': API_KEY } });
  if (!res.ok) { console.error(`Search failed: ${res.status}`); return []; }
  const data = await res.json();
  return data.voices || [];
}

async function main() {
  // Search with different queries to cast a wide net
  const queries = ['british narrator', 'british audiobook', 'british male storyteller', 'english narrator deep'];
  const seen = new Set();
  const results = [];

  for (const q of queries) {
    const voices = await search(q);
    for (const v of voices) {
      if (seen.has(v.voice_id)) continue;
      seen.add(v.voice_id);
      const labels = v.labels || {};
      // Filter: must be male and have british/english accent indicators
      const isBritish = (labels.accent || '').toLowerCase().includes('british') ||
                        (labels.accent || '').toLowerCase().includes('english') ||
                        (v.description || '').toLowerCase().includes('british') ||
                        (v.name || '').toLowerCase().includes('british');
      const isMale = (labels.gender || '').toLowerCase() === 'male';
      if (isBritish && isMale) {
        results.push({
          name: v.name,
          voice_id: v.voice_id,
          accent: labels.accent || 'unknown',
          age: labels.age || 'unknown',
          use_case: labels.use_case || 'unknown',
          description: (v.description || '').substring(0, 120),
          usage_7d: v.usage_character_count_7d || 0,
          category: v.category || 'community',
        });
      }
    }
  }

  // Sort by usage (most popular first)
  results.sort((a, b) => b.usage_7d - a.usage_7d);

  // Also include the 2 built-in British males
  console.log('=== BUILT-IN BRITISH MALES ===');
  console.log('1. Daniel (onwK4e9ZLuTAKqWW03F9) — British, middle-aged, steady broadcaster');
  console.log('2. George (JBFqnCBsd6RMkjVDRZzb) — British, middle-aged, warm storyteller');
  console.log('');
  console.log(`=== TOP COMMUNITY BRITISH MALES (${results.length} found) ===`);
  for (const [i, v] of results.slice(0, 15).entries()) {
    console.log(`${i + 3}. ${v.name} (${v.voice_id})`);
    console.log(`   Accent: ${v.accent}, Age: ${v.age}, Use: ${v.use_case}`);
    console.log(`   Usage (7d): ${v.usage_7d.toLocaleString()} chars`);
    console.log(`   ${v.description}`);
    console.log('');
  }
}

main();
