import type { ImageJobSettings, ImageJobStatus } from '../../worker/imageJobs';

export type { ImageJobSettings, ImageJobStatus };

export interface ImageJobView {
  id: string;
  status: ImageJobStatus;
  provider: string;
  model: string;
  prompt: string;
  settings: ImageJobSettings;
  sceneId: string;
  projectId: string;
  width: number | null;
  height: number | null;
  inferenceSeconds: number | null;
  providerCreditCost: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitImageJobInput {
  id: string;
  sceneId: string;
  projectId: string;
  prompt: string;
  style: string;
  modelId: string;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Sign in with Freebuff to generate scene images.',
  402: 'The Leonardo API balance cannot cover this generation. Top up the API balance and try again.',
  403: 'This request was refused. Reload the page and try again.',
  409: 'That image request is already being processed.',
  413: 'The image request is too large.',
  429: 'The image generation limit for this account was reached. Try again later.',
  503: 'Image generation is not configured yet. Add the provider credentials in Sites → Secrets.',
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
  return STATUS_MESSAGES[response.status] ?? 'The image generation service is unavailable right now.';
}

function isJob(value: unknown): value is ImageJobView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.id === 'string' &&
    typeof job.status === 'string' &&
    typeof job.sceneId === 'string' &&
    typeof job.model === 'string' &&
    typeof job.prompt === 'string' &&
    typeof job.settings === 'object' &&
    job.settings !== null
  );
}

async function readJob(response: Response): Promise<ImageJobView> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('The image service returned an unreadable response.');
  }
  const job =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).job : undefined;
  if (!isJob(job)) throw new Error('The image service returned an invalid response.');
  return job;
}

/**
 * Submits one scene. The request id is the idempotency record on the server, so
 * a resubmission returns the same job instead of paying for a second image.
 * A transport failure is not retried here: the request may already have reached
 * the provider, and a blind retry could pay for it twice.
 */
export async function submitImageJob(
  input: SubmitImageJobInput,
  signal?: AbortSignal,
): Promise<ImageJobView> {
  let response: Response;
  try {
    response = await fetch('/api/images/jobs', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(
      'The image service could not be reached. The provider may or may not have received the request, so check this scene before generating it again.',
    );
  }
  if (!response.ok) throw new Error(await readError(response));
  return readJob(response);
}

export async function getImageJob(id: string, signal?: AbortSignal): Promise<ImageJobView> {
  let response: Response;
  try {
    response = await fetch(`/api/images/jobs/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The image status could not be checked. Check your connection and retry.');
  }
  if (!response.ok) throw new Error(await readError(response));
  return readJob(response);
}

export async function cancelImageJob(id: string): Promise<ImageJobView> {
  let response: Response;
  try {
    response = await fetch(`/api/images/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Error('The cancel request could not be sent. The image may still complete.');
  }
  if (!response.ok) throw new Error(await readError(response));
  return readJob(response);
}

/** Downloads the completed file once; the caller stores it as a real media asset. */
export async function fetchGeneratedImage(id: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api/images/jobs/${encodeURIComponent(id)}/image`, {
      credentials: 'same-origin',
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The generated image could not be downloaded. Try again.');
  }
  if (!response.ok) throw new Error(await readError(response));
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('The generated image was empty.');
  return blob;
}
