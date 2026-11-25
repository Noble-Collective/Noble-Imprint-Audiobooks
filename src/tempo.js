/**
 * tempo.js — a book's pace on Eleven v4/v3, which have no speed setting.
 *
 * On v2 `voice_settings.speed` goes to the API. On v4 it is held back from the request and
 * applied after rendering instead: the finished chapter MP3 is slowed with ffmpeg atempo
 * (pitch-preserving, 0 credits) and its timestamps are stretched by 1/tempo to match.
 * The "B3" sample for Come, Let Us Adore Him (2026-11-25, /voice-test/advent-day-1-ab) was
 * made exactly this way: v4 at its own pace, then atempo 0.92 — the series books' speed.
 */
const isV34 = modelId => /^eleven_v[34]/.test(modelId || '');

/** The post-render tempo for this model + settings (1 = none). */
export function narrationTempo(modelId, voiceSettings) {
  if (!isV34(modelId)) return 1;
  const s = voiceSettings && voiceSettings.speed;
  return typeof s === 'number' && s > 0 && s !== 1 ? s : 1;
}

/** The voice_settings to send: v4/v3 without `speed` (applied after rendering instead). */
export function apiVoiceSettings(modelId, voiceSettings) {
  if (!voiceSettings || !isV34(modelId) || !('speed' in voiceSettings)) return voiceSettings;
  const { speed: _speed, ...rest } = voiceSettings;
  return rest;
}

const round2 = t => Math.round(t * 100) / 100;

/** Timestamps for audio slowed by `tempo` (every time × 1/tempo). Same object when tempo = 1. */
export function scaleTimestamps(timestamps, tempo) {
  if (!tempo || tempo === 1) return timestamps;
  const k = t => round2(t / tempo);
  return {
    ...timestamps,
    segments: timestamps.segments.map(s => ({
      ...s,
      start: k(s.start),
      end: k(s.end),
      ...(s.words ? { words: s.words.map(([a, b, w]) => [k(a), k(b), w]) } : {}),
    })),
  };
}
