import type { Brief, Project } from './types';

export type BriefField = 'topic' | 'audience' | 'goal' | 'tone';

export interface BriefValidation {
  ok: boolean;
  errors: Partial<Record<BriefField, string>>;
}

export function validateBrief(brief: Brief): BriefValidation {
  const errors: Partial<Record<BriefField, string>> = {};
  if (brief.topic.trim() === '') {
    errors.topic = 'Add the topic, or paste the material you are starting from.';
  }
  if (brief.audience.trim() === '') {
    errors.audience = 'Say who this video is for.';
  }
  if (brief.goal.trim() === '') {
    errors.goal = 'Say what the viewer should take away.';
  }
  if (brief.tone.trim() === '') {
    errors.tone = 'Add a tone, for example calm and curious.';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function isBriefComplete(brief: Brief): boolean {
  return validateBrief(brief).ok;
}

export type ReviewStatus = 'unreviewed' | 'current' | 'stale';

export interface StoryboardReview {
  status: ReviewStatus;
  reviewedAt: string | null;
  reviewedFingerprint: string | null;
  currentFingerprint: string;
}

/**
 * Compare the exact script fingerprint this board was reviewed against with the
 * live script fingerprint. Every script keystroke invalidates review immediately.
 */
export function getStoryboardReview(project: Project): StoryboardReview {
  const currentFingerprint = project.script.fingerprint;
  const reviewedFingerprint = project.storyboard.reviewedScriptFingerprint;
  let status: ReviewStatus = 'unreviewed';
  if (reviewedFingerprint !== null) {
    status = reviewedFingerprint === currentFingerprint ? 'current' : 'stale';
  }
  return {
    status,
    reviewedAt: project.storyboard.reviewedAt,
    reviewedFingerprint,
    currentFingerprint,
  };
}

/** Short, honest workflow status for dashboard cards. */
export function describeWorkflowStatus(project: Project): string {
  if (!isBriefComplete(project.brief)) return 'Brief incomplete';
  if (project.script.narration.trim() === '') return 'Script not written';
  if (project.storyboard.scenes.length === 0) return 'Storyboard empty';

  const review = getStoryboardReview(project);
  if (review.status === 'stale') return 'Storyboard needs review';
  if (review.status === 'unreviewed') return 'Storyboard not reviewed';

  const drafts = project.storyboard.scenes.filter((scene) => scene.status === 'draft').length;
  if (drafts > 0) return `${drafts} scene${drafts === 1 ? '' : 's'} in draft`;
  return 'Storyboard ready · export unavailable';
}
