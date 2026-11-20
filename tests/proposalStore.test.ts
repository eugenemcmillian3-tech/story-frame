import { beforeEach, describe, expect, it } from 'vitest';
import { loadProposals } from '../src/ai/proposalStore';
import type { AngleProposal, ProjectProposals } from '../src/ai/types';
import { MemoryStorage } from './helpers';

const NOW = '2026-01-01T00:00:00.000Z';
const KEY = 'storyframe.v1.ai-proposals:prj_1';

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
});

function angleDraft(id: string): AngleProposal {
  return {
    status: 'draft',
    model: 'deepseek-v4.1-flash',
    inputFingerprint: `fnv1a:${id}:1`,
    angles: [1, 2, 3].map((index) => ({
      id: `${id}_${index}`,
      title: `${id} direction ${index}`,
      hook: `${id} hook ${index}`,
      approach: `${id} approach ${index}`,
      explanation: `${id} explanation ${index}`,
    })),
    selectedAngleId: null,
    generatedAt: NOW,
    editedAt: null,
  };
}

function stored(previousAngles: unknown): string {
  const proposals = {
    version: 1,
    projectId: 'prj_1',
    updatedAt: NOW,
    angles: angleDraft('current'),
    script: null,
    storyboard: null,
    previousAngles,
    previousStoryboard: null,
  } as ProjectProposals;
  return JSON.stringify(proposals);
}

describe('stored previous angle drafts', () => {
  it('loads a valid previous draft', () => {
    storage.setItem(KEY, stored(angleDraft('previous')));
    const { proposals, error } = loadProposals('prj_1', NOW);
    expect(error).toBeNull();
    expect(proposals.previousAngles?.angles[0].title).toBe('previous direction 1');
  });

  it('drops an invalid previous draft without discarding the current angles', () => {
    storage.setItem(KEY, stored({ angles: 'not a list' }));
    const { proposals, error } = loadProposals('prj_1', NOW);
    expect(error).toBeNull();
    expect(proposals.previousAngles).toBeNull();
    expect(proposals.angles?.angles[0].title).toBe('current direction 1');
  });

  it('still sets aside the whole record when the current angles are invalid', () => {
    storage.setItem(KEY, JSON.stringify({ ...JSON.parse(stored(null)), angles: { angles: [] } }));
    const { proposals, error } = loadProposals('prj_1', NOW);
    expect(error).toContain('invalid');
    expect(proposals.angles).toBeNull();
  });
});
