/**
 * The one text-to-speech provider this app offers, quoted from the provider's
 * own documentation, checked on 2026-11-20.
 *
 * Deepgram Aura through Cloudflare Workers AI:
 * - POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/
 *     @cf/deepgram/aura-1
 *   with `{ text, speaker, encoding }` answers with the audio bytes themselves
 *   (`content-type: audio/mpeg`), not a JSON envelope.
 * - Speakers: angus, asteria, arcas, orion, orpheus, athena, luna, zeus,
 *   perseus, helios, hera, stella. `angus` is the documented default.
 * - $0.015 per 1k characters of input text.
 * - The model exposes no speaking-rate, pitch or phoneme parameters, so this
 *   app offers no pronunciation override and cannot regenerate "faster" — only
 *   different text can change the pacing. No voice cloning exists here.
 */

export interface NarrationVoice {
  /** The provider's own speaker id, sent verbatim. */
  id: string;
  /** The speaker id as shown in the picker. No traits are invented. */
  label: string;
}

export interface NarrationModelSpec {
  provider: string;
  model: string;
  label: string;
  voices: readonly NarrationVoice[];
  defaultVoice: string;
  usdPerThousandCharacters: number;
  /** This app's own per-request cap; the provider documents none. */
  maxCharacters: number;
  supportsSpeakingRate: boolean;
  supportsPronunciation: boolean;
}

export const SAMPLE_MAX_CHARACTERS = 240;

const VOICE_IDS = [
  'angus',
  'asteria',
  'arcas',
  'orion',
  'orpheus',
  'athena',
  'luna',
  'zeus',
  'perseus',
  'helios',
  'hera',
  'stella',
] as const;

function voiceLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export const NARRATION_MODEL: NarrationModelSpec = {
  provider: 'Deepgram Aura',
  model: '@cf/deepgram/aura-1',
  label: 'Deepgram Aura (Workers AI)',
  voices: VOICE_IDS.map((id) => ({ id, label: voiceLabel(id) })),
  defaultVoice: 'angus',
  usdPerThousandCharacters: 0.015,
  maxCharacters: 5000,
  supportsSpeakingRate: false,
  supportsPronunciation: false,
};

export const NARRATION_CAPABILITY_NOTES = {
  speakingRate:
    'Aura has no speaking-rate setting, so regenerating the same text cannot change its length. Edit the script to change pacing.',
  pronunciation:
    'Aura has no phoneme or pronunciation override. Spell a tricky word the way you want it said in the script; the narration reads the saved script.',
  cloning: 'This app does not offer voice cloning, and the provider exposes no cloning parameters.',
} as const;

export function isNarrationVoice(value: string): boolean {
  return NARRATION_MODEL.voices.some((voice) => voice.id === value);
}

export function narrationVoiceLabel(voiceId: string): string {
  return NARRATION_MODEL.voices.find((voice) => voice.id === voiceId)?.label ?? voiceId;
}

/** Published list price for the characters sent, before allowances, plan and tax. */
export function estimateNarrationUsd(characters: number): number {
  return Number(((Math.max(0, characters) / 1000) * NARRATION_MODEL.usdPerThousandCharacters).toFixed(6));
}

/**
 * A short lead-in spoken by the chosen voice. Cut at a word boundary so the
 * sample sounds like speech rather than a chopped fragment.
 */
export function buildSampleText(narration: string): string {
  const trimmed = narration.trim();
  if (trimmed.length <= SAMPLE_MAX_CHARACTERS) return trimmed;
  const window = trimmed.slice(0, SAMPLE_MAX_CHARACTERS);
  const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf(' '));
  return (cut > 40 ? window.slice(0, cut) : window).trim();
}
