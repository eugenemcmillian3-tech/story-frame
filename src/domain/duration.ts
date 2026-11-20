import { NARRATION_WORDS_PER_MINUTE, durationVarianceThreshold } from './constants';
import type { Project } from './types';

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

/** Estimated runtime from word count. This is not measured audio. */
export function estimateRuntimeSeconds(
  text: string,
  wordsPerMinute: number = NARRATION_WORDS_PER_MINUTE,
): number {
  const words = countWords(text);
  if (words === 0) return 0;
  return Math.round((words / wordsPerMinute) * 60);
}

export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

export function totalPlannedDuration(project: Project): number {
  return project.storyboard.scenes.reduce((total, scene) => {
    const value = Number.isFinite(scene.plannedDuration) ? scene.plannedDuration : 0;
    return total + Math.max(0, value);
  }, 0);
}

export function durationVariance(project: Project): number {
  return totalPlannedDuration(project) - project.brief.targetDuration;
}

/** True when the planned total materially differs from the brief's target. */
export function isDurationVarianceMaterial(project: Project): boolean {
  const threshold = durationVarianceThreshold(project.brief.targetDuration);
  return Math.abs(durationVariance(project)) > threshold;
}

export function clampPlannedDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(600, Math.max(0, Math.round(value)));
}
