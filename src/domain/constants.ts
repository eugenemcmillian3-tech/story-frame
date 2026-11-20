import type {
  AssetType,
  ProjectMode,
  SceneLockKey,
  Stage,
  TargetDuration,
  VisualPreset,
} from './types';

export const TARGET_DURATIONS: readonly TargetDuration[] = [30, 45, 60, 90];

export const MODE_LABELS: Record<ProjectMode, string> = {
  factual: 'Factual',
  fiction: 'Fiction',
};

export interface VisualPresetDefinition {
  id: VisualPreset;
  label: string;
  description: string;
}

export const VISUAL_PRESETS: readonly VisualPresetDefinition[] = [
  {
    id: 'cinematic-explainer',
    label: 'Cinematic explainer',
    description: 'Wide, atmospheric frames with bold captions and a slow reveal.',
  },
  {
    id: 'illustrated-story',
    label: 'Illustrated story',
    description: 'Hand-drawn illustration framing with a warm, narrative feel.',
  },
  {
    id: 'clean-educational',
    label: 'Clean educational',
    description: 'Simple diagrams, neutral palette, maximum legibility.',
  },
];

export const VISUAL_PRESET_LABELS: Record<VisualPreset, string> = {
  'cinematic-explainer': 'Cinematic explainer',
  'illustrated-story': 'Illustrated story',
  'clean-educational': 'Clean educational',
};

export const ASSET_TYPES: readonly { id: AssetType; label: string }[] = [
  { id: 'image', label: 'Still image' },
  { id: 'video-clip', label: 'Video clip' },
  { id: 'diagram', label: 'Diagram' },
  { id: 'title-card', label: 'Title card' },
  { id: 'b-roll', label: 'B-roll footage' },
];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  image: 'Still image',
  'video-clip': 'Video clip',
  diagram: 'Diagram',
  'title-card': 'Title card',
  'b-roll': 'B-roll footage',
};

export const SCENE_LOCK_KEYS: readonly SceneLockKey[] = ['narration', 'visuals', 'text', 'timing'];

export const SCENE_LOCK_LABELS: Record<SceneLockKey, string> = {
  narration: 'Narration',
  visuals: 'Visuals',
  text: 'On-screen text',
  timing: 'Timing',
};

export const STAGES: readonly Stage[] = ['brief', 'script', 'storyboard', 'preview', 'export'];

export const STAGE_LABELS: Record<Stage, string> = {
  brief: 'Brief',
  script: 'Script',
  storyboard: 'Storyboard',
  preview: 'Preview',
  export: 'Export',
};

export const MAX_SCENES = 200;
export const MAX_SCRIPT_VERSIONS = 5;

/** Narration word rate used for every runtime estimate shown in the UI. */
export const NARRATION_WORDS_PER_MINUTE = 150;

/** A total is "materially different" when it drifts past max(3s, 10% of target). */
export function durationVarianceThreshold(target: TargetDuration): number {
  return Math.max(3, Math.round(target * 0.1));
}

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR', 'BRL'] as const;
