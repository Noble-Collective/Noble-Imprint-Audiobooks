/**
 * accent.js — holding a voice's accent on Eleven v4 (plans/2026-10-26-accent-drift.md).
 *
 * v4 does not carry a voice's accent into another language, and decides per request: the Ali
 * voice (an Arabic-language library voice reading English) comes out North American in some
 * generations. An audio tag before the text ("[Saudi Arabic accent]") holds it: 1 drift in 43
 * tagged takes vs 9 in 15 untagged (experiments 1–2). The tag is not spoken.
 *
 * Only re-rendered or new generations carry the tag — every chunk already in storage stays as
 * it is — so a chapter can mix tagged and untagged chunks. The tag is part of the chunk text
 * (and so of its hash), which is how a later run finds the tagged take again:
 *   - generate.js: pickChunk() per chunk (stored tagged take > stored untagged > render tagged);
 *   - rebuild-timestamps.js: resolveChunkHashes() matches each chunk either way;
 *   - the timestamp builder skips the tag like pause markup (pauses.js PAUSE_MARKUP_RE).
 */
import { hashChunk } from './generate.js';

// The tag each voice needs on v4/v3. Keyed by voice, so it lives with the voice, not the book.
export const ACCENT_TAGS = {
  MI88rOZjXbH22N8KHXUo: '[Saudi Arabic accent]',   // Ali – calm & deep Arabic Saudi narrator
};

/** The tag for this book config + voice: meta.accent_tag (string, or false = none) wins. */
export function accentTagFor(meta, voiceId) {
  if (meta && meta.accent_tag === false) return '';
  if (meta && typeof meta.accent_tag === 'string') return meta.accent_tag;
  if (!/^eleven_v[34]/.test(meta?.model_id || '')) return '';   // v2 keeps the accent by itself
  return ACCENT_TAGS[voiceId] || '';
}

export function withAccentTag(text, tag) {
  return tag ? `${tag} ${text}` : text;
}

/**
 * What to do with one chunk. `existing` = the session's stored hash→file map; `redo` = stored
 * files to render again (a drifted take). Returns the text to narrate (tagged or not), its hash,
 * and `reuse` = the stored file to reuse, or null = render it.
 */
export function pickChunk({ text, key = '', tag = '', existing = {}, redo = new Set(), force = false }) {
  const tagged = withAccentTag(text, tag);
  const h0 = hashChunk(text, key);
  const h1 = tag ? hashChunk(tagged, key) : null;
  if (!force) {
    if (h1 && existing[h1] && !redo.has(existing[h1])) return { text: tagged, hash: h1, reuse: existing[h1] };
    if (existing[h0] && !redo.has(existing[h0])) return { text, hash: h0, reuse: existing[h0] };
  }
  return tag ? { text: tagged, hash: h1, reuse: null } : { text, hash: h0, reuse: null };
}

/**
 * The narrated chunk texts + hashes for a stored session whose manifest hashes are `want`:
 * each chunk is matched untagged or tagged. null when any chunk matches neither.
 */
export function resolveChunkHashes(chunks, key, want, tag) {
  const out = { chunks: [], hashes: [] };
  for (const c of chunks) {
    const h0 = hashChunk(c, key);
    if (want.has(h0)) { out.chunks.push(c); out.hashes.push(h0); continue; }
    const t = withAccentTag(c, tag);
    const h1 = tag ? hashChunk(t, key) : null;
    if (h1 && want.has(h1)) { out.chunks.push(t); out.hashes.push(h1); continue; }
    return null;
  }
  return out;
}
