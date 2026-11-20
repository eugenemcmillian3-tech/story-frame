import type { KeyValueStorage } from '../src/persistence/storage';
import type { LockRunner } from '../src/persistence/saveLock';

/**
 * Serializes tasks in call order, like the browser's Web Locks queue. Two
 * saves started at the same moment both reach it; only the queued first one
 * runs before the second has checked the revision.
 */
/** A lock that is only granted once `gate` resolves, recording the lock names asked for. */
export function gatedLock(gate: Promise<void>, names: string[]): LockRunner {
  return <T>(name: string, task: () => T | Promise<T>): Promise<T> => {
    names.push(name);
    return gate.then(() => task()) as Promise<T>;
  };
}

export function queueLock(): LockRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(_name: string, task: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(() => task());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  };
}

/** In-memory storage double with optional quota and hard-write failures. */
export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();
  quotaBytes: number | null = null;
  failWrites = false;

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
    if (this.quotaBytes !== null) {
      let total = key.length + value.length;
      for (const [existingKey, existingValue] of this.map) {
        if (existingKey === key) continue;
        total += existingKey.length + existingValue.length;
      }
      if (total > this.quotaBytes) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
    }
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  raw(key: string): string | null {
    return this.getItem(key);
  }

  seed(key: string, value: string): void {
    this.map.set(key, value);
  }
}
