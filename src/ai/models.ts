/**
 * Ollama Cloud models this app is allowed to call. The Worker validates every
 * requested model against this list so the route cannot be used to call an
 * arbitrary, unbounded provider model.
 */
export const AI_MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    label: 'DeepSeek V4.1 Flash',
    description: 'Fast general drafting and structured JSON.',
  },
  {
    id: 'gemma4:31b',
    label: 'Gemma 4 31B',
    description: 'Balanced open model for narration and scenes.',
  },
  {
    id: 'glm-5.3-flash',
    label: 'GLM 5.3 Flash',
    description: 'Concise writing with compact structured output.',
  },
  // gpt-oss:120b is deliberately absent. Live checks showed it corrupts the
  // boundary between script segment objects (dropped or duplicated braces where
  // `}],{` should be), which no retry, greedy decoding or format:"json" repair
  // fixes, and it rewrites storyboard narration instead of splitting it.
  {
    id: 'minimax-m3.1-flash',
    label: 'MiniMax M3.1 Flash',
    description: 'Long-form drafting and storyboard splitting.',
  },
  {
    id: 'nemotron-3-super',
    label: 'Nemotron 3 Super',
    description: 'NVIDIA open model for reasoning-heavy briefs.',
  },
] as const;

export type AiModelId = (typeof AI_MODELS)[number]['id'];

export const DEFAULT_AI_MODEL: AiModelId = 'deepseek-v4.1-flash';

export function isAiModelId(value: unknown): value is AiModelId {
  return typeof value === 'string' && AI_MODELS.some((model) => model.id === value);
}

export function aiModelLabel(id: string): string {
  return AI_MODELS.find((model) => model.id === id)?.label ?? id;
}
