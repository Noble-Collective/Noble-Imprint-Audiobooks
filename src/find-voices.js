/**
 * find-voices.js — Search ElevenLabs for specific voices by name.
 * Run via: node src/find-voices.js
 * Requires ELEVENLABS_API_KEY environment variable.
 */

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) { console.error('Set ELEVENLABS_API_KEY'); process.exit(1); }

async function searchByName(name) {
  const url = `https://api.elevenlabs.io/v1/shared-voices?page_size=20&search=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { 'xi-api-key': API_KEY } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.voices || [];
}

async function getWorkspaceVoices() {
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': API_KEY } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.voices || [];
}

async function main() {
  const targets = ['Adam Stone', 'Eddie Sterling', 'Alistair', 'Ollie'];

  console.log('=== WORKSPACE VOICES (already added) ===');
  const workspace = await getWorkspaceVoices();
  for (const v of workspace) {
    const labels = v.labels || {};
    console.log(`  ${v.name} (${v.voice_id}) — ${labels.accent || '?'}, ${labels.gender || '?'}, ${v.category}`);
  }

  console.log('\n=== SEARCHING FOR TARGET VOICES ===');
  for (const name of targets) {
    console.log(`\nSearching: "${name}"`);
    const results = await searchByName(name);
    if (results.length === 0) {
      console.log('  No results found');
      continue;
    }
    for (const v of results.slice(0, 5)) {
      const labels = v.labels || {};
      console.log(`  ${v.name} (${v.voice_id})`);
      console.log(`    Accent: ${labels.accent || '?'}, Gender: ${labels.gender || '?'}, Age: ${labels.age || '?'}`);
      console.log(`    Use: ${labels.use_case || '?'}, Category: ${v.category || '?'}`);
      console.log(`    Desc: ${(v.description || '').substring(0, 100)}`);
    }
  }

  console.log('\n=== BUILT-IN BRITISH MALES ===');
  console.log('  Daniel (onwK4e9ZLuTAKqWW03F9) — British, middle-aged');
  console.log('  George (JBFqnCBsd6RMkjVDRZzb) — British, middle-aged');
}

main();
