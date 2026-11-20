import { MAX_SCRIPT_VERSIONS, TARGET_DURATIONS } from './constants';
import { computeScriptFingerprint } from './fingerprint';
import { DomainError } from './errors';
import { newId } from './ids';
import { SCHEMA_VERSION } from './types';
import type {
  AudioTrackRole,
  AudioTrackSettings,
  Brief,
  Project,
  ProjectAudio,
  ProjectMode,
  PlanningNote,
  Scene,
  Script,
  ScriptVersion,
  SourceNote,
  Stage,
  StoryboardDraftScene,
  StoryNotes,
  TargetDuration,
  VisualPreset,
} from './types';

export function nowIso(): string {
  return new Date().toISOString();
}

export interface NewProjectInput {
  title: string;
  mode: ProjectMode;
  targetDuration: TargetDuration;
  visualPreset: VisualPreset;
}

export function createEmptyBrief(overrides: Partial<Brief> = {}): Brief {
  return {
    topic: '',
    audience: '',
    goal: '',
    mode: 'factual',
    targetDuration: 60,
    tone: '',
    visualPreset: 'clean-educational',
    voicePreference: { label: '', notes: '' },
    budget: { amount: null, currency: 'USD' },
    ...overrides,
  };
}

export function createEmptyAudioTrack(): AudioTrackSettings {
  return { assetId: null, fileName: null, durationMs: null, volume: 1, muted: false };
}

export function createEmptyProjectAudio(): ProjectAudio {
  return { narration: createEmptyAudioTrack(), music: createEmptyAudioTrack() };
}

export function createEmptyScript(now: string = nowIso()): Script {
  return {
    narration: '',
    fingerprint: computeScriptFingerprint(''),
    locked: false,
    lockedAt: null,
    updatedAt: now,
    versions: [],
  };
}

function touch(project: Project, now: string): Project {
  return { ...project, updatedAt: now };
}

export function createProject(
  input: NewProjectInput,
  options: { now?: string; id?: string } = {},
): Project {
  const now = options.now ?? nowIso();
  const targetDuration = TARGET_DURATIONS.includes(input.targetDuration)
    ? input.targetDuration
    : 60;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: options.id ?? newId('prj'),
    title: input.title.trim() || 'Untitled project',
    createdAt: now,
    updatedAt: now,
    contentRevision: 0,
    isSample: false,
    brief: createEmptyBrief({
      mode: input.mode,
      targetDuration,
      visualPreset: input.visualPreset,
    }),
    script: createEmptyScript(now),
    sourceNotes: [],
    storyNotes: { characters: '', setting: '', continuity: '' },
    audio: createEmptyProjectAudio(),
    planningNotes: [],
    storyboard: { scenes: [], reviewedScriptFingerprint: null, reviewedAt: null, previous: null },
    workflow: { lastStage: 'brief' },
  };
}

export function renameProject(project: Project, title: string, now: string = nowIso()): Project {
  const nextTitle = title.trim();
  if (nextTitle === '' || nextTitle === project.title) return project;
  return touch({ ...project, title: nextTitle.slice(0, 200) }, now);
}

/** Copy a project with brand-new project, scene, source, and version ids. */
export function duplicateProject(
  project: Project,
  options: { now?: string; id?: string } = {},
): Project {
  const now = options.now ?? nowIso();
  return {
    ...project,
    id: options.id ?? newId('prj'),
    title: `${project.title} (copy)`,
    createdAt: now,
    updatedAt: now,
    contentRevision: 0,
    isSample: false,
    script: {
      ...project.script,
      versions: project.script.versions.map((version) => ({ ...version, id: newId('ver') })),
    },
    sourceNotes: project.sourceNotes.map((note) => ({ ...note, id: newId('src') })),
    audio: {
      narration: { ...project.audio.narration },
      music: { ...project.audio.music },
    },
    planningNotes: project.planningNotes.map((note) => ({ ...note, id: newId('note') })),
    storyboard: {
      ...project.storyboard,
      scenes: project.storyboard.scenes.map((scene) => ({
        ...scene,
        id: newId('scn'),
        locks: { ...scene.locks },
        assetRef: scene.assetRef ? { ...scene.assetRef, id: newId('scn') } : null,
      })),
      previous: project.storyboard.previous
        ? {
            ...project.storyboard.previous,
            scenes: project.storyboard.previous.scenes.map((scene) => ({
              ...scene,
              id: newId('scn'),
              locks: { ...scene.locks },
              assetRef: scene.assetRef ? { ...scene.assetRef, id: newId('scn') } : null,
            })),
          }
        : null,
    },
  };
}

export function updateAudioTrack(
  project: Project,
  role: AudioTrackRole,
  patch: Partial<AudioTrackSettings>,
  now: string = nowIso(),
): Project {
  const current = project.audio[role];
  const next: AudioTrackSettings = {
    ...current,
    ...patch,
    volume: Math.max(0, Math.min(1, patch.volume ?? current.volume)),
    durationMs:
      patch.durationMs !== undefined
        ? patch.durationMs === null
          ? null
          : Math.max(0, Math.round(patch.durationMs))
        : current.durationMs,
    generated: patch.generated !== undefined ? patch.generated : current.generated,
  };
  if (
    current.assetId === next.assetId &&
    current.fileName === next.fileName &&
    current.durationMs === next.durationMs &&
    current.volume === next.volume &&
    current.muted === next.muted &&
    current.generated === next.generated
  ) {
    return project;
  }
  return touch({ ...project, audio: { ...project.audio, [role]: next } }, now);
}

export function updateBrief(project: Project, patch: Partial<Brief>, now: string = nowIso()): Project {
  return touch({ ...project, brief: { ...project.brief, ...patch } }, now);
}

export function setProjectMode(project: Project, mode: ProjectMode): Project {
  if (project.brief.mode === mode) return project;
  return updateBrief(project, { mode });
}

export function addPlanningNote(
  project: Project,
  note: Pick<PlanningNote, 'title' | 'body' | 'inputFingerprint'>,
  options: { now?: string; maxNotes?: number } = {},
): Project {
  const title = note.title.trim().slice(0, 200) || 'Planning note';
  const body = note.body.trim();
  if (body === '') return project;
  const now = options.now ?? nowIso();
  const maxNotes = Math.max(1, options.maxNotes ?? 20);
  const planningNotes = [
    {
      id: newId('note'),
      title,
      body: body.slice(0, 20_000),
      createdAt: now,
      inputFingerprint: note.inputFingerprint,
    },
    ...project.planningNotes,
  ].slice(0, maxNotes);
  return touch({ ...project, planningNotes }, now);
}

export function removePlanningNote(
  project: Project,
  noteId: string,
  now: string = nowIso(),
): Project {
  if (!project.planningNotes.some((note) => note.id === noteId)) return project;
  return touch(
    { ...project, planningNotes: project.planningNotes.filter((note) => note.id !== noteId) },
    now,
  );
}

/**
 * Accept generated storyboard scenes only when they still match the saved script
 * and no current scene is locked. The replaced board stays recoverable.
 */
export function acceptStoryboardDraft(
  project: Project,
  scenes: StoryboardDraftScene[],
  options: { expectedScriptFingerprint: string; now?: string },
): Project {
  if (project.script.narration.trim() === '') {
    throw new DomainError('invalid-value', 'Write and save a script before accepting a storyboard.');
  }
  if (project.script.fingerprint !== options.expectedScriptFingerprint) {
    throw new DomainError(
      'invalid-value',
      'The script changed after this storyboard was generated. Generate a fresh storyboard.',
    );
  }
  const lockedScene = project.storyboard.scenes.find((scene) =>
    Object.values(scene.locks).some(Boolean),
  );
  if (lockedScene) {
    throw new DomainError(
      'scene-locked',
      `Scene “${lockedScene.title}” has locked components. Unlock them before replacing the storyboard.`,
    );
  }
  if (scenes.length === 0) {
    throw new DomainError('invalid-value', 'The storyboard proposal has no scenes.');
  }
  const now = options.now ?? nowIso();
  const previous =
    project.storyboard.scenes.length > 0
      ? {
          scenes: project.storyboard.scenes,
          reviewedScriptFingerprint: project.storyboard.reviewedScriptFingerprint,
          reviewedAt: project.storyboard.reviewedAt,
          savedAt: now,
        }
      : null;
  const nextScenes: Scene[] = scenes.map((scene) => ({
    id: newId('scn'),
    title: scene.title.slice(0, 200),
    narration: scene.narration,
    visualDirection: scene.visualDirection.slice(0, 4000),
    assetType: scene.assetType,
    assetRef: null,
    imageAssetId: null,
    imageFraming: 'fit',
    onScreenText: scene.onScreenText.slice(0, 500),
    plannedDuration: Math.min(600, Math.max(1, Math.round(scene.plannedDuration))),
    status: 'draft',
    locks: { narration: false, visuals: false, text: false, timing: false },
  }));
  return touch(
    {
      ...project,
      storyboard: {
        scenes: nextScenes,
        reviewedScriptFingerprint: project.script.fingerprint,
        reviewedAt: now,
        previous,
      },
    },
    now,
  );
}

/** Swap the current board with the recoverable previous board. */
export function restorePreviousStoryboard(
  project: Project,
  now: string = nowIso(),
): Project {
  const previous = project.storyboard.previous;
  if (!previous) {
    throw new DomainError('invalid-value', 'There is no previous storyboard to restore.');
  }
  const lockedScene = project.storyboard.scenes.find((scene) =>
    Object.values(scene.locks).some(Boolean),
  );
  if (lockedScene) {
    throw new DomainError(
      'scene-locked',
      `Scene “${lockedScene.title}” has locked components. Unlock them before restoring a storyboard.`,
    );
  }
  return touch(
    {
      ...project,
      storyboard: {
        scenes: previous.scenes,
        reviewedScriptFingerprint: previous.reviewedScriptFingerprint,
        reviewedAt: previous.reviewedAt,
        previous: {
          scenes: project.storyboard.scenes,
          reviewedScriptFingerprint: project.storyboard.reviewedScriptFingerprint,
          reviewedAt: project.storyboard.reviewedAt,
          savedAt: now,
        },
      },
    },
    now,
  );
}

export function setStage(project: Project, stage: Stage): Project {
  if (project.workflow.lastStage === stage) return project;
  return { ...project, workflow: { ...project.workflow, lastStage: stage } };
}

// ---------------------------------------------------------------------------
// Source notes (factual) and story notes (fiction)
// ---------------------------------------------------------------------------

export function updateSourceNotes(
  project: Project,
  notes: SourceNote[],
  now: string = nowIso(),
): Project {
  return touch({ ...project, sourceNotes: notes.slice(0, 100) }, now);
}

export function updateSourceNote(
  project: Project,
  noteId: string,
  patch: Partial<Omit<SourceNote, 'id'>>,
  now: string = nowIso(),
): Project {
  return touch(
    {
      ...project,
      sourceNotes: project.sourceNotes.map((note) =>
        note.id === noteId ? { ...note, ...patch } : note,
      ),
    },
    now,
  );
}

export function removeSourceNote(
  project: Project,
  noteId: string,
  now: string = nowIso(),
): Project {
  return touch(
    {
      ...project,
      sourceNotes: project.sourceNotes.filter((note) => note.id !== noteId),
    },
    now,
  );
}

export function updateStoryNotes(
  project: Project,
  patch: Partial<StoryNotes>,
  now: string = nowIso(),
): Project {
  return touch({ ...project, storyNotes: { ...project.storyNotes, ...patch } }, now);
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

function withScript(project: Project, script: Script, now: string): Project {
  return touch({ ...project, script }, now);
}

/**
 * Replace narration. This is the only path that changes script content.
 * Throws when the script is locked; returns the same project when unchanged.
 */
export function replaceScriptNarration(
  project: Project,
  narration: string,
  options: { archivePrevious?: boolean; now?: string } = {},
): Project {
  if (narration === project.script.narration) return project;
  if (project.script.locked) {
    throw new DomainError(
      'script-locked',
      'The script is locked. Unlock it before changing narration.',
    );
  }
  const now = options.now ?? nowIso();
  const previous = project.script;
  const archivePrevious = options.archivePrevious === true && previous.narration.trim() !== '';
  const versions: ScriptVersion[] = archivePrevious
    ? [
        {
          id: newId('ver'),
          narration: previous.narration,
          fingerprint: previous.fingerprint,
          replacedAt: now,
        },
        ...previous.versions,
      ].slice(0, MAX_SCRIPT_VERSIONS)
    : previous.versions;

  return withScript(
    project,
    {
      narration,
      fingerprint: computeScriptFingerprint(narration),
      locked: previous.locked,
      lockedAt: previous.lockedAt,
      updatedAt: now,
      versions,
    },
    now,
  );
}

export function setScriptLock(
  project: Project,
  locked: boolean,
  now: string = nowIso(),
): Project {
  if (project.script.locked === locked) return project;
  return withScript(
    project,
    { ...project.script, locked, lockedAt: locked ? now : null },
    now,
  );
}

export function restoreScriptVersion(
  project: Project,
  versionId: string,
  now: string = nowIso(),
): Project {
  const version = project.script.versions.find((candidate) => candidate.id === versionId);
  if (!version) {
    throw new DomainError('script-version-not-found', 'That saved script version no longer exists.');
  }
  if (project.script.locked) {
    throw new DomainError(
      'script-locked',
      'The script is locked. Unlock it before restoring a version.',
    );
  }
  const archiveCurrent = project.script.narration.trim() !== '';
  const versions = [
    ...(archiveCurrent
      ? [
          {
            id: newId('ver'),
            narration: project.script.narration,
            fingerprint: project.script.fingerprint,
            replacedAt: now,
          },
        ]
      : []),
    ...project.script.versions.filter((candidate) => candidate.id !== versionId),
  ].slice(0, MAX_SCRIPT_VERSIONS);

  return withScript(
    project,
    {
      narration: version.narration,
      fingerprint: computeScriptFingerprint(version.narration),
      locked: false,
      lockedAt: null,
      updatedAt: now,
      versions,
    },
    now,
  );
}
