import { parseAngleTokens, parseScriptTokens, parseStoryboardTokens } from './contracts';
import type { ScriptTokens, StoryboardTokens } from './contracts';
import {
  buildAnglesInput,
  buildScriptInput,
  buildStoryboardInput,
  requestFingerprint,
} from './input';
import type { AiRequestPayload, AnglesInput, ScriptInput, StoryboardInput } from './input';
import { DEFAULT_AI_MODEL } from './models';
import type { AiModelId } from './models';
import { AiError } from './types';
import type { AiAngleSnapshot } from './types';
import type { Project } from '../domain/types';

interface RawResponse {
  operation: string;
  inputFingerprint: string;
  proposal: unknown;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Sign in with Freebuff to generate a proposal.',
  403: 'This request was refused. Reload the page and try again.',
  413: 'The planning input is too large. Shorten the brief or source excerpts.',
  429: 'The AI planning limit for this account was reached. Try again later.',
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const message = (body as Record<string, unknown>).error;
      if (typeof message === 'string' && message.length <= 400) return message;
    }
  } catch {
    // A non-JSON error is replaced with a fixed safe message below.
  }
  return STATUS_MESSAGES[response.status] ?? 'The AI planning service is unavailable right now.';
}

function codeForStatus(status: number): AiError['code'] {
  if (status === 401) return 'auth-required';
  if (status === 403) return 'forbidden';
  if (status === 413) return 'invalid-input';
  if (status === 429) return 'rate-limit';
  if (status === 422) return 'invalid-response';
  if (status >= 500) return 'provider';
  return 'server';
}

async function post(
  payload: AiRequestPayload,
  signal: AbortSignal,
): Promise<{ response: RawResponse; fingerprint: string }> {
  const fingerprint = requestFingerprint(payload);
  let response: Response;
  try {
    response = await fetch('/api/ai/plan', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AiError('network', 'The AI planning service could not be reached. Check your connection.');
  }
  if (!response.ok) {
    throw new AiError(codeForStatus(response.status), await readError(response));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AiError('invalid-response', 'The AI planning service returned an unreadable response.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AiError('invalid-response', 'The AI planning service returned an invalid response.');
  }
  const record = body as Record<string, unknown>;
  if (
    record.operation !== payload.operation ||
    typeof record.inputFingerprint !== 'string' ||
    !('proposal' in record)
  ) {
    throw new AiError('invalid-response', 'The AI planning service returned an invalid response.');
  }
  if (record.inputFingerprint !== fingerprint) {
    throw new AiError(
      'stale',
      'The planning input changed before the response arrived. This response was ignored.',
    );
  }
  return { response: record as unknown as RawResponse, fingerprint };
}

export interface QuotaWindow {
  used: number;
  limit: number;
  remaining: number;
}

export interface AiQuota {
  daily: QuotaWindow;
  minute: QuotaWindow;
}

function readQuotaWindow(value: unknown): QuotaWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const window = value as Record<string, unknown>;
  const { used, limit, remaining } = window;
  if (typeof used !== 'number' || typeof limit !== 'number' || typeof remaining !== 'number') {
    return null;
  }
  return { used, limit, remaining };
}

/** Reads the remaining budget without spending any of it. */
export async function fetchQuota(signal?: AbortSignal): Promise<AiQuota> {
  let response: Response;
  try {
    response = await fetch('/api/ai/quota', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AiError('network', 'AI planning usage could not be read.');
  }
  if (!response.ok) {
    throw new AiError(codeForStatus(response.status), await readError(response));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AiError('invalid-response', 'AI planning usage could not be read.');
  }
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const daily = readQuotaWindow(record.daily);
  const minute = readQuotaWindow(record.minute);
  if (!daily || !minute) {
    throw new AiError('invalid-response', 'AI planning usage could not be read.');
  }
  return { daily, minute };
}

export async function requestAngles(
  project: Project,
  model: AiModelId = DEFAULT_AI_MODEL,
  signal: AbortSignal,
): Promise<{ angles: AiAngleSnapshot[]; inputFingerprint: string }> {
  const input: AnglesInput = buildAnglesInput(project);
  const { response, fingerprint } = await post({ operation: 'angles', model, input }, signal);
  return { angles: parseAngleTokens(response.proposal).angles, inputFingerprint: fingerprint };
}

export async function requestScript(
  project: Project,
  angle: AiAngleSnapshot,
  model: AiModelId = DEFAULT_AI_MODEL,
  signal: AbortSignal,
): Promise<{ script: ScriptTokens; inputFingerprint: string }> {
  const input: ScriptInput = buildScriptInput(project, angle);
  const { response, fingerprint } = await post({ operation: 'script', model, input }, signal);
  return {
    script: parseScriptTokens(response.proposal, {
      mode: project.brief.mode,
      sources: input.sourceNotes,
    }),
    inputFingerprint: fingerprint,
  };
}

export async function requestStoryboard(
  project: Project,
  model: AiModelId = DEFAULT_AI_MODEL,
  signal: AbortSignal,
): Promise<{ storyboard: StoryboardTokens; inputFingerprint: string }> {
  const input: StoryboardInput = buildStoryboardInput(project);
  const { response, fingerprint } = await post({ operation: 'storyboard', model, input }, signal);
  return {
    storyboard: parseStoryboardTokens(response.proposal, input.script.narration),
    inputFingerprint: fingerprint,
  };
}
