import { MAX_SCENES } from './constants';
import { clampPlannedDuration } from './duration';
import { nowIso } from './project';
import { DomainError, LockedFieldsError } from './errors';
import { newId } from './ids';
import type {
  AssetReference,
  AssetType,
  ImageFraming,
  Project,
  Scene,
  SceneLockKey,
  SceneStatus,
} from './types';

export interface SceneContentPatch {
  title?: string;
  narration?: string;
  visualDirection?: string;
  assetType?: AssetType;
  assetRef?: AssetReference | null;
  imageAssetId?: string | null;
  imageFraming?: ImageFraming;
  onScreenText?: string;
  plannedDuration?: number;
}

export type SceneFieldKey = keyof SceneContentPatch;

/** Which lock guards each editable scene field. Title is metadata and stays editable. */
const LOCK_FOR_FIELD: Partial<Record<SceneFieldKey, SceneLockKey>> = {
  narration: 'narration',
  visualDirection: 'visuals',
  assetType: 'visuals',
  assetRef: 'visuals',
  imageAssetId: 'visuals',
  imageFraming: 'visuals',
  onScreenText: 'text',
  plannedDuration: 'timing',
};

function touch(project: Project, now: string): Project {
  return { ...project, updatedAt: now };
}

function findScene(project: Project, sceneId: string): { scene: Scene; index: number } {
  const index = project.storyboard.scenes.findIndex((scene) => scene.id === sceneId);
  if (index === -1) {
    throw new DomainError('scene-not-found', 'That scene is no longer in the storyboard.');
  }
  return { scene: project.storyboard.scenes[index] as Scene, index };
}

function withScenes(project: Project, scenes: Scene[], now: string): Project {
  return touch(
    { ...project, storyboard: { ...project.storyboard, scenes } },
    now,
  );
}

export function addScene(
  project: Project,
  input: Partial<SceneContentPatch> = {},
  now: string = nowIso(),
): Project {
  if (project.storyboard.scenes.length >= MAX_SCENES) {
    throw new DomainError('invalid-value', `A storyboard can hold at most ${MAX_SCENES} scenes.`);
  }
  const scene: Scene = {
    id: newId('scn'),
    title: input.title?.trim() || `Scene ${project.storyboard.scenes.length + 1}`,
    narration: input.narration ?? '',
    visualDirection: input.visualDirection ?? '',
    assetType: input.assetType ?? 'image',
    assetRef: input.assetRef ?? null,
    imageAssetId: null,
    imageFraming: 'fit',
    onScreenText: input.onScreenText ?? '',
    plannedDuration: clampPlannedDuration(input.plannedDuration ?? 5),
    status: 'draft',
    locks: { narration: false, visuals: false, text: false, timing: false },
  };
  return withScenes(project, [...project.storyboard.scenes, scene], now);
}

/** Duplicate a scene with a new id, placed directly after the original. */
export function duplicateScene(project: Project, sceneId: string, now: string = nowIso()): Project {
  const { scene, index } = findScene(project, sceneId);
  if (project.storyboard.scenes.length >= MAX_SCENES) {
    throw new DomainError('invalid-value', `A storyboard can hold at most ${MAX_SCENES} scenes.`);
  }
  const copy: Scene = {
    ...scene,
    id: newId('scn'),
    title: `${scene.title} (copy)`.slice(0, 200),
    status: 'draft',
    locks: { narration: false, visuals: false, text: false, timing: false },
    assetRef: scene.assetRef ? { id: newId('scn'), label: scene.assetRef.label } : null,
  };
  const scenes = [...project.storyboard.scenes];
  scenes.splice(index + 1, 0, copy);
  return withScenes(project, scenes, now);
}

export function deleteScene(project: Project, sceneId: string, now: string = nowIso()): Project {
  const { index } = findScene(project, sceneId);
  const scenes = project.storyboard.scenes.filter((_, position) => position !== index);
  return withScenes(project, scenes, now);
}

/**
 * Update one scene. Locked components are rejected here, in the domain — the UI
 * disabling an input is a convenience, not the enforcement.
 */
export function updateScene(
  project: Project,
  sceneId: string,
  patch: SceneContentPatch,
  now: string = nowIso(),
): Project {
  const { scene } = findScene(project, sceneId);
  const changed: SceneFieldKey[] = [];

  const differs = (field: SceneFieldKey, next: unknown, current: unknown): boolean =>
    JSON.stringify(next) !== JSON.stringify(current);

  if (patch.title !== undefined && patch.title !== scene.title) changed.push('title');
  if (patch.narration !== undefined && patch.narration !== scene.narration) changed.push('narration');
  if (
    patch.visualDirection !== undefined &&
    patch.visualDirection !== scene.visualDirection
  ) {
    changed.push('visualDirection');
  }
  if (patch.assetType !== undefined && patch.assetType !== scene.assetType) changed.push('assetType');
  if (patch.assetRef !== undefined && differs('assetRef', patch.assetRef, scene.assetRef)) {
    changed.push('assetRef');
  }
  if (
    patch.imageAssetId !== undefined &&
    patch.imageAssetId !== scene.imageAssetId
  ) {
    changed.push('imageAssetId');
  }
  if (
    patch.imageFraming !== undefined &&
    patch.imageFraming !== scene.imageFraming
  ) {
    changed.push('imageFraming');
  }
  if (patch.onScreenText !== undefined && patch.onScreenText !== scene.onScreenText) {
    changed.push('onScreenText');
  }
  if (
    patch.plannedDuration !== undefined &&
    clampPlannedDuration(patch.plannedDuration) !== clampPlannedDuration(scene.plannedDuration)
  ) {
    changed.push('plannedDuration');
  }

  if (changed.length === 0) return project;

  const lockedKeys = new Set<SceneLockKey>();
  for (const field of changed) {
    const lock = LOCK_FOR_FIELD[field];
    if (lock && scene.locks[lock]) lockedKeys.add(lock);
  }
  if (lockedKeys.size > 0) {
    throw new LockedFieldsError(sceneId, [...lockedKeys].map((key) => key));
  }

  const contentChanged = changed.some((field) => field !== 'title');
  const next: Scene = {
    ...scene,
    title: patch.title !== undefined ? patch.title.slice(0, 200) : scene.title,
    narration: patch.narration !== undefined ? patch.narration : scene.narration,
    visualDirection:
      patch.visualDirection !== undefined ? patch.visualDirection : scene.visualDirection,
    assetType: patch.assetType !== undefined ? patch.assetType : scene.assetType,
    assetRef: patch.assetRef !== undefined ? patch.assetRef : scene.assetRef,
    imageAssetId: patch.imageAssetId !== undefined ? patch.imageAssetId : scene.imageAssetId,
    imageFraming: patch.imageFraming !== undefined ? patch.imageFraming : scene.imageFraming,
    onScreenText: patch.onScreenText !== undefined ? patch.onScreenText : scene.onScreenText,
    plannedDuration:
      patch.plannedDuration !== undefined
        ? clampPlannedDuration(patch.plannedDuration)
        : scene.plannedDuration,
    // Editing approved content returns the scene to draft so approval means something.
    status: contentChanged && scene.status === 'approved' ? 'draft' : scene.status,
  };

  return withScenes(
    project,
    project.storyboard.scenes.map((candidate) => (candidate.id === sceneId ? next : candidate)),
    now,
  );
}

export function moveScene(
  project: Project,
  sceneId: string,
  direction: -1 | 1,
  now: string = nowIso(),
): Project {
  const { index } = findScene(project, sceneId);
  const target = index + direction;
  if (target < 0 || target >= project.storyboard.scenes.length) return project;
  const scenes = [...project.storyboard.scenes];
  const [moved] = scenes.splice(index, 1);
  scenes.splice(target, 0, moved as Scene);
  return withScenes(project, scenes, now);
}

export function setSceneLocks(
  project: Project,
  sceneId: string,
  patch: Partial<Record<SceneLockKey, boolean>>,
  now: string = nowIso(),
): Project {
  const { scene } = findScene(project, sceneId);
  const locks = { ...scene.locks, ...patch };
  if (
    locks.narration === scene.locks.narration &&
    locks.visuals === scene.locks.visuals &&
    locks.text === scene.locks.text &&
    locks.timing === scene.locks.timing
  ) {
    return project;
  }
  return withScenes(
    project,
    project.storyboard.scenes.map((candidate) =>
      candidate.id === sceneId ? { ...candidate, locks } : candidate,
    ),
    now,
  );
}

export function setSceneStatus(
  project: Project,
  sceneId: string,
  status: SceneStatus,
  now: string = nowIso(),
): Project {
  const { scene } = findScene(project, sceneId);
  if (scene.status === status) return project;
  return withScenes(
    project,
    project.storyboard.scenes.map((candidate) =>
      candidate.id === sceneId ? { ...candidate, status } : candidate,
    ),
    now,
  );
}

/**
 * Record that the user reviewed this storyboard against the current script.
 * This only stamps the fingerprint; it never rewrites or synchronizes scenes.
 */
export function markStoryboardReviewed(project: Project, now: string = nowIso()): Project {
  return touch(
    {
      ...project,
      storyboard: {
        ...project.storyboard,
        reviewedScriptFingerprint: project.script.fingerprint,
        reviewedAt: now,
      },
    },
    now,
  );
}
