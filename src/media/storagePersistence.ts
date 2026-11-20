/**
 * Ask the browser to treat this origin's storage as persistent.
 *
 * Chromium keeps IndexedDB best-effort by default, so a browser that reclaims
 * disk can drop stored images, audio and rendered videos while the project JSON
 * in localStorage survives. Persistent storage moves the origin out of that
 * eviction pool where the browser is willing to grant it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
