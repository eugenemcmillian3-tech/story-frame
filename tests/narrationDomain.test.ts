import { describe, expect, it } from 'vitest';
import { createProject, updateAudioTrack } from '../src/domain/project';
import { addScene, setSceneLocks, updateScene } from '../src/domain/storyboard';
import type { NarrationTake, Project } from '../src/domain/types';
import { parseProjectJson } from '../src/domain/validation';
import {
  compareNarrationToScenes,
  fitUnlockedSceneDurations,
  narrationStatus,
} from '../src/narration/plan';
import {
  SAMPLE_MAX_CHARACTERS,
  buildSampleText,
  estimateNarrationUsd,
  isNarrationVoice,
} from '../src/narration/provider';

const NOW = '2026-01-01T00:00:00.000Z';

const TAKE: NarrationTake = {
  provider: 'Deepgram',
  model: 'aura-1',
  voice: 'aura-luna-en',
  scriptFingerprint: 'fnv1a:deadbeef:12',
  characters: 120,
  estimatedUsd: 0.0018,
  jobId: 'nar_test',
  generatedAt: NOW,
};

function board(): Project {
  let project = createProject(
    { title: 'Narration', mode: 'factual', targetDuration: 60, visualPreset: 'clean-educational' },
    { now: NOW, id: 'prj_narr' },
  );
  project = addScene(project, { title: 'One', plannedDuration: 10 }, NOW);
  project = addScene(project, { title: 'Two', plannedDuration: 20 }, NOW);
  project = addScene(project, { title: 'Three', plannedDuration: 30 }, NOW);
  return project;
}

describe('narration provider facts', () => {
  it('prices characters from the published list price', () => {
    expect(estimateNarrationUsd(1000)).toBe(0.015);
    expect(estimateNarrationUsd(500)).toBe(0.0075);
    expect(estimateNarrationUsd(0)).toBe(0);
  });

  it('accepts only the speakers the provider documents', () => {
    expect(isNarrationVoice('aura-luna-en')).toBe(true);
    expect(isNarrationVoice('aura-angus-en')).toBe(true);
    expect(isNarrationVoice('not-a-voice')).toBe(false);
  });

  it('cuts a sample at a word boundary', () => {
    const long = 'word '.repeat(200).trim();
    const sample = buildSampleText(long);
    expect(sample.length).toBeLessThanOrEqual(SAMPLE_MAX_CHARACTERS);
    expect(sample.endsWith('word')).toBe(true);
    expect(buildSampleText('Short line.')).toBe('Short line.');
  });
});

describe('narration staleness', () => {
  it('is current only while the fingerprint still matches', () => {
    expect(narrationStatus(null, 'fnv1a:aaa:1')).toBe('none');
    expect(narrationStatus(TAKE, TAKE.scriptFingerprint)).toBe('current');
    expect(narrationStatus(TAKE, 'fnv1a:aaa:2')).toBe('stale');
  });
});

describe('narration timing', () => {
  it('compares measured audio with the planned scene total', () => {
    const timing = compareNarrationToScenes(board(), 65_000);
    expect(timing.plannedMs).toBe(60_000);
    expect(timing.deltaMs).toBe(5_000);
    expect(timing.unlockedScenes).toBe(3);
    expect(timing.lockedScenes).toBe(0);
  });

  it('rescaled unlocked scenes total the measured narration', () => {
    const project = board();
    const { project: fitted, changedScenes } = fitUnlockedSceneDurations(project, 90_000, NOW);
    expect(changedScenes).toBe(3);
    const total = fitted.storyboard.scenes.reduce((sum, scene) => sum + scene.plannedDuration, 0);
    expect(total).toBe(90);
  });

  it('never changes a scene whose timing is locked', () => {
    let project = board();
    const locked = project.storyboard.scenes[0];
    project = setSceneLocks(project, locked.id, { ...locked.locks, timing: true }, NOW);
    const { project: fitted } = fitUnlockedSceneDurations(project, 90_000, NOW);
    expect(fitted.storyboard.scenes[0].plannedDuration).toBe(locked.plannedDuration);
    const total = fitted.storyboard.scenes.reduce((sum, scene) => sum + scene.plannedDuration, 0);
    expect(total).toBe(90);
  });

  it('keeps every unlocked scene at least a second when the narration is short', () => {
    let project = board();
    const [first, second, third] = project.storyboard.scenes;
    project = updateScene(project, first.id, { plannedDuration: 1 }, NOW);
    project = updateScene(project, second.id, { plannedDuration: 1 }, NOW);
    project = updateScene(project, third.id, { plannedDuration: 98 }, NOW);
    const { project: fitted } = fitUnlockedSceneDurations(project, 5_000, NOW);
    const total = fitted.storyboard.scenes.reduce((sum, scene) => sum + scene.plannedDuration, 0);
    expect(total).toBe(5);
    expect(fitted.storyboard.scenes.every((scene) => scene.plannedDuration >= 1)).toBe(true);
  });

  it('splits evenly when the unlocked scenes have no length to scale', () => {
    let project = board();
    for (const scene of project.storyboard.scenes) {
      project = updateScene(project, scene.id, { plannedDuration: 0 }, NOW);
    }
    const { project: fitted } = fitUnlockedSceneDurations(project, 9_000, NOW);
    expect(fitted.storyboard.scenes.map((scene) => scene.plannedDuration)).toEqual([3, 3, 3]);
  });

  it('refuses when every scene is locked', () => {
    let project = board();
    for (const scene of project.storyboard.scenes) {
      project = setSceneLocks(project, scene.id, { ...scene.locks, timing: true }, NOW);
    }
    expect(() => fitUnlockedSceneDurations(project, 90_000, NOW)).toThrow(/locked timing/i);
  });

  it('refuses when the narration cannot cover the locked time', () => {
    let project = board();
    const first = project.storyboard.scenes[0];
    project = updateScene(project, first.id, { plannedDuration: 40 }, NOW);
    project = setSceneLocks(project, first.id, { ...first.locks, timing: true }, NOW);
    expect(() => fitUnlockedSceneDurations(project, 30_000, NOW)).toThrow(/locked scenes already reserve/i);
  });
});

describe('narration take persistence', () => {
  it('round-trips through stored project JSON', () => {
    const project = updateAudioTrack(
      board(),
      'narration',
      { assetId: 'aud_1', fileName: 'narration-luna.mp3', durationMs: 65_000, generated: TAKE },
      NOW,
    );
    const parsed = parseProjectJson(JSON.parse(JSON.stringify(project)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.audio.narration.generated).toEqual(TAKE);
    expect(parsed.value.audio.narration.durationMs).toBe(65_000);
  });

  it('keeps an uploaded track free of generated provenance', () => {
    const project = updateAudioTrack(board(), 'narration', { assetId: 'aud_2', generated: null }, NOW);
    const parsed = parseProjectJson(JSON.parse(JSON.stringify(project)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.audio.narration.generated).toBeNull();
  });
});
