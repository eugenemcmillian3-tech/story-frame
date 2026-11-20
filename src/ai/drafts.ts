import type { AngleProposal, ProjectProposals, StoryboardProposal } from './types';

/**
 * Moves the draft a regeneration replaces into `previous`, which is what makes
 * it comparable and restorable. When there is no current draft — it was
 * discarded — the stored previous draft is kept rather than silently dropped.
 */
export function rotateAngles(
  proposals: ProjectProposals,
  next: AngleProposal | null,
): ProjectProposals {
  return {
    ...proposals,
    angles: next,
    previousAngles: proposals.angles ?? proposals.previousAngles,
  };
}

export function rotateStoryboard(
  proposals: ProjectProposals,
  next: StoryboardProposal | null,
): ProjectProposals {
  return {
    ...proposals,
    storyboard: next,
    previousStoryboard: proposals.storyboard ?? proposals.previousStoryboard,
  };
}

/** Discarding the current draft leaves the previous one available to restore. */
export function discardAngles(proposals: ProjectProposals): ProjectProposals {
  return { ...proposals, angles: null };
}

export function discardStoryboard(proposals: ProjectProposals): ProjectProposals {
  return { ...proposals, storyboard: null };
}

/** Swaps the stored draft back in, or null when there is nothing to restore. */
export function restorePreviousAnglesDraft(
  proposals: ProjectProposals,
): ProjectProposals | null {
  if (!proposals.previousAngles) return null;
  return {
    ...proposals,
    angles: proposals.previousAngles,
    previousAngles: proposals.angles,
  };
}

export function restorePreviousStoryboardDraft(
  proposals: ProjectProposals,
): ProjectProposals | null {
  if (!proposals.previousStoryboard) return null;
  return {
    ...proposals,
    storyboard: proposals.previousStoryboard,
    previousStoryboard: proposals.storyboard,
  };
}
