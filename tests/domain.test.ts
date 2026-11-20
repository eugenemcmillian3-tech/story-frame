import { describe, expect, it } from 'vitest';
import { DomainError, LockedFieldsError } from '../src/domain/errors';
import {
  createProject,
  duplicateProject,
  renameProject,
  replaceScriptNarration,
  setScriptLock,
} from '../src/domain/project';
import {
  addScene,
  deleteScene,
  duplicateScene,
  markStoryboardReviewed,
  moveScene,
  setSceneLocks,
  setSceneStatus,
  updateScene,
} from '../src/domain/storyboard';
import { getStoryboardReview } from '../src/domain/staleness';
import { isDurationVarianceMaterial, totalPlannedDuration } from '../src/domain/duration';
import { SCHEMA_VERSION } from '../src/domain/types';
import type { Project } from '../src/domain/types';

const NOW = '2026-01-01T00:00:00.000Z';

function makeProject(): Project {
  return createProject(
    {
      title: 'Locks and revisions',
      mode: 'factual',
      targetDuration: 45,
      visualPreset: 'clean-educational',
    },
    { now: NOW, id: 'prj_test' },
  );
}

function withScene(project: Project, duration = 10): { project: Project; sceneId: string } {
  const next = addScene(project, { title: 'Scene', plannedDuration: duration }, NOW);
  const scene = next.storyboard.scenes.at(-1);
  if (!scene) throw new Error('scene was not added');
  return { project: next, sceneId: scene.id };
}

describe('project creation', () => {
  it('creates a versioned project with a stable id and no duplicate ids', () => {
    const project = makeProject();
    expect(project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(project.id).toBe('prj_test');
    expect(project.brief.targetDuration).toBe(45);
    expect(project.script.narration).toBe('');
    expect(project.storyboard.scenes).toHaveLength(0);
    expect(project.contentRevision).toBe(0);
  });
});

describe('lock enforcement in the domain', () => {
  it('rejects changes to locked scene components even through direct mutations', () => {
    const { project, sceneId } = withScene(makeProject());
    const locked = setSceneLocks(project, sceneId, { narration: true }, NOW);

    expect(() => updateScene(locked, sceneId, { narration: 'New line' }, NOW)).toThrow(
      LockedFieldsError,
    );

    // Unlocked components still change.
    const visualChanged = updateScene(locked, sceneId, { visualDirection: 'Cut wide' }, NOW);
    expect(visualChanged.storyboard.scenes[0]?.visualDirection).toBe('Cut wide');

    // Unlocking restores editing.
    const unlocked = setSceneLocks(visualChanged, sceneId, { narration: false }, NOW);
    const narrated = updateScene(unlocked, sceneId, { narration: 'New line' }, NOW);
    expect(narrated.storyboard.scenes[0]?.narration).toBe('New line');
  });

  it('treats image attachment, removal, and framing as visuals-locked fields', () => {
    const { project, sceneId } = withScene(makeProject());
    const locked = setSceneLocks(project, sceneId, { visuals: true }, NOW);

    expect(() => updateScene(locked, sceneId, { imageAssetId: 'img_1' }, NOW)).toThrow(
      LockedFieldsError,
    );
    expect(() => updateScene(locked, sceneId, { imageFraming: 'fill' }, NOW)).toThrow(
      LockedFieldsError,
    );

    const attached = updateScene(project, sceneId, { imageAssetId: 'img_1' }, NOW);
    expect(attached.storyboard.scenes[0]?.imageAssetId).toBe('img_1');
    const framed = updateScene(attached, sceneId, { imageFraming: 'fill' }, NOW);
    expect(framed.storyboard.scenes[0]?.imageFraming).toBe('fill');
  });

  it('allows writing the same value into a locked component', () => {
    const { project, sceneId } = withScene(makeProject());
    const locked = setSceneLocks(project, sceneId, { timing: true }, NOW);
    const unchanged = updateScene(locked, sceneId, { plannedDuration: 10 }, NOW);
    expect(unchanged).toBe(locked);
  });

  it('rejects script edits while the script is locked', () => {
    const project = replaceScriptNarration(makeProject(), 'First draft.', { now: NOW });
    const locked = setScriptLock(project, true, NOW);

    let thrown: unknown;
    try {
      replaceScriptNarration(locked, 'Second draft.', { now: NOW });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('script-locked');

    const unlocked = setScriptLock(locked, false, NOW);
    expect(replaceScriptNarration(unlocked, 'Second draft.', { now: NOW }).script.narration).toBe(
      'Second draft.',
    );
  });

  it('keeps approved scenes approved when only metadata changes', () => {
    const { project, sceneId } = withScene(makeProject());
    const approved = setSceneStatus(project, sceneId, 'approved', NOW);
    const retitled = updateScene(approved, sceneId, { title: 'Better title' }, NOW);
    expect(retitled.storyboard.scenes[0]?.status).toBe('approved');
  });

  it('returns an approved scene to draft when its content changes', () => {
    const { project, sceneId } = withScene(makeProject());
    const approved = setSceneStatus(project, sceneId, 'approved', NOW);
    const edited = updateScene(approved, sceneId, { onScreenText: 'New caption' }, NOW);
    expect(edited.storyboard.scenes[0]?.status).toBe('draft');
  });
});

describe('identifier uniqueness', () => {
  it('shares an attached image between a scene and its duplicate', () => {
    const { project, sceneId } = withScene(makeProject());
    const attached = updateScene(
      project,
      sceneId,
      { imageAssetId: 'img_shared', imageFraming: 'fill' },
      NOW,
    );
    const duplicated = duplicateScene(attached, sceneId, NOW);
    expect(duplicated.storyboard.scenes).toHaveLength(2);
    expect(duplicated.storyboard.scenes[1]?.imageAssetId).toBe('img_shared');
    expect(duplicated.storyboard.scenes[1]?.imageFraming).toBe('fill');
  });

  it('gives a duplicated project a new project id and new scene ids', () => {
    let project = renameProject(makeProject(), 'Original', NOW);
    project = { ...project, storyboard: { ...project.storyboard, scenes: [] } };
    const first = addScene(project, { title: 'One' }, NOW);
    const second = addScene(first, { title: 'Two' }, NOW);
    const copy = duplicateProject(second, { now: NOW, id: 'prj_copy' });

    expect(copy.id).toBe('prj_copy');
    expect(copy.id).not.toBe(second.id);

    const originalIds = second.storyboard.scenes.map((scene) => scene.id);
    const copyIds = copy.storyboard.scenes.map((scene) => scene.id);
    expect(new Set(copyIds).size).toBe(copyIds.length);
    for (const id of copyIds) expect(originalIds).not.toContain(id);
  });

  it('gives a duplicated scene a new id placed after the original', () => {
    const { project, sceneId } = withScene(makeProject());
    const duplicated = duplicateScene(project, sceneId, NOW);
    const ids = duplicated.storyboard.scenes.map((scene) => scene.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(sceneId);
    expect(ids[1]).not.toBe(sceneId);
    expect(duplicated.storyboard.scenes[1]?.status).toBe('draft');
  });
});

describe('storyboard review tracking', () => {
  it('marks reviewed only for the exact current script content', () => {
    const project = replaceScriptNarration(makeProject(), 'Original narration.', { now: NOW });
    expect(getStoryboardReview(project).status).toBe('unreviewed');

    const reviewed = markStoryboardReviewed(project, NOW);
    expect(getStoryboardReview(reviewed).status).toBe('current');
    expect(reviewed.storyboard.reviewedScriptFingerprint).toBe(reviewed.script.fingerprint);
  });

  it('invalidates review on every keystroke inside one typing burst', () => {
    const project = replaceScriptNarration(makeProject(), 'Original narration.', { now: NOW });
    const reviewed = markStoryboardReviewed(project, NOW);

    let current = reviewed;
    const burst = ' More words typed quickly.';
    for (const character of burst) {
      current = replaceScriptNarration(current, `${current.script.narration}${character}`, {
        now: NOW,
      });
      expect(getStoryboardReview(current).status).toBe('stale');
      expect(current.storyboard.reviewedScriptFingerprint).not.toBe(current.script.fingerprint);
    }
  });

  it('does not rewrite scene content when marking review', () => {
    const { project, sceneId } = withScene(makeProject(), 12);
    const narrated = updateScene(project, sceneId, { narration: 'Scene line' }, NOW);
    const reviewed = markStoryboardReviewed(narrated, NOW);
    expect(reviewed.storyboard.scenes).toEqual(narrated.storyboard.scenes);
  });
});

describe('planned duration', () => {
  it('totals planned durations and follows edits, reorders, and deletes', () => {
    let project = makeProject();
    project = addScene(project, { title: 'A', plannedDuration: 10 }, NOW);
    project = addScene(project, { title: 'B', plannedDuration: 12 }, NOW);
    project = addScene(project, { title: 'C', plannedDuration: 13 }, NOW);
    expect(totalPlannedDuration(project)).toBe(35);

    const firstId = project.storyboard.scenes[0]?.id as string;
    project = updateScene(project, firstId, { plannedDuration: 15 }, NOW);
    expect(totalPlannedDuration(project)).toBe(40);

    const beforeMove = totalPlannedDuration(project);
    project = moveScene(project, project.storyboard.scenes[2]?.id as string, -1, NOW);
    expect(project.storyboard.scenes.map((scene) => scene.title)).toEqual(['A', 'C', 'B']);
    expect(totalPlannedDuration(project)).toBe(beforeMove);

    project = deleteScene(project, firstId, NOW);
    expect(totalPlannedDuration(project)).toBe(25);
  });

  it('flags only material differences from the brief target', () => {
    let project = addScene(makeProject(), { plannedDuration: 40 }, NOW);
    expect(isDurationVarianceMaterial(project)).toBe(false);

    const sceneId = project.storyboard.scenes[0]?.id as string;
    project = updateScene(project, sceneId, { plannedDuration: 39 }, NOW);
    expect(isDurationVarianceMaterial(project)).toBe(true);
  });

  it('clamps invalid planned durations instead of storing nonsense', () => {
    const { project, sceneId } = withScene(makeProject());
    const updated = updateScene(project, sceneId, { plannedDuration: Number.NaN }, NOW);
    expect(updated.storyboard.scenes[0]?.plannedDuration).toBe(0);
  });
});
