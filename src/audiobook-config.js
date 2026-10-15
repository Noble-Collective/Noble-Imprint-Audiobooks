/**
 * audiobook-config.js — the effective audiobook config for one Bible book.
 *
 * A translation's meta.json has one `audiobook` block for all its books. During a model
 * migration (Eleven v4, 2026-10) books move over one at a time, so a book can name a
 * profile that overrides the block:
 *
 *   "audiobook": {
 *     "model_id": "eleven_multilingual_v2", "voice_settings": {…}, …,
 *     "profiles": { "v4": { "model_id": "eleven_v4", "spell_numbers": true, … } },
 *     "books": { "MAT": { "enabled": true, "profile": "v4" }, "MRK": { "enabled": true } }
 *   }
 *
 * Merge order: block → profile → the book entry's own keys. A profile's `voice_settings`
 * replaces the block's wholesale (v4 takes only stability + similarity_boost).
 */
const BOOK_ONLY_KEYS = new Set(['enabled', 'chapters', 'profile']);

export function bookAudiobookConfig(ab, code) {
  const books = ab.books || {};
  const entry = books[code] || books[code.toUpperCase()] || {};
  const profile = entry.profile ? (ab.profiles || {})[entry.profile] : null;
  if (entry.profile && !profile) throw new Error(`audiobook profile "${entry.profile}" (book ${code}) is not defined in meta.audiobook.profiles`);
  const own = Object.fromEntries(Object.entries(entry).filter(([k]) => !BOOK_ONLY_KEYS.has(k)));
  const { books: _b, profiles: _p, ...block } = ab;
  return { ...block, ...(profile || {}), ...own, ...(entry.profile ? { profile: entry.profile } : {}) };
}
