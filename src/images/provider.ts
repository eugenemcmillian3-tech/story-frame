import { ASSET_TYPE_LABELS, VISUAL_PRESETS } from '../domain/constants';
import type { Brief, Scene, VisualPreset } from '../domain/types';

/**
 * Cloudflare Workers AI is the one image provider this app uses. Every value
 * below is quoted from Cloudflare's model page and pricing page, checked on
 * 2026-11-20:
 * - POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/
 *     @cf/black-forest-labs/flux-1-schnell
 *   takes `{ prompt, steps }` and answers `{ result: { image: "<base64>" } }`.
 * - prompt is 1–2048 characters, steps 1–8 and default to 4. The model takes no
 *   seed, frame size or negative prompt, and rejects parameters it does not
 *   document.
 * - Output is always one 1024×1024 JPEG, so this app offers no frame-size choice.
 * - Price: $0.0000528 per 512×512 tile plus $0.0001056 per step. A 1024×1024
 *   image is four tiles, so four steps cost 4 × $0.0000528 + 4 × 4 × $0.0001056.
 *   That is the list price before the account's Workers AI plan, its free daily
 *   neuron allowance and taxes, so it is shown as an estimate, never a bill.
 */
export const IMAGE_PROVIDER = 'cloudflare-workers-ai';
export const IMAGE_PROVIDER_LABEL = 'Cloudflare Workers AI';
export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const IMAGE_MODEL_LABEL = 'FLUX.1 Schnell';
export const IMAGE_PRICING_SOURCE = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';
export const MAX_PROMPT_CHARS = 2_048;
/** The step count every request uses; recorded with each generated image. */
export const IMAGE_STEPS = 4;
/** FLUX.1 Schnell's fixed output, in pixels per side. */
export const IMAGE_SIZE = 1_024;

const TILE_USD = 0.0000528;
const STEP_USD = 0.0001056;
/** An estimate for one image at IMAGE_STEPS, from the two published rates. */
export const IMAGE_USD_ESTIMATE =
  (IMAGE_SIZE / 512) ** 2 * (TILE_USD + IMAGE_STEPS * STEP_USD);

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
    'A single coherent frame with one clear centred subject, composed for a square frame with room at the edges.',
    'No words, letters, captions, subtitles, signage, logos, watermarks or interface elements.',
    'Do not imitate a living artist or a specific copyrighted character.',
  ];
  return lines.filter((line) => line !== '').join('\n').slice(0, MAX_PROMPT_CHARS);
}
