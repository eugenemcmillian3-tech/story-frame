/**
 * Exact-content fingerprint (FNV-1a over UTF-16 code units) plus the input length.
 *
 * Used for storyboard review tracking: the review stores the fingerprint of the
 * narration it was reviewed against, so any content change — including a single
 * keystroke inside a typing burst — no longer matches. No debounce, no counters.
 */
export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}:${text.length}`;
}

export function computeScriptFingerprint(narration: string): string {
  return fingerprintText(narration);
}
