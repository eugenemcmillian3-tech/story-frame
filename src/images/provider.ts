import { ASSET_TYPE_LABELS, VISUAL_PRESETS } from '../domain/constants';
import type { Brief, Scene, VisualPreset } from '../domain/types';

/**
 * The two image providers this app can use. Every model name, limit and rate
 * below is quoted from the provider's own documentation, checked 2026-11-20.
 *
 * Cloudflare Workers AI — synchronous, one request returns the image:
 * - POST /accounts/{account_id}/ai/run/@cf/black-forest-labs/flux-1-schnell
 *   with `{ prompt, steps }` answers `{ result: { image: "<base64 JPEG>" } }`.
 * - prompt is 1–2048 characters and steps 1–8 (default 4). The model takes no
 *   seed, frame size or negative prompt. Output is always 1024×1024.
 * - Price: $0.0000528 per 512×512 tile plus $0.0001056 per step, so four steps
 *   of a 1024×1024 image cost $0.0019008. Workers AI also gives the account a
 *   free daily neuron allowance, so this is a list price, never a bill.
 *
 * Leonardo.Ai — asynchronous, polled by the server:
 * - POST /api/rest/v2/generations creates a generation; GET
 *   /api/rest/v1/generations/{id} reports PENDING | COMPLETE | FAILED; DELETE
 *   .../{id} cancels one that is still queued.
 * - phoenix-v1.0 accepts width/height up to 2048 px per side in multiples of 8,
 *   a seed and a negative prompt; lucid-origin takes no seed or negative prompt.
 *   Both cap prompts at 2000 characters and choose quality with `mode`.
 * - Leonardo publishes no fixed per-image USD rate: each generation draws from
 *   the API balance and the create response reports `apiCreditCost`, which is
 *   recorded with the image.
 */
export type ImageProviderId = 'workers-ai' | 'leonardo';
export type ImageModelId = 'cf-flux-schnell' | 'leonardo-phoenix' | 'leonardo-lucid-origin';
export type ImageMode = 'FAST' | 'QUALITY' | 'ULTRA';

export const IMAGE_PROVIDER_LABELS: Record<ImageProviderId, string> = {
  'workers-ai': 'Cloudflare Workers AI',
  leonardo: 'Leonardo.Ai',
};

export const MAX_PROMPT_CHARS = 2_048;
const TILE_USD = 0.0000528;
const STEP_USD = 0.0001056;

export interface ImageModelSpec {
  id: ImageModelId;
  provider: ImageProviderId;
  label: string;
  /** The provider's own model name, sent in the request and recorded with the image. */
  model: string;
  note: string;
  width: number;
  height: number;
  maxPromptChars: number;
  /** The provider's quality mode, when it has one; recorded with every image. */
  quality: ImageMode | null;
  /** The diffusion-step count this app requests, when the provider takes one. */
  steps: number | null;
  /** The provider's published list price for one image, when it publishes one. */
  usdEstimate: number | null;
  /** Whether the create response reports an API credit cost to record. */
  reportsCredits: boolean;
  /** `sync` returns the image in the create response; `async` is polled. */
  lifecycle: 'sync' | 'async';
}

export const IMAGE_MODELS: readonly ImageModelSpec[] = [
  {
    id: 'cf-flux-schnell',
    provider: 'workers-ai',
    label: 'FLUX.1 Schnell',
    model: '@cf/black-forest-labs/flux-1-schnell',
    note: 'Runs on the account’s free daily Workers AI allowance first, then at the published neuron rate. Square 1024×1024, four steps, a few seconds.',
    width: 1_024,
    height: 1_024,
    maxPromptChars: 2_048,
    quality: null,
    steps: 4,
    usdEstimate: (1_024 / 512) ** 2 * (TILE_USD + 4 * STEP_USD),
    reportsCredits: false,
    lifecycle: 'sync',
  },
  {
    id: 'leonardo-phoenix',
    provider: 'leonardo',
    label: 'Leonardo Phoenix 1.0',
    model: 'phoenix-v1.0',
    note: 'Portrait 1024×1792 for the 9:16 frame, with a seed and a negative prompt. Batched at Leonardo and polled until it is ready.',
    width: 1_024,
    height: 1_792,
    maxPromptChars: 2_000,
    quality: 'FAST',
    steps: null,
    // Leonardo publishes no fixed per-image USD rate; the API balance is drawn
    // down and the reported credit cost is recorded instead of guessed.
    usdEstimate: null,
    reportsCredits: true,
    lifecycle: 'async',
  },
  {
    id: 'leonardo-lucid-origin',
    provider: 'leonardo',
    label: 'Leonardo Lucid Origin',
    model: 'lucid-origin',
    note: 'Portrait 1024×1792, photoreal and design-led frames. No seed or negative prompt. Batched at Leonardo and polled until it is ready.',
    width: 1_024,
    height: 1_792,
    maxPromptChars: 2_000,
    quality: 'FAST',
    steps: null,
    usdEstimate: null,
    reportsCredits: true,
    lifecycle: 'async',
  },
];

export const DEFAULT_IMAGE_MODEL: ImageModelId = 'cf-flux-schnell';

export function imageModel(id: string): ImageModelSpec | null {
  return IMAGE_MODELS.find((candidate) => candidate.id === id) ?? null;
}

export type ImageStyleId =
  | 'preset'
  | 'photo-editorial'
  | 'cinema-still'
  | 'warm-illustration'
  | 'flat-graphic';

export interface ImageStyle {
  id: ImageStyleId;
  label: string;
  prompt: string;
}

export const IMAGE_STYLES: readonly ImageStyle[] = [
  {
    id: 'preset',
    label: 'Follow the project preset',
    prompt: '',
  },
  {
    id: 'photo-editorial',
    label: 'Photo — editorial',
    prompt:
      'Editorial photograph, natural light, realistic materials and skin tones, shallow depth of field, muted color grade',
  },
  {
    id: 'cinema-still',
    label: 'Cinema — film still',
    prompt:
      'Cinematic film still, anamorphic framing, dramatic directional lighting, fine grain, restrained color palette',
  },
  {
    id: 'warm-illustration',
    label: 'Illustration — warm hand-drawn',
    prompt:
      'Hand-drawn digital illustration, warm palette, soft textures, visible line work, storybook mood',
  },
  {
    id: 'flat-graphic',
    label: 'Graphic — flat editorial',
    prompt:
      'Flat vector-style editorial illustration, simple geometric shapes, limited palette, generous negative space',
  },
];

const PRESET_LABELS: Record<VisualPreset, string> = {
  'cinematic-explainer': 'Cinematic explainer',
  'illustrated-story': 'Illustrated story',
  'clean-educational': 'Clean educational',
};

const PRESET_PROMPTS: Record<VisualPreset, string> = {
  'cinematic-explainer':
    'Cinematic explainer look: wide atmospheric framing, sculpted lighting, muted filmic palette',
  'illustrated-story':
    'Illustrated story look: hand-drawn framing, warm palette, gentle texture, narrative mood',
  'clean-educational':
    'Clean educational look: simple shapes, neutral palette, soft even lighting, high legibility',
};

export function styleById(id: ImageStyleId): ImageStyle {
  return IMAGE_STYLES.find((style) => style.id === id) ?? IMAGE_STYLES[0];
}

function presetDescription(preset: VisualPreset): string {
  const definition = VISUAL_PRESETS.find((candidate) => candidate.id === preset);
  return definition ? definition.description : '';
}

/**
 * Composed from the approved scene visual direction, the project preset and the
 * chosen style setting. It is shown as an editable draft before anything is
 * sent, and the provider receives exactly the edited text.
 */
export function buildSceneImagePrompt({
  scene,
  brief,
  styleId,
}: {
  scene: Scene;
  brief: Brief;
  styleId: ImageStyleId;
}): string {
  const style = styleById(styleId);
  const treatment = style.id === 'preset' ? PRESET_PROMPTS[brief.visualPreset] : style.prompt;
  const presetLine = `${PRESET_LABELS[brief.visualPreset] ?? brief.visualPreset}: ${presetDescription(
    brief.visualPreset,
  )}`;
  const direction =
    scene.visualDirection.trim() ||
    `A single ${ASSET_TYPE_LABELS[scene.assetType].toLowerCase()} that supports this moment.`;
  const lines = [
    direction,
    '',
    `Visual treatment: ${treatment}.`,
    `Project preset: ${presetLine}`,
    brief.topic.trim() ? `Subject: ${brief.topic.trim()}.` : '',
    brief.audience.trim() ? `Audience: ${brief.audience.trim()}.` : '',
    brief.tone.trim() ? `Tone: ${brief.tone.trim()}.` : '',
    `Shot type: ${ASSET_TYPE_LABELS[scene.assetType]}.`,
    '',
    'A single coherent frame with one clear centred subject and room at the edges for a vertical video frame.',
    'No words, letters, captions, subtitles, signage, logos, watermarks or interface elements.',
    'Do not imitate a living artist or a specific copyrighted character.',
  ];
  return lines.filter((line) => line !== '').join('\n').slice(0, MAX_PROMPT_CHARS);
}
