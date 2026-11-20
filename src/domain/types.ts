/**
 * Domain model for a StoryFrame project.
 *
 * Persisted project data is versioned with SCHEMA_VERSION. Bump the version
 * whenever the stored shape changes, and teach the validator about it.
 */
export const SCHEMA_VERSION = 4;

export type ProjectMode = 'factual' | 'fiction';
export type TargetDuration = 30 | 45 | 60 | 90;
export type VisualPreset = 'cinematic-explainer' | 'illustrated-story' | 'clean-educational';
export type Stage = 'brief' | 'script' | 'storyboard' | 'preview' | 'export';
export type SceneStatus = 'draft' | 'approved';
export type AssetType = 'image' | 'video-clip' | 'diagram' | 'title-card' | 'b-roll';
export type SceneLockKey = 'narration' | 'visuals' | 'text' | 'timing';
/** How an uploaded still frame fills the vertical frame. */
export type ImageFraming = 'fit' | 'fill';

/** Independent, per-component locks on a single scene. */
export interface SceneLocks {
  narration: boolean;
  visuals: boolean;
  text: boolean;
  timing: boolean;
}

/** A user-entered reference to media that does not exist in this milestone. */
export interface AssetReference {
  id: string;
  label: string;
}

/** Voice preference is stored configuration only; nothing generates narration yet. */
export interface VoicePreference {
  label: string;
  notes: string;
}

/** Planning note only. No billing, spending controls, or budget enforcement exists. */
export interface PlanningBudget {
  amount: number | null;
  currency: string;
}

export interface Brief {
  topic: string;
  audience: string;
  goal: string;
  mode: ProjectMode;
  targetDuration: TargetDuration;
  tone: string;
  visualPreset: VisualPreset;
  voicePreference: VoicePreference;
  budget: PlanningBudget;
}

/** Bounded archive of narration that was explicitly replaced. */
export interface ScriptVersion {
  id: string;
  narration: string;
  fingerprint: string;
  replacedAt: string;
}

/**
 * One source of truth for narration. `fingerprint` is derived from `narration`
 * (exact content) and is recomputed on read, never trusted from storage.
 */
export interface Script {
  narration: string;
  fingerprint: string;
  locked: boolean;
  lockedAt: string | null;
  updatedAt: string;
  versions: ScriptVersion[];
}

/** Factual-mode source material. User-provided and unverified. */
export interface SourceNote {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  notes: string;
}

/** Fiction-mode story notes. */
export interface StoryNotes {
  characters: string;
  setting: string;
  continuity: string;
}

export interface Scene {
  id: string;
  title: string;
  narration: string;
  visualDirection: string;
  assetType: AssetType;
  assetRef: AssetReference | null;
  /** IndexedDB media asset id. Never an object URL; null when no image is attached. */
  imageAssetId: string | null;
  /** Contain (fit) or cover-crop (fill) framing for the attached image. */
  imageFraming: ImageFraming;
  onScreenText: string;
  /** Planned seconds. Not a measured render duration. */
  plannedDuration: number;
  status: SceneStatus;
  locks: SceneLocks;
}

export type AudioTrackRole = 'narration' | 'music';

/**
 * Provenance for narration this app generated, stored with the take so a later
 * script edit can be compared against the exact text that was spoken.
 */
export interface NarrationTake {
  provider: string;
  model: string;
  /** The provider's speaker id. */
  voice: string;
  /** Fingerprint of the saved script the audio was generated from. */
  scriptFingerprint: string;
  characters: number;
  /** Published list price for those characters, or null when none is quoted. */
  estimatedUsd: number | null;
  jobId: string;
  generatedAt: string;
}

/** Uploaded audio metadata. The bytes live in IndexedDB under `assetId`. */
export interface AudioTrackSettings {
  assetId: string | null;
  fileName: string | null;
  durationMs: number | null;
  /** Linear gain from 0 to 1. The UI exposes this as 0–100%. */
  volume: number;
  muted: boolean;
  /**
   * Set only while the track holds app-generated narration. An uploaded file
   * clears it, so a stale take can never describe an upload.
   */
  generated?: NarrationTake | null;
}

export interface ProjectAudio {
  narration: AudioTrackSettings;
  music: AudioTrackSettings;
}

export interface SavedStoryboard {
  scenes: Scene[];
  reviewedScriptFingerprint: string | null;
  reviewedAt: string | null;
  savedAt: string;
}

export interface Storyboard {
  /** Array order is the scene order; there is no duplicate order field. */
  scenes: Scene[];
  /** Fingerprint of the exact script narration this board was reviewed against. */
  reviewedScriptFingerprint: string | null;
  reviewedAt: string | null;
  /** Recoverable board replaced by the last accepted storyboard proposal. */
  previous: SavedStoryboard | null;
}

/** A planning-only artifact. It is never treated as narration. */
export interface StoryboardDraftScene {
  title: string;
  narration: string;
  visualDirection: string;
  assetType: AssetType;
  onScreenText: string;
  plannedDuration: number;
}

export interface PlanningNote {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  /** Fingerprint of the brief/source input that produced the note. */
  inputFingerprint: string | null;
}


export interface Workflow {
  lastStage: Stage;
}

export interface Project {
  schemaVersion: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Incremented by persistence on every successful write. */
  contentRevision: number;
  /** True only for the bundled, clearly labeled demo fixture project. */
  isSample: boolean;
  brief: Brief;
  script: Script;
  sourceNotes: SourceNote[];
  storyNotes: StoryNotes;
  audio: ProjectAudio;
  planningNotes: PlanningNote[];
  storyboard: Storyboard;
  workflow: Workflow;
}
