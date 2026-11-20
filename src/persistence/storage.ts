/**
 * The narrow storage surface the repository needs. Keeping it this small makes
 * quota, corruption, and conflict behavior testable without a browser.
 */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Returns null when localStorage is unavailable (private mode, blocked storage). */
export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = window.localStorage;
    const probe = '__storyframe_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function isQuotaError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22
    );
  }
  if (error instanceof Error) {
    return /quota/i.test(error.name) || /quota/i.test(error.message);
  }
  return false;
}
