import type { AssetType, ProjectMode, TargetDuration, VisualPreset } from '../domain/types';
import type { AiModelId } from './models';

export type AiOperation = 'angles' | 'script' | 'storyboard' | 'edit';

export interface AiBriefInput {
  topic: string;
  audience: string;
  goal: string;
  mode: ProjectMode;
  targetDuration: TargetDuration;
  tone: string;
  visualPreset: VisualPreset;
}

export interface AiSourceInput {
  id: string;
  title: string;
  excerpt: string;
  notes: string;
}

export interface AiStoryNotesInput {
  characters: string;
  setting: string;
  continuity: string;
}

export interface AiAngleSnapshot {
  title: string;
  hook: string;
  approach: string;
  explanation: string;
}

export interface AiAngle extends AiAngleSnapshot {
  id: string;
}

export type ClaimStatus = 'supported' | 'missing' | 'conflicting';

export interface AiClaimExcerpt {
  sourceId: string;
  excerpt: string;
}

export interface AiClaim {
  id: string;
  text: string;
  sourceIds: string[];
  excerpts: AiClaimExcerpt[];
  status: ClaimStatus;
  note: string;
  /** A missing/conflicting claim must be resolved before script acceptance. */
  resolution: 'supported' | 'speculation' | null;
}

export type ScriptSegmentKind = 'hook' | 'body' | 'ending';
export type SegmentReview = 'claims' | 'no-assertion' | 'speculation';

export interface AiScriptSegment {
  id: string;
  kind: ScriptSegmentKind;
  text: string;
  claims: AiClaim[];
  /** Factual segments without a claim annotation must be explicitly reviewed. */
  review: SegmentReview | null;
}

export interface AngleProposal {
  status: 'draft' | 'discarded';
  model: AiModelId;
  inputFingerprint: string;
  angles: AiAngle[];
  selectedAngleId: string | null;
  generatedAt: string;
  editedAt: string | null;
}

export interface ScriptProposal {
  status: 'draft' | 'accepted' | 'discarded';
  mode: 'script' | 'outline';
  model: AiModelId;
  inputFingerprint: string;
  angle: AiAngleSnapshot;
  angleId: string | null;
  segments: AiScriptSegment[];
  outline: string[];
  missingInformation: string[];
  warnings: string[];
  generatedAt: string;
  editedAt: string | null;
}

export interface StoryboardProposalScene {
  id: string;
  title: string;
  narration: string;
  visualDirection: string;
  assetType: AssetType;
  onScreenText: string;
  plannedDuration: number;
}

export interface StoryboardProposal {
  status: 'draft' | 'accepted' | 'discarded';
  model: AiModelId;
  inputFingerprint: string;
  scriptFingerprint: string;
  scenes: StoryboardProposalScene[];
  warnings: string[];
  generatedAt: string;
  editedAt: string | null;
}

export interface ProjectProposals {
  version: 1;
  projectId: string;
  updatedAt: string;
  angles: AngleProposal | null;
  script: ScriptProposal | null;
  storyboard: StoryboardProposal | null;
  /** The draft a regeneration replaced, kept so it can be compared and restored. */
  previousAngles: AngleProposal | null;
  previousStoryboard: StoryboardProposal | null;
}

export type AiErrorCode =
  | 'auth-required'
  | 'forbidden'
  | 'invalid-input'
  | 'invalid-response'
  | 'rate-limit'
  | 'provider'
  | 'network'
  | 'stale'
  | 'storage'
  | 'server';

export class AiError extends Error {
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

export function emptyProposals(projectId: string, now = new Date().toISOString()): ProjectProposals {
  return {
    version: 1,
    projectId,
    updatedAt: now,
    angles: null,
    script: null,
    storyboard: null,
    previousAngles: null,
    previousStoryboard: null,
  };
}
