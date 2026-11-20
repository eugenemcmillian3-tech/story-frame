/**
 * The one text-to-speech provider this app offers, quoted from Deepgram's own
 * documentation, checked on 2026-11-20.
 *
 * Deepgram's REST API, called with the deployment's own DEEPGRAM_API_KEY:
 * - POST https://api.deepgram.com/v1/speak?model=aura-luna-en
 *   with `Authorization: Token {key}` and `{ text }` answers with the audio
 *   bytes themselves; mp3 is the documented default encoding, so no `encoding`
 *   parameter is needed.
 * - Aura-1 English voices use the model name `aura-{voice}-en`, so the voice the
 *   user picks is also the model sent to the provider.
 * - $0.015 per 1k characters of input text.
 * - The endpoint documents a `speed` multiplier, but this app sends none, so the
 *   same text always speaks at the voice's natural pace. There is no phoneme
 *   override and no voice cloning.
 */

export interface NarrationVoice {
  /** The provider's own model id for this voice, sent verbatim. */
  id: string;
  /** The voice as shown in the picker. No traits are invented. */
  label: string;
}

export interface NarrationModelSpec {
  provider: string;
  /** The voice family; the per-request model id lives on the voice. */
  model: string;
  label: string;
  voices: readonly NarrationVoice[];
  defaultVoice: string;
  usdPerThousandCharacters: number;
  /** This app's own per-request cap; the provider documents none. */
  maxCharacters: number;
}

export const SAMPLE_MAX_CHARACTERS = 240;

const VOICE_NAMES = [
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

export const NARRATION_MODEL: NarrationModelSpec = {
  provider: 'Deepgram',
  model: 'aura-1',
  label: 'Deepgram Aura',
  voices: VOICE_NAMES.map((name) => ({
    id: `aura-${name}-en`,
    label: name.charAt(0).toUpperCase() + name.slice(1),
  })),
  defaultVoice: 'aura-angus-en',
  usdPerThousandCharacters: 0.015,
  maxCharacters: 5000,
};

export const NARRATION_CAPABILITY_NOTES = {
  speakingRate:
    'This app sends no speed setting, so regenerating the same text speaks it at the same natural pace. Edit the script to change pacing.',
  pronunciation:
    'Deepgram’s speech endpoint takes no phoneme or pronunciation override. Spell a tricky word the way you want it said in the script; the narration reads the saved script.',
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
