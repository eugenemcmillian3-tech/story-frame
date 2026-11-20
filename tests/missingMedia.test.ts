import { describe, expect, it } from 'vitest';
import { createProject, updateAudioTrack } from '../src/domain/project';
import { addScene, updateScene } from '../src/domain/storyboard';
import type { Project } from '../src/domain/types';
import {
  collectMissingMedia,
  describeMissingMedia,
  isEmptyMissingMedia,
} from '../src/media/missingMedia';

const NOW = '2026-01-01T00:00:00.000Z';

function board(): Project {
  let project = createProject(
    { title: 'Missing media', mode: 'factual', targetDuration: 60, visualPreset: 'clean-educational' },
    { now: NOW, id: 'prj_missing' },
  );
  project = addScene(project, { title: 'One', plannedDuration: 10 }, NOW);
  project = addScene(project, { title: 'Two', plannedDuration: 10 }, NOW);
  project = addScene(project, { title: 'Three', plannedDuration: 10 }, NOW);
  const [first, second] = project.storyboard.scenes;
  project = updateScene(project, first.id, { imageAssetId: 'img_a' }, NOW);
  project = updateScene(project, second.id, { imageAssetId: 'img_b' }, NOW);
  return project;
}

describe('missing media', () => {
  it('reports nothing when every referenced image is stored', () => {
    const project = board();
    const report = collectMissingMedia(project, new Set(['img_a', 'img_b']), new Set());
    expect(isEmptyMissingMedia(report)).toBe(true);
    expect(report.sceneIds).toEqual([]);
  });

  it('names the scenes whose image is gone, and ignores scenes with no image', () => {
    const project = board();
    const report = collectMissingMedia(project, new Set(['img_a']), new Set());
    expect(report.sceneIds).toEqual([project.storyboard.scenes[1].id]);
    expect(report.audioRoles).toEqual([]);
    expect(isEmptyMissingMedia(report)).toBe(false);
  });

  it('reports an already-empty project as complete', () => {
    const project = board();
    const withoutImages = project.storyboard.scenes.reduce(
      (current, scene) => updateScene(current, scene.id, { imageAssetId: null }, NOW),
      project,
    );
    expect(isEmptyMissingMedia(collectMissingMedia(withoutImages, new Set(), new Set()))).toBe(true);
  });

  it('reports audio whose file is gone', () => {
    const project = updateAudioTrack(
      board(),
      'narration',
      { assetId: 'aud_a', fileName: 'narration.wav', durationMs: 30000 },
      NOW,
    );
    expect(collectMissingMedia(project, new Set(['img_a', 'img_b']), new Set())).toEqual({
      sceneIds: [],
      audioRoles: ['narration'],
    });
  });

  it('spells out counts and the recovery step', () => {
    const project = board();
    const message = describeMissingMedia(
      { sceneIds: [project.storyboard.scenes[0].id, project.storyboard.scenes[2].id], audioRoles: ['music'] },
      project.storyboard.scenes.length,
    );
    expect(message).toContain('2 of 3 scene images are missing from this browser');
    expect(message).toContain('background music audio is missing');
    expect(message).toContain('The project itself is still here');
  });

  it('uses the singular for one missing image', () => {
    const project = board();
    const message = describeMissingMedia(
      { sceneIds: [project.storyboard.scenes[0].id], audioRoles: [] },
      project.storyboard.scenes.length,
    );
    expect(message).toContain('1 of 3 scene images is missing from this browser');
  });
});
