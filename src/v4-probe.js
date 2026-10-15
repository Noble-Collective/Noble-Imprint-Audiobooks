/**
 * v4-probe.js — answer the open questions about Eleven v4 before an A/B render
 * (docs/ELEVENLABS-MODELS.md §3 "Probe"). A handful of short /with-timestamps calls,
 * ~1,200 chars total. Writes every response (MP3 + alignment + status) to OUT_DIR and
 * prints a summary. Touches no audiobook, manifest or GCS path.
 *
 * Questions:
 *   - /v1/models: what the API itself says about eleven_v4 (limits, style/speed flags, cost)
 *   - is `alignment` returned, and do [short pause]/[long pause] tags appear in it?
 *   - is `speed`/`style` rejected (4xx) or silently ignored?
 *   - what does an SSML <break> do on v4 (ignored? spoken?)
 *   - are digits ("46,500") read correctly, and does alignment cover the digits or words?
 *   - are previous_text/next_text + previous_request_ids accepted?
 *   - is a float stability accepted?
 *   - credit delta per request (subscription character_count)
 *
 * Env: ELEVENLABS_API_KEY (required), OUT_DIR (default probe-out), VOICE_ID (default Ali)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API_BASE = 'https://api.elevenlabs.io/v1';
const API_KEY = process.env.ELEVENLABS_API_KEY;
const OUT_DIR = process.env.OUT_DIR || 'probe-out';
const VOICE_ID = process.env.VOICE_ID || 'MI88rOZjXbH22N8KHXUo'; // Ali — the BSB voice
const MODEL = process.env.MODEL_ID || 'eleven_v4';

if (!API_KEY) { console.error('ELEVENLABS_API_KEY not set'); process.exit(1); }
mkdirSync(OUT_DIR, { recursive: true });

const headers = { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function used() {
  const r = await fetch(`${API_BASE}/user/subscription`, { headers });
  if (!r.ok) return null;
  return (await r.json()).character_count ?? null;
}

const BASE_SETTINGS = { stability: 0.5, similarity_boost: 0.5 };

const DIGITS =
  'Numbers, Chapter 1. [long pause] Those registered to the tribe of Reuben numbered 46,500. ' +
  '[short pause] And all those counted totaled 603,550.';
const WORDS =
  'Those registered to the tribe of Reuben numbered forty-six thousand, five hundred. ' +
  'And all those counted totaled six hundred three thousand, five hundred fifty.';
const SSML =
  'Those registered to the tribe of Simeon numbered 59,300.<break time="1.5s"/>' +
  'From the sons of Gad, according to the records of their clans and families.';

const CASES = [
  { name: '1-v4-tags-digits', text: DIGITS, settings: BASE_SETTINGS },
  { name: '2-v4-speed-style', text: DIGITS, settings: { ...BASE_SETTINGS, speed: 0.9, style: 0 } },
  { name: '3-v4-ssml-break', text: SSML, settings: BASE_SETTINGS },
  { name: '4-v4-words', text: WORDS, settings: BASE_SETTINGS },
  { name: '5-v4-context-stitch', text: WORDS, settings: BASE_SETTINGS, context: true },
  { name: '6-v4-float-stability', text: WORDS, settings: { stability: 0.37, similarity_boost: 0.5 } },
];

async function main() {
  // 1. What the API says about the models (free).
  const mr = await fetch(`${API_BASE}/models`, { headers });
  const models = mr.ok ? await mr.json() : [];
  const wanted = models.filter(m => /v4|multilingual_v2/.test(m.model_id));
  writeFileSync(join(OUT_DIR, 'models.json'), JSON.stringify(wanted, null, 2));
  console.log('=== /v1/models (v4 + multilingual_v2) ===');
  for (const m of wanted) {
    const { model_id, name, can_use_style, can_use_speaker_boost, maximum_text_length_per_request,
      max_characters_request_free_user, max_characters_request_subscribed_user, model_rates,
      concurrency_group, serves_pro_voices } = m;
    console.log(JSON.stringify({ model_id, name, can_use_style, can_use_speaker_boost,
      maximum_text_length_per_request, max_characters_request_free_user,
      max_characters_request_subscribed_user, model_rates, concurrency_group, serves_pro_voices }));
  }

  // 2. The TTS cases.
  const results = [];
  let lastRequestId = null;
  for (const c of CASES) {
    const body = { text: c.text, model_id: MODEL, voice_settings: c.settings };
    if (c.context) {
      body.previous_text = 'From the sons of Reuben, the firstborn of Israel, according to the records of their clans and families,';
      body.next_text = 'From the sons of Simeon, according to the records of their clans and families,';
      if (lastRequestId) body.previous_request_ids = [lastRequestId];
    }
    const before = await used();
    const res = await fetch(`${API_BASE}/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`,
      { method: 'POST', headers, body: JSON.stringify(body) });
    const requestId = res.headers.get('request-id');
    const r = { name: c.name, status: res.status, chars: c.text.length, requestId,
      sent: Object.keys(body).filter(k => k !== 'text'), settings: c.settings };
    if (!res.ok) {
      r.error = (await res.text()).slice(0, 600);
    } else {
      const data = await res.json();
      writeFileSync(join(OUT_DIR, `${c.name}.mp3`), Buffer.from(data.audio_base64, 'base64'));
      writeFileSync(join(OUT_DIR, `${c.name}.json`), JSON.stringify({ text: c.text, body: { ...body, text: undefined },
        alignment: data.alignment, normalized_alignment: data.normalized_alignment }, null, 1));
      const al = data.alignment;
      const nal = data.normalized_alignment;
      r.hasAlignment = !!al;
      r.alignmentLenMatchesText = al ? al.characters.length === c.text.length : null;
      r.alignmentText = al ? al.characters.join('') : null;
      r.normalizedText = nal ? nal.characters.join('') : null;
      r.duration = al ? al.character_end_times_seconds.at(-1) : null;
      lastRequestId = requestId || lastRequestId;
    }
    await sleep(4000);  // let the usage counter settle
    const after = await used();
    r.creditDelta = before != null && after != null ? after - before : null;
    results.push(r);
    console.log(`\n=== ${c.name}: HTTP ${r.status}  chars=${r.chars}  credits=${r.creditDelta}  dur=${r.duration}`);
    if (r.error) console.log('  ERROR:', r.error);
    else {
      console.log('  alignment len == text len:', r.alignmentLenMatchesText);
      console.log('  alignment text :', JSON.stringify(r.alignmentText));
      if (r.normalizedText !== r.alignmentText) console.log('  normalized text:', JSON.stringify(r.normalizedText));
    }
  }
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
