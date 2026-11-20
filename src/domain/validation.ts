import { MAX_SCENES, MAX_SCRIPT_VERSIONS } from './constants';
import { computeScriptFingerprint } from './fingerprint';
import { SCHEMA_VERSION } from './types';
import type {
  AssetReference,
  AssetType,
  AudioTrackSettings,
  Brief,
  ImageFraming,
  PlanningBudget,
  PlanningNote,
  Project,
  ProjectAudio,
  ProjectMode,
  Scene,
  SceneLocks,
  SceneStatus,
  Script,
  ScriptVersion,
  SourceNote,
  Stage,
  StoryNotes,
  Storyboard,
  TargetDuration,
  VisualPreset,
} from './types';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseFailure(errors: string[]): { ok: false; errors: string[] } {
  return { ok: false, errors };
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Reader {
  readonly errors: string[] = [];

  private add(path: string, message: string): void {
    this.errors.push(`${path} ${message}`);
  }

  record(value: unknown, path: string): JsonRecord {
    if (isJsonRecord(value)) return value;
    this.add(path, value === undefined ? 'is required' : 'must be an object');
    return {};
  }

  string(source: JsonRecord, key: string, path: string, maxLength?: number): string {
    const value = source[key];
    if (typeof value !== 'string') {
      this.add(path, value === undefined ? 'is required' : 'must be text');
      return '';
    }
    if (maxLength !== undefined && value.length > maxLength) {
      this.add(path, `must be ${maxLength} characters or fewer`);
      return value.slice(0, maxLength);
    }
    return value;
  }

  nullableNumber(
    source: JsonRecord,
    key: string,
    path: string,
    min: number,
    max: number,
  ): number | null {
    const value = source[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, 'must be a number or null');
      return null;
    }
    if (value < min || value > max) {
      this.add(path, `must be between ${min} and ${max}`);
      return Math.min(max, Math.max(min, value));
    }
    return value;
  }

  nullableString(source: JsonRecord, key: string, path: string, maxLength?: number): string | null {
    const value = source[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      this.add(path, 'must be text or null');
      return null;
    }
    if (maxLength !== undefined && value.length > maxLength) {
      this.add(path, `must be ${maxLength} characters or fewer`);
      return value.slice(0, maxLength);
    }
    return value;
  }

  boolean(source: JsonRecord, key: string, path: string): boolean {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    this.add(path, value === undefined ? 'is required' : 'must be true or false');
    return false;
  }

  number(source: JsonRecord, key: string, path: string, min: number, max: number): number {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, value === undefined ? 'is required' : 'must be a number');
      return min;
    }
    if (value < min || value > max) {
      this.add(path, `must be between ${min} and ${max}`);
      return Math.min(max, Math.max(min, value));
    }
    return value;
  }

  enumValue<T extends string>(
    source: JsonRecord,
    key: string,
    path: string,
    allowed: readonly T[],
  ): T {
    const value = source[key];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
      return value as T;
    }
    this.add(path, `must be one of: ${allowed.join(', ')}`);
    return allowed[0] as T;
  }

  array(source: JsonRecord, key: string, path: string, maxLength: number): unknown[] {
    const value = source[key];
    if (!Array.isArray(value)) {
      this.add(path, value === undefined ? 'is required' : 'must be a list');
      return [];
    }
    if (value.length > maxLength) {
      this.add(path, `must contain at most ${maxLength} items`);
      return value.slice(0, maxLength);
    }
    return value;
  }
}

const MODES: readonly ProjectMode[] = ['factual', 'fiction'];
const PRESETS: readonly VisualPreset[] = [
  'cinematic-explainer',
  'illustrated-story',
  'clean-educational',
];
const ASSET_TYPES: readonly AssetType[] = ['image', 'video-clip', 'diagram', 'title-card', 'b-roll'];
const SCENE_STATUSES: readonly SceneStatus[] = ['draft', 'approved'];
const STAGES: readonly Stage[] = ['brief', 'script', 'storyboard', 'preview', 'export'];

function readTargetDuration(reader: Reader, source: JsonRecord): TargetDuration {
  const value = source.targetDuration;
  if (value === 30 || value === 45 || value === 60 || value === 90) return value;
  reader.enumValue(
    { targetDuration: String(value) },
    'targetDuration',
    'brief.targetDuration',
    ['30', '45', '60', '90'],
  );
  return 60;
}

function readBudget(reader: Reader, source: JsonRecord): PlanningBudget {
  const record = reader.record(source.budget, 'brief.budget');
  const currency = reader.string(record, 'currency', 'brief.budget.currency', 8);
  const rawAmount = record.amount;
  let amount: number | null = null;
  if (rawAmount !== null && rawAmount !== undefined) {
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount >= 0) {
      amount = rawAmount;
    } else {
      amount = null;
      reader.number(record, 'amount', 'brief.budget.amount', 0, Number.MAX_SAFE_INTEGER);
    }
  }
  return { amount, currency: currency.trim().toUpperCase() || 'USD' };
}

function readLocks(reader: Reader, source: JsonRecord, path: string): SceneLocks {
  const record = reader.record(source, path);
  return {
    narration: reader.boolean(record, 'narration', `${path}.narration`),
    visuals: reader.boolean(record, 'visuals', `${path}.visuals`),
    text: reader.boolean(record, 'text', `${path}.text`),
    timing: reader.boolean(record, 'timing', `${path}.timing`),
  };
}

function readScriptVersions(reader: Reader, source: JsonRecord): ScriptVersion[] {
  const list = reader.array(source, 'versions', 'script.versions', MAX_SCRIPT_VERSIONS);
  return list.map((item, index) => {
    const path = `script.versions[${index}]`;
    const record = reader.record(item, path);
    const narration = reader.string(record, 'narration', `${path}.narration`, 40000);
    return {
      id: reader.string(record, 'id', `${path}.id`, 200),
      narration,
      fingerprint: computeScriptFingerprint(narration),
      replacedAt: reader.string(record, 'replacedAt', `${path}.replacedAt`, 64),
    };
  });
}

function readScript(reader: Reader, source: unknown): Script {
  const record = reader.record(source, 'script');
  const narration = reader.string(record, 'narration', 'script.narration', 40000);
  return {
    narration,
    fingerprint: computeScriptFingerprint(narration),
    locked: reader.boolean(record, 'locked', 'script.locked'),
    lockedAt: reader.nullableString(record, 'lockedAt', 'script.lockedAt', 64),
    updatedAt: reader.string(record, 'updatedAt', 'script.updatedAt', 64),
    versions: readScriptVersions(reader, record),
  };
}

function readSourceNotes(reader: Reader, source: unknown): SourceNote[] {
  const list = reader.array({ sourceNotes: source }, 'sourceNotes', 'sourceNotes', 100);
  return list.map((item, index) => {
    const path = `sourceNotes[${index}]`;
    const record = reader.record(item, path);
    return {
      id: reader.string(record, 'id', `${path}.id`, 200),
      title: reader.string(record, 'title', `${path}.title`, 400),
      url: reader.string(record, 'url', `${path}.url`, 2000),
      excerpt: reader.string(record, 'excerpt', `${path}.excerpt`, 8000),
      notes: reader.string(record, 'notes', `${path}.notes`, 4000),
    };
  });
}

function readStoryNotes(reader: Reader, source: unknown): StoryNotes {
  const record = reader.record(source, 'storyNotes');
  return {
    characters: reader.string(record, 'characters', 'storyNotes.characters', 4000),
    setting: reader.string(record, 'setting', 'storyNotes.setting', 4000),
    continuity: reader.string(record, 'continuity', 'storyNotes.continuity', 8000),
  };
}

function readAssetRef(reader: Reader, source: JsonRecord, path: string): AssetReference | null {
  const value = source.assetRef;
  if (value === null || value === undefined) return null;
  const record = reader.record(value, path);
  return {
    id: reader.string(record, 'id', `${path}.id`, 200),
    label: reader.string(record, 'label', `${path}.label`, 500),
  };
}

function readScene(
  reader: Reader,
  source: unknown,
  index: number,
  prefix = 'storyboard',
): Scene {
  const path = `${prefix}.scenes[${index}]`;
  const record = reader.record(source, path);
  return {
    id: reader.string(record, 'id', `${path}.id`, 200),
    title: reader.string(record, 'title', `${path}.title`, 200),
    narration: reader.string(record, 'narration', `${path}.narration`, 8000),
    visualDirection: reader.string(record, 'visualDirection', `${path}.visualDirection`, 4000),
    assetType: reader.enumValue(record, 'assetType', `${path}.assetType`, ASSET_TYPES),
    assetRef: readAssetRef(reader, record, `${path}.assetRef`),
    imageAssetId: reader.nullableString(record, 'imageAssetId', `${path}.imageAssetId`, 200),
    imageFraming: readImageFraming(reader, record, `${path}.imageFraming`),
    onScreenText: reader.string(record, 'onScreenText', `${path}.onScreenText`, 500),
    plannedDuration: reader.number(record, 'plannedDuration', `${path}.plannedDuration`, 0, 600),
    status: reader.enumValue(record, 'status', `${path}.status`, SCENE_STATUSES),
    locks: readLocks(reader, record.locks as JsonRecord, `${path}.locks`),
  };
}

const IMAGE_FRAMINGS: readonly ImageFraming[] = ['fit', 'fill'];

/** Schema 1 scenes have no image fields; they default to no image, contained. */
function readImageFraming(reader: Reader, source: JsonRecord, path: string): ImageFraming {
  if (source.imageFraming === undefined) return 'fit';
  return reader.enumValue(source, 'imageFraming', path, IMAGE_FRAMINGS);
}

function emptyAudioTrack(): AudioTrackSettings {
  return { assetId: null, fileName: null, durationMs: null, volume: 1, muted: false };
}

function readAudioTrack(reader: Reader, source: unknown, role: string): AudioTrackSettings {
  const path = `audio.${role}`;
  const record = reader.record(source, path);
  return {
    assetId: reader.nullableString(record, 'assetId', `${path}.assetId`, 200),
    fileName: reader.nullableString(record, 'fileName', `${path}.fileName`, 300),
    durationMs: reader.nullableNumber(record, 'durationMs', `${path}.durationMs`, 0, 36_000_000),
    volume: record.volume === undefined ? 1 : reader.number(record, 'volume', `${path}.volume`, 0, 1),
    muted: record.muted === undefined ? false : reader.boolean(record, 'muted', `${path}.muted`),
  };
}

/** Schema 1 and 2 projects predate uploaded audio and default to no tracks. */
function readProjectAudio(reader: Reader, source: unknown): ProjectAudio {
  if (source === undefined || source === null) {
    return { narration: emptyAudioTrack(), music: emptyAudioTrack() };
  }
  const record = reader.record(source, 'audio');
  return {
    narration: readAudioTrack(reader, record.narration, 'narration'),
    music: readAudioTrack(reader, record.music, 'music'),
  };
}

function readSavedStoryboard(reader: Reader, source: unknown): Storyboard['previous'] {
  if (source === null || source === undefined) return null;
  const record = reader.record(source, 'storyboard.previous');
  const list = reader.array(record, 'scenes', 'storyboard.previous.scenes', MAX_SCENES);
  return {
    scenes: list.map((item, index) => readScene(reader, item, index, 'storyboard.previous')),
    reviewedScriptFingerprint: reader.nullableString(
      record,
      'reviewedScriptFingerprint',
      'storyboard.previous.reviewedScriptFingerprint',
      200,
    ),
    reviewedAt: reader.nullableString(
      record,
      'reviewedAt',
      'storyboard.previous.reviewedAt',
      64,
    ),
    savedAt: reader.string(record, 'savedAt', 'storyboard.previous.savedAt', 64),
  };
}

function readStoryboard(reader: Reader, source: unknown): Storyboard {
  const record = reader.record(source, 'storyboard');
  const list = reader.array(record, 'scenes', 'storyboard.scenes', MAX_SCENES);
  return {
    scenes: list.map((item, index) => readScene(reader, item, index)),
    reviewedScriptFingerprint: reader.nullableString(
      record,
      'reviewedScriptFingerprint',
      'storyboard.reviewedScriptFingerprint',
      200,
    ),
    reviewedAt: reader.nullableString(record, 'reviewedAt', 'storyboard.reviewedAt', 64),
    previous: readSavedStoryboard(reader, record.previous),
  };
}

function readPlanningNotes(reader: Reader, source: unknown): PlanningNote[] {
  if (source === null || source === undefined) return [];
  const list = reader.array({ planningNotes: source }, 'planningNotes', 'planningNotes', 20);
  return list.map((item, index) => {
    const path = `planningNotes[${index}]`;
    const record = reader.record(item, path);
    return {
      id: reader.string(record, 'id', `${path}.id`, 200),
      title: reader.string(record, 'title', `${path}.title`, 200),
      body: reader.string(record, 'body', `${path}.body`, 20_000),
      createdAt: reader.string(record, 'createdAt', `${path}.createdAt`, 64),
      inputFingerprint: reader.nullableString(
        record,
        'inputFingerprint',
        `${path}.inputFingerprint`,
        200,
      ),
    };
  });
}

/**
 * Validate and normalize any unknown value into a Project.
 *
 * JSON parse errors are handled by the caller (see parseStoredProject).
 * Returns a list of human-readable errors instead of throwing.
 */
export function parseProjectJson(raw: unknown): ParseResult<Project> {
  if (!isJsonRecord(raw)) return parseFailure(['Project data must be an object.']);

  // Older schemas lack images, audio, planning notes, or a saved storyboard.
  // They are upgraded in memory to the current shape and saved as schema 4.
  if (
    raw.schemaVersion !== 1 &&
    raw.schemaVersion !== 2 &&
    raw.schemaVersion !== 3 &&
    raw.schemaVersion !== SCHEMA_VERSION
  ) {
    if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
      return parseFailure([
        `Unsupported schema version ${raw.schemaVersion}: this build reads schema versions 1, 2, 3, and ${SCHEMA_VERSION}.`,
      ]);
    }
    return parseFailure([
      `Missing or unsupported schema version (${JSON.stringify(raw.schemaVersion ?? null)}).`,
    ]);
  }

  const reader = new Reader();

  const briefRecord = reader.record(raw.brief, 'brief');
  const voiceRecord = reader.record(briefRecord.voicePreference, 'brief.voicePreference');
  const brief: Brief = {
    topic: reader.string(briefRecord, 'topic', 'brief.topic', 8000),
    audience: reader.string(briefRecord, 'audience', 'brief.audience', 500),
    goal: reader.string(briefRecord, 'goal', 'brief.goal', 1000),
    mode: reader.enumValue(briefRecord, 'mode', 'brief.mode', MODES),
    targetDuration: readTargetDuration(reader, briefRecord),
    tone: reader.string(briefRecord, 'tone', 'brief.tone', 300),
    visualPreset: reader.enumValue(briefRecord, 'visualPreset', 'brief.visualPreset', PRESETS),
    voicePreference: {
      label: reader.string(voiceRecord, 'label', 'brief.voicePreference.label', 300),
      notes: reader.string(voiceRecord, 'notes', 'brief.voicePreference.notes', 2000),
    },
    budget: readBudget(reader, briefRecord),
  };

  const workflowRecord = reader.record(raw.workflow, 'workflow');

  const project: Project = {
    schemaVersion: SCHEMA_VERSION,
    id: reader.string(raw, 'id', 'id', 200),
    title: reader.string(raw, 'title', 'title', 200),
    createdAt: reader.string(raw, 'createdAt', 'createdAt', 64),
    updatedAt: reader.string(raw, 'updatedAt', 'updatedAt', 64),
    contentRevision: reader.number(raw, 'contentRevision', 'contentRevision', 0, 1_000_000_000),
    isSample: typeof raw.isSample === 'boolean' ? raw.isSample : false,
    brief,
    script: readScript(reader, raw.script),
    sourceNotes: readSourceNotes(reader, raw.sourceNotes),
    storyNotes: readStoryNotes(reader, raw.storyNotes),
    audio: readProjectAudio(reader, raw.audio),
    planningNotes: readPlanningNotes(reader, raw.planningNotes),
    storyboard: readStoryboard(reader, raw.storyboard),
    workflow: {
      lastStage: reader.enumValue(workflowRecord, 'lastStage', 'workflow.lastStage', STAGES),
    },
  };

  if (reader.errors.length > 0) return parseFailure(reader.errors);
  return { ok: true, value: project };
}

export type StoredParseResult = ParseResult<Project>;

/** Parse stored JSON text, distinguishing malformed JSON from an invalid shape. */
export function parseStoredProject(text: string): StoredParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return parseFailure(['Saved project data is not valid JSON.']);
  }
  return parseProjectJson(data);
}
