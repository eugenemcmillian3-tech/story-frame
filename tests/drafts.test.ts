import { describe, expect, it } from 'vitest';
import {
  discardAngles,
  discardStoryboard,
  restorePreviousAnglesDraft,
  restorePreviousStoryboardDraft,
  rotateAngles,
  rotateStoryboard,
} from '../src/ai/drafts';
import { emptyProposals } from '../src/ai/types';
import type { AngleProposal, ProjectProposals, StoryboardProposal } from '../src/ai/types';

const NOW = '2026-01-01T00:00:00.000Z';

function angleDraft(id: string): AngleProposal {
  return {
    status: 'draft',
    model: 'deepseek-v4.1-flash',
    inputFingerprint: `fnv1a:${id}:1`,
    angles: [1, 2, 3].map((index) => ({
      id: `${id}_${index}`,
      title: `${id} title ${index}`,
      hook: `${id} hook ${index}`,
      approach: `${id} approach ${index}`,
      explanation: `${id} explanation ${index}`,
    })),
    selectedAngleId: null,
    generatedAt: NOW,
    editedAt: null,
  };
}

function storyboardDraft(id: string): StoryboardProposal {
  return {
    status: 'draft',
    model: 'deepseek-v4.1-flash',
    inputFingerprint: `fnv1a:${id}:1`,
    scriptFingerprint: 'fnv1a:script:1',
    scenes: [
      {
        id: `${id}_1`,
        title: `${id} scene`,
        narration: `${id} narration`,
        visualDirection: 'Close on the front wheel.',
        assetType: 'image',
        onScreenText: '',
        plannedDuration: 20,
      },
    ],
    warnings: [],
    generatedAt: NOW,
    editedAt: null,
  };
}

const start = (): ProjectProposals => emptyProposals('prj_1', NOW);

describe('angle draft rotation', () => {
  it('keeps the replaced draft as the previous draft', () => {
    const first = angleDraft('first');
    const second = angleDraft('second');
    const rotated = rotateAngles({ ...start(), angles: first }, second);
    expect(rotated.angles).toBe(second);
    expect(rotated.previousAngles).toBe(first);
  });

  it('keeps only the most recently replaced draft', () => {
    const first = angleDraft('first');
    const second = angleDraft('second');
    const third = angleDraft('third');
    const rotated = rotateAngles(rotateAngles({ ...start(), angles: first }, second), third);
    expect(rotated.angles).toBe(third);
    expect(rotated.previousAngles).toBe(second);
  });

  it('does not erase a stored draft when there is no current draft to replace', () => {
    const previous = angleDraft('previous');
    const next = angleDraft('next');
    const rotated = rotateAngles({ ...start(), previousAngles: previous }, next);
    expect(rotated.angles).toBe(next);
    expect(rotated.previousAngles).toBe(previous);
  });

  it('starts with no previous draft', () => {
    const rotated = rotateAngles(start(), angleDraft('first'));
    expect(rotated.previousAngles).toBeNull();
  });
});

describe('discarding and restoring angle drafts', () => {
  function twoDrafts() {
    const current = angleDraft('current');
    const previous = angleDraft('previous');
    return { current, previous, proposals: { ...start(), angles: current, previousAngles: previous } };
  }

  it('keeps the previous draft when the current angles are discarded', () => {
    const { previous, proposals } = twoDrafts();
    const discarded = discardAngles(proposals);
    expect(discarded.angles).toBeNull();
    expect(discarded.previousAngles).toBe(previous);
  });

  it('restores the stored draft after the current angles were discarded', () => {
    const { previous, proposals } = twoDrafts();
    const restored = restorePreviousAnglesDraft(discardAngles(proposals));
    expect(restored?.angles).toBe(previous);
    expect(restored?.previousAngles).toBeNull();
  });

  it('swaps the drafts so a restore can be undone', () => {
    const { current, previous, proposals } = twoDrafts();
    const restored = restorePreviousAnglesDraft(proposals);
    expect(restored?.angles).toBe(previous);
    expect(restored?.previousAngles).toBe(current);
    const back = restored ? restorePreviousAnglesDraft(restored) : null;
    expect(back?.angles).toBe(current);
    expect(back?.previousAngles).toBe(previous);
  });

  it('reports nothing to restore when no draft is stored', () => {
    expect(restorePreviousAnglesDraft(start())).toBeNull();
  });
});

describe('storyboard draft rotation', () => {
  it('keeps the replaced draft as the previous draft', () => {
    const first = storyboardDraft('first');
    const second = storyboardDraft('second');
    const rotated = rotateStoryboard({ ...start(), storyboard: first }, second);
    expect(rotated.storyboard).toBe(second);
    expect(rotated.previousStoryboard).toBe(first);
  });

  it('keeps the stored draft when the current storyboard is generated with none present', () => {
    const previous = storyboardDraft('previous');
    const next = storyboardDraft('next');
    const rotated = rotateStoryboard({ ...start(), previousStoryboard: previous }, next);
    expect(rotated.previousStoryboard).toBe(previous);
  });

  it('discards the current storyboard without losing the previous draft', () => {
    const current = storyboardDraft('current');
    const previous = storyboardDraft('previous');
    const discarded = discardStoryboard({ ...start(), storyboard: current, previousStoryboard: previous });
    expect(discarded.storyboard).toBeNull();
    expect(discarded.previousStoryboard).toBe(previous);
  });

  it('restores the previous storyboard draft and can swap back', () => {
    const current = storyboardDraft('current');
    const previous = storyboardDraft('previous');
    const restored = restorePreviousStoryboardDraft({
      ...start(),
      storyboard: current,
      previousStoryboard: previous,
    });
    expect(restored?.storyboard).toBe(previous);
    expect(restored?.previousStoryboard).toBe(current);
  });

  it('reports nothing to restore when no draft is stored', () => {
    expect(restorePreviousStoryboardDraft(start())).toBeNull();
  });
});
