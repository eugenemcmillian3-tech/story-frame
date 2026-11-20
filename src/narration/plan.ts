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
  let plannedSeconds = 0;
  let lockedScenes = 0;
  for (const scene of project.storyboard.scenes) {
    plannedSeconds += scene.plannedDuration;
    if (scene.locks.timing) lockedScenes += 1;
  }
  const plannedMs = plannedSeconds * 1000;
  return {
    measuredMs,
    plannedMs,
    deltaMs: measuredMs - plannedMs,
    lockedScenes,
    unlockedScenes: project.storyboard.scenes.length - lockedScenes,
  };
}

/**
 * Rescale unlocked scene durations so the storyboard matches the measured
 * narration. Locked scenes keep their exact planned duration; each unlocked
 * scene keeps a one-second floor and the rest is shared in proportion to its
 * current length, rounded to whole seconds. Throws instead of guessing when the
 * locked timing leaves no room.
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

  const extraSeconds = availableSeconds - unlocked.length;
  const unlockedTotal = unlocked.reduce((total, scene) => total + scene.plannedDuration, 0);
  const shares = unlocked.map((scene) => {
    const fraction =
      unlockedTotal > 0 ? scene.plannedDuration / unlockedTotal : 1 / unlocked.length;
    const share = extraSeconds * fraction;
    return { sceneId: scene.id, share, seconds: 1 + Math.floor(share) };
  });

  // Hand out the seconds lost to rounding, largest remainder first.
  let leftover = extraSeconds - shares.reduce((total, entry) => total + Math.floor(entry.share), 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)),
  );
  for (let index = 0; leftover > 0; index += 1) {
    byRemainder[index % byRemainder.length].seconds += 1;
    leftover -= 1;
  }

  const durations = new Map(shares.map((entry) => [entry.sceneId, entry.seconds]));
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
