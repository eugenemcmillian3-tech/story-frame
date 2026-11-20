export type DomainErrorCode =
  | 'script-locked'
  | 'scene-locked'
  | 'scene-not-found'
  | 'script-version-not-found'
  | 'stale-plan'
  | 'invalid-value';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Thrown when a mutation would change one or more locked scene components. */
export class LockedFieldsError extends DomainError {
  readonly sceneId: string;
  readonly fields: string[];

  constructor(sceneId: string, fields: string[]) {
    super(
      'scene-locked',
      `Locked components cannot be changed: ${fields.join(', ')}. Unlock them first.`,
    );
    this.name = 'LockedFieldsError';
    this.sceneId = sceneId;
    this.fields = fields;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
