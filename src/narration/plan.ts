import { DomainError } from '../domain/errors';
import type { NarrationTake, Project } from '../domain/types';

export type NarrationStatus = 'none' | 'current' | 'stale';

/**
 * A take is stale when the saved script no longer fingerprints to the text it
 * was generated from. Nothing regenerates automatically: the caller only reports.
 */
export function narrationStatus(
  take: NarrationTake | null | undefined,
  scriptFingerprint: string,
): NarrationStatus {
  if (!take) return 'none';
  return take.scriptFingerprint === scriptFingerprint ? 'current' : 'stale';
}

export interface NarrationTiming {
  measuredMs: number;
  plannedMs: number;
  deltaMs: number;
  /** Scenes whose timing lock keeps their planned duration fixed. */
  lockedScenes: number;
  unlockedScenes: number;
}

export function compareNarrationToScenes(
  project: Project,
  measuredMs: number,
): NarrationTiming {
  const plannedMs =
    project.storyboard.scenes.reduce((total, scene) => total + scene.plannedDuration, 0) * 1000;
  return {
    measuredMs,
    plannedMs,
    deltaMs: measuredMs - plannedMs,
    lockedScenes: project.storyboard.scenes.filter((scene) => scene.locks.timing).length,
    unlockedScenes: project.storyboard.scenes.filter((scene) => !scene.locks.timing).length,
  };
}

/**
 * Rescale unlocked scene durations so the storyboard matches the measured
 * narration. Locked scenes keep their exact planned duration; the rest share
 * what is left in proportion to their current lengths, rounded to whole seconds.
 * Throws instead of guessing when the locked timing leaves no room.
 */
export function fitUnlockedSceneDurations(
  project: Project,
  measuredMs: number,
  now: string,
): { project: Project; changedScenes: number } {
  const scenes = project.storyboard.scenes;
  if (scenes.length === 0) {
    throw new DomainError('invalid-value', 'Add storyboard scenes before fitting their timing.');
  }
  if (!Number.isFinite(measuredMs) || measuredMs <= 0) {
    throw new DomainError('invalid-value', 'The narration has no measured duration to fit.');
  }
  const unlocked = scenes.filter((scene) => !scene.locks.timing);
  if (unlocked.length === 0) {
    throw new DomainError(
      'scene-locked',
      'Every scene has locked timing, so nothing can be adjusted. Unlock a scene first.',
    );
  }
  const lockedSeconds = scenes
    .filter((scene) => scene.locks.timing)
    .reduce((total, scene) => total + scene.plannedDuration, 0);
  const targetSeconds = Math.round(measuredMs / 1000);
  const availableSeconds = targetSeconds - lockedSeconds;
  if (availableSeconds < unlocked.length) {
    throw new DomainError(
      'invalid-value',
      `The narration is ${targetSeconds}s long but locked scenes already reserve ${lockedSeconds}s. Unlock timing or shorten the script.`,
    );
  }

  const unlockedTotal = unlocked.reduce((total, scene) => total + scene.plannedDuration, 0);
  const exact = unlocked.map((scene) => ({
    sceneId: scene.id,
    share: unlockedTotal > 0 ? availableSeconds * (scene.plannedDuration / unlockedTotal) : 0,
  }));
  const allotted = exact.map((entry) => ({
    sceneId: entry.sceneId,
    seconds: Math.max(1, Math.floor(entry.share)),
    remainder: entry.share - Math.floor(entry.share),
  }));
  let leftover = availableSeconds - allotted.reduce((total, entry) => total + entry.seconds, 0);
  const byRemainder = [...allotted].sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; leftover > 0; index += 1) {
    byRemainder[index % byRemainder.length].seconds += 1;
    leftover -= 1;
  }

  const durations = new Map(allotted.map((entry) => [entry.sceneId, entry.seconds]));
  let changedScenes = 0;
  const nextScenes = scenes.map((scene) => {
    const seconds = durations.get(scene.id);
    if (seconds === undefined || seconds === scene.plannedDuration) return scene;
    changedScenes += 1;
    return { ...scene, plannedDuration: seconds };
  });
  if (changedScenes === 0) return { project, changedScenes };
  return {
    project: {
      ...project,
      storyboard: { ...project.storyboard, scenes: nextScenes },
      updatedAt: now,
    },
    changedScenes,
  };
}
