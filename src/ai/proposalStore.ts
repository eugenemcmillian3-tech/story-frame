import { browserStorage, isQuotaError } from '../persistence/storage';
import { DEFAULT_AI_MODEL, isAiModelId } from './models';
import type { AiModelId } from './models';
import { emptyProposals } from './types';
import type { AngleProposal, ProjectProposals, StoryboardProposal } from './types';

function storedModel(value: Record<string, unknown>): AiModelId {
  return isAiModelId(value.model) ? value.model : DEFAULT_AI_MODEL;
}

const KEY_PREFIX = 'storyframe.v1.ai-proposals:';

function keyFor(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAngleProposal(value: unknown): AngleProposal | null {
  if (!isRecord(value)) return null;
  if (value.status !== 'draft' && value.status !== 'discarded') return null;
  if (typeof value.inputFingerprint !== 'string') return null;
  if (!Array.isArray(value.angles) || value.angles.length !== 3) return null;
  return { ...value, model: storedModel(value) } as AngleProposal;
}

function readStoryboardProposal(value: unknown): StoryboardProposal | null {
  if (!isRecord(value)) return null;
  if (!['draft', 'accepted', 'discarded'].includes(String(value.status))) return null;
  if (typeof value.inputFingerprint !== 'string') return null;
  if (!Array.isArray(value.scenes)) return null;
  return { ...value, model: storedModel(value) } as StoryboardProposal;
}

function highLevelShape(value: unknown, projectId: string): ProjectProposals | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1 || value.projectId !== projectId) return null;
  if (typeof value.updatedAt !== 'string') return null;
  const angles = value.angles === null ? null : readAngleProposal(value.angles);
  if (value.angles !== null && angles === null) return null;
  const script = value.script;
  if (
    script !== null &&
    (!isRecord(script) ||
      !['draft', 'accepted', 'discarded'].includes(String(script.status)) ||
      (script.mode !== 'script' && script.mode !== 'outline') ||
      typeof script.inputFingerprint !== 'string' ||
      !Array.isArray(script.segments) ||
      !Array.isArray(script.outline) ||
      !Array.isArray(script.missingInformation))
  ) {
    return null;
  }
  const storyboard = value.storyboard === null ? null : readStoryboardProposal(value.storyboard);
  if (value.storyboard !== null && storyboard === null) return null;
  return {
    version: 1,
    projectId,
    updatedAt: value.updatedAt,
    angles,
    script: script === null ? null : { ...script, model: storedModel(script) } as ProjectProposals['script'],
    storyboard,
    previousAngles: readAngleProposal(value.previousAngles),
    previousStoryboard: readStoryboardProposal(value.previousStoryboard),
  };
}

export function loadProposals(
  projectId: string,
  now = new Date().toISOString(),
): { proposals: ProjectProposals; error: string | null } {
  const storage = browserStorage();
  if (!storage) {
    return {
      proposals: emptyProposals(projectId, now),
      error: 'Browser storage is unavailable, so AI proposals cannot be kept separately.',
    };
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(keyFor(projectId));
  } catch {
    return {
      proposals: emptyProposals(projectId, now),
      error: 'Stored AI proposals could not be read.',
    };
  }
  if (raw === null) return { proposals: emptyProposals(projectId, now), error: null };
  try {
    const parsed = highLevelShape(JSON.parse(raw) as unknown, projectId);
    if (!parsed) {
      return {
        proposals: emptyProposals(projectId, now),
        error: 'Stored AI proposals were invalid and were set aside. Accepted project content is unchanged.',
      };
    }
    return { proposals: parsed, error: null };
  } catch {
    return {
      proposals: emptyProposals(projectId, now),
      error: 'Stored AI proposals were not readable and were set aside. Accepted project content is unchanged.',
    };
  }
}

export function saveProposals(proposals: ProjectProposals): { ok: boolean; error: string | null } {
  const storage = browserStorage();
  if (!storage) {
    return { ok: false, error: 'Browser storage is unavailable, so this proposal cannot be kept.' };
  }
  try {
    storage.setItem(keyFor(proposals.projectId), JSON.stringify(proposals));
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: isQuotaError(error)
        ? 'Browser storage is full, so the proposal was not saved. Your accepted project is unchanged.'
        : 'The proposal could not be saved in this browser. Your accepted project is unchanged.',
    };
  }
}
