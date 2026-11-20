import { nowIso } from '../domain/project';
import { SCHEMA_VERSION } from '../domain/types';
import type { Project } from '../domain/types';
import { parseStoredProject } from '../domain/validation';
import { crossTabLock } from './saveLock';
import type { LockRunner } from './saveLock';
import { isQuotaError } from './storage';
import type { KeyValueStorage } from './storage';

export const PROJECT_KEY_PREFIX = 'storyframe.v1.project.';

export function projectKey(id: string): string {
  return `${PROJECT_KEY_PREFIX}${id}`;
}

/** Lock name shared by every tab that saves this project. */
export function projectLockName(id: string): string {
  return `storyframe.v1.lock.project.${id}`;
}

export function projectIdFromKey(key: string): string | null {
  return key.startsWith(PROJECT_KEY_PREFIX) ? key.slice(PROJECT_KEY_PREFIX.length) : null;
}

export type ReadFailureReason =
  | 'missing'
  | 'invalid-json'
  | 'invalid-shape'
  | 'unsupported-schema'
  | 'storage-unavailable';

export type ReadResult =
  | { ok: true; project: Project }
  | { ok: false; reason: ReadFailureReason; message: string };

export type SaveFailureReason =
  | 'conflict'
  | 'deleted-externally'
  | 'invalid-stored'
  | 'quota'
  | 'storage-unavailable';

export type SaveResult =
  | { ok: true; project: Project }
  | { ok: false; reason: SaveFailureReason; message: string };

function readFailureReason(errors: string[]): ReadFailureReason {
  const joined = errors.join(' ');
  if (/not valid JSON/i.test(joined)) return 'invalid-json';
  if (/schema version/i.test(joined)) return 'unsupported-schema';
  return 'invalid-shape';
}

/**
 * Browser-local persistence. One storage key per project; no shared index, so a
 * project listing cannot disagree with the projects themselves.
 *
 * Writes are optimistic: the caller passes the revision it loaded, and a write
 * only succeeds when the stored revision still matches. A mismatch is reported
 * as a conflict and the stored copy is left untouched.
 */
export class ProjectRepository {
  private readonly storage: KeyValueStorage | null;
  private readonly now: () => string;
  private readonly lock: LockRunner;

  constructor(
    storage: KeyValueStorage | null,
    now: () => string = nowIso,
    lock: LockRunner = crossTabLock(),
  ) {
    this.storage = storage;
    this.now = now;
    this.lock = lock;
  }

  get available(): boolean {
    return this.storage !== null;
  }

  listIds(): string[] {
    if (!this.storage) return [];
    const ids: string[] = [];
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (!key) continue;
        const id = projectIdFromKey(key);
        if (id) ids.push(id);
      }
    } catch {
      return [];
    }
    return ids;
  }

  read(id: string): ReadResult {
    if (!this.storage) {
      return {
        ok: false,
        reason: 'storage-unavailable',
        message: 'Browser storage is not available, so saved projects cannot be read.',
      };
    }
    let raw: string | null;
    try {
      raw = this.storage.getItem(projectKey(id));
    } catch {
      return {
        ok: false,
        reason: 'storage-unavailable',
        message: 'This browser blocked access to saved project data.',
      };
    }
    if (raw === null) {
      return { ok: false, reason: 'missing', message: 'This project is not saved in this browser.' };
    }
    const parsed = parseStoredProject(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: readFailureReason(parsed.errors),
        message: parsed.errors[0] ?? 'Saved project data could not be read.',
      };
    }
    return { ok: true, project: parsed.value };
  }

  create(project: Project): SaveResult {
    return this.write(project, 0);
  }

  /** Best-effort save for paths that cannot await a lock (page unload). */
  save(project: Project, expectedRevision: number): SaveResult {
    return this.write(project, expectedRevision);
  }

  /**
   * Atomic compare-and-set across tabs. The read, revision check, and write all
   * run while holding the project's cross-tab lock, so two tabs saving at the
   * same moment cannot both pass the check; the loser sees a conflict and the
   * stored copy is left untouched.
   */
  saveExclusive(project: Project, expectedRevision: number): Promise<SaveResult> {
    return this.lock(projectLockName(project.id), () => this.write(project, expectedRevision));
  }

  private write(project: Project, expectedRevision: number): SaveResult {
    if (!this.storage) {
      return {
        ok: false,
        reason: 'storage-unavailable',
        message: 'Browser storage is not available, so nothing can be saved here.',
      };
    }
    const key = projectKey(project.id);
    let raw: string | null;
    try {
      raw = this.storage.getItem(key);
    } catch {
      return {
        ok: false,
        reason: 'storage-unavailable',
        message: 'This browser blocked access to saved project data.',
      };
    }

    if (raw !== null) {
      const parsed = parseStoredProject(raw);
      if (!parsed.ok) {
        return {
          ok: false,
          reason: 'invalid-stored',
          message:
            'The saved copy of this project cannot be read, so it was not overwritten. Download your current edits to keep them.',
        };
      }
      if (parsed.value.contentRevision !== expectedRevision) {
        return {
          ok: false,
          reason: 'conflict',
          message:
            'A newer copy of this project was saved here. Your edits are still open in this tab; nothing was overwritten.',
        };
      }
    } else if (expectedRevision !== 0) {
      return {
        ok: false,
        reason: 'deleted-externally',
        message: 'This project was deleted from browser storage.',
      };
    }

    const next: Project = {
      ...project,
      schemaVersion: SCHEMA_VERSION,
      contentRevision: expectedRevision + 1,
      updatedAt: this.now(),
    };

    try {
      this.storage.setItem(key, JSON.stringify(next));
    } catch (error) {
      if (isQuotaError(error)) {
        return {
          ok: false,
          reason: 'quota',
          message:
            'Browser storage is full, so this project could not be saved. Your edits are still open here.',
        };
      }
      return {
        ok: false,
        reason: 'storage-unavailable',
        message: 'This browser refused to write project data.',
      };
    }

    return { ok: true, project: next };
  }

  remove(id: string): { ok: boolean; message?: string } {
    if (!this.storage) {
      return { ok: false, message: 'Browser storage is not available.' };
    }
    try {
      this.storage.removeItem(projectKey(id));
      return { ok: true };
    } catch {
      return { ok: false, message: 'This browser refused to remove the project.' };
    }
  }
}
