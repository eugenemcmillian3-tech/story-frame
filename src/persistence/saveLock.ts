/**
 * Runs `task` while holding an exclusive lock named `name`.
 *
 * A project save is a read-check-write sequence. Without a lock shared by every
 * tab of this origin, two tabs can both read revision N, both pass the check,
 * and both write N + 1, silently losing one of the saves.
 */
export type LockRunner = <T>(name: string, task: () => T | Promise<T>) => Promise<T>;

const immediate: LockRunner = (_name, task) => Promise.resolve().then(task);

/**
 * Web Locks are shared by all tabs of the same origin, so holding one makes the
 * repository's revision check and write a single atomic step between tabs.
 *
 * Browsers without the Web Locks API fall back to the optimistic check alone:
 * a save that is already newer is still never overwritten, but two saves that
 * start at the same moment are not serialized.
 */
export function crossTabLock(): LockRunner {
  const manager = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!manager || typeof manager.request !== 'function') return immediate;
  return <T>(name: string, task: () => T | Promise<T>): Promise<T> =>
    manager.request(name, () => task()) as Promise<T>;
}
