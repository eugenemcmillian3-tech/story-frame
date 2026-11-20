import type { NarrationPurpose } from '../../worker/narration';

export type { NarrationPurpose };

export interface GenerateNarrationInput {
  id: string;
  text: string;
  voice: string;
  purpose: NarrationPurpose;
  projectId: string;
  scriptFingerprint: string;
}

export interface GeneratedNarration {
  blob: Blob;
  jobId: string;
  model: string;
  voice: string;
  characters: number;
  estimatedUsd: number;
}

export interface NarrationUsageView {
  dailyLimit: number;
  minuteLimit: number;
  usedToday: number;
  usedThisMinute: number;
  estimatedUsdToday: number;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Sign in with Freebuff to generate narration.',
  409: 'That narration request was already submitted. Start a new generation for another take; it is billed again.',
  413: 'The narration request is too large.',
  429: 'The narration generation limit for this account was reached. Try again later.',
  503: 'Narration is not configured yet. Add the provider credentials in Sites → Secrets.',
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const message = (body as Record<string, unknown>).error;
      if (typeof message === 'string' && message.length <= 400) return message;
    }
  } catch {
    // Fall back to a status-based message.
  }
  return STATUS_MESSAGES[response.status] ?? 'The narration service is unavailable right now.';
}

function numberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Asks the server to speak the text exactly as sent. The request id is recorded
 * server-side, so a resend is refused instead of paying for a second take.
 */
export async function generateNarration(
  input: GenerateNarrationInput,
  signal?: AbortSignal,
): Promise<GeneratedNarration> {
  let response: Response;
  try {
    response = await fetch('/api/narration/jobs', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(
      'The narration service could not be reached. The provider may already have been billed, so check the usage list before generating again.',
    );
  }
  if (!response.ok) throw new Error(await readError(response));
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('The narration service returned empty audio.');
  const characters = numberHeader(response, 'X-Narration-Characters');
  const estimatedUsd = numberHeader(response, 'X-Narration-Estimated-Usd');
  return {
    blob,
    jobId: response.headers.get('X-Narration-Job-Id') ?? input.id,
    model: response.headers.get('X-Narration-Model') ?? '',
    voice: response.headers.get('X-Narration-Voice') ?? input.voice,
    characters: characters ?? input.text.length,
    estimatedUsd: estimatedUsd ?? 0,
  };
}

export async function getNarrationUsage(signal?: AbortSignal): Promise<NarrationUsageView> {
  let response: Response;
  try {
    response = await fetch('/api/narration/usage', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
      cache: 'no-store',
    });
  } catch {
    throw new Error('Narration usage could not be loaded.');
  }
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('The narration service returned an invalid usage response.');
  }
  return body as NarrationUsageView;
}
