/**
 * Server-side scene image generation through the two providers this app offers.
 * Every endpoint, parameter and limit is quoted from the provider's own
 * documentation, checked on 2026-11-20.
 *
 * Cloudflare Workers AI (synchronous):
 * - POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/
 *     @cf/black-forest-labs/flux-1-schnell
 *   with `{ prompt, steps }` answers `{ result: { image: "<base64 JPEG>" } }`.
 * - prompt 1–2048 characters, steps 1–8. The model takes no seed, size or
 *   negative prompt, and output is always 1024×1024.
 *
 * Leonardo.Ai (asynchronous):
 * - POST https://cloud.leonardo.ai/api/rest/v2/generations answers with a
 *   generation id (`generate.generationId`) and, on production keys, the API
 *   credit cost (`apiCreditCost`).
 * - GET /api/rest/v1/generations/{id} reports PENDING | COMPLETE | FAILED and,
 *   on COMPLETE, temporary image links that are copied here immediately.
 * - DELETE /api/rest/v1/generations/{id} cancels a generation still queued.
 *
 * The D1 row is the idempotency record, so a double click or a resent request id
 * never pays twice, and finished bytes are kept server-side so a dropped
 * response loses nothing. A row whose submission was never acknowledged is never
 * retried automatically: that generation may already have been billed.
 */

import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  MAX_PROMPT_CHARS,
  imageModel,
} from '../src/images/provider';
import type { ImageModelId, ImageModelSpec, ImageProviderId } from '../src/images/provider';

export type ImageJobStatus =
  | 'submitting'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** A D1 row is limited to 2 MB, so a larger result cannot be kept. */
const MAX_RESULT_BYTES = 1_900_000;
/** A submission that never recorded a provider id is given up after this. */
const SUBMITTING_STALE_MS = 180_000;
/** An async generation still pending after this is reported as failed. */
const PENDING_STALE_MS = 10 * 60_000;
const CF_TIMEOUT_MS = 60_000;
const LEONARDO_CREATE_TIMEOUT_MS = 30_000;
const LEONARDO_POLL_TIMEOUT_MS = 20_000;
const LEONARDO_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_CF_AI_ROOT = 'https://api.cloudflare.com/client/v4';
const DEFAULT_LEONARDO_ROOT = 'https://cloud.leonardo.ai/api/rest';

const NEGATIVE_PROMPT =
  'words, text, letters, captions, subtitles, signage, logos, watermarks, interface elements, ' +
  'blurry, low quality, jpeg artifacts, distorted hands';

export interface ImageJobSettings {
  modelId: ImageModelId;
  /** The style setting the prompt was composed for; recorded, not interpreted. */
  style: string;
}

export interface ImageJob {
  id: string;
  status: ImageJobStatus;
  provider: string;
  /** The provider's own model name, e.g. phoenix-v1.0. */
  model: string;
  prompt: string;
  settings: ImageJobSettings;
  sceneId: string;
  projectId: string;
  /** The provider's job id, used for polling and cancellation. */
  providerJobId: string | null;
  width: number | null;
  height: number | null;
  inferenceSeconds: number | null;
  /** Leonardo's reported API credit cost, when it reports one. */
  providerCreditCost: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImageJobRequest {
  id: string;
  sceneId: string;
  projectId: string;
  prompt: string;
  settings: ImageJobSettings;
}

export class ImageJobError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ImageJobError';
    this.status = status;
  }
}

interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface ImageJobDatabase {
  prepare(query: string): Statement;
}

export interface ImageEnv {
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** Test-only overrides; production calls the providers' own API hosts. */
  CF_AI_BASE?: string;
  LEONARDO_API_KEY?: string;
  LEONARDO_API_BASE?: string;
}

interface JobRow {
  id: string;
  provider: string | null;
  status: string;
  model: string;
  prompt: string;
  settings: string;
  scene_id: string;
  project_id: string;
  provider_job_id: string | null;
  width: number | null;
  height: number | null;
  inference_seconds: number | null;
  provider_credit_cost: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** `bytes` is left out on purpose: reading a job must not read its image. */
const JOB_COLUMNS = `id, provider, status, model, prompt, settings, scene_id, project_id,
  provider_job_id, width, height, inference_seconds, provider_credit_cost, error,
  created_at, updated_at`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new ImageJobError(400, `${label} must be text.`);
  if (value.trim() === '') throw new ImageJobError(400, `${label} is required.`);
  if (value.length > max) throw new ImageJobError(400, `${label} is too long.`);
  return value;
}

/**
 * Validates the request before anything is submitted or billed. The provider's
 * model, size, quality and step count come from the model spec, never from the
 * client, so a request cannot name a model this app does not verify.
 */
export function parseImageJobRequest(value: unknown): ImageJobRequest {
  if (!isRecord(value)) throw new ImageJobError(400, 'The image request must be an object.');
  const id = text(value.id, 'id', 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new ImageJobError(400, 'id must be an 8–80 character request id.');
  }
  const modelId = typeof value.modelId === 'string' ? value.modelId : DEFAULT_IMAGE_MODEL;
  const spec = imageModel(modelId);
  if (!spec) throw new ImageJobError(400, 'That image model is not supported.');
  const prompt = text(value.prompt, 'prompt', MAX_PROMPT_CHARS);
  if (prompt.length > spec.maxPromptChars) {
    throw new ImageJobError(400, `${spec.label} accepts at most ${spec.maxPromptChars} characters.`);
  }
  return {
    id,
    sceneId: text(value.sceneId, 'sceneId', 200),
    projectId: text(value.projectId, 'projectId', 200),
    prompt,
    settings: {
      modelId: spec.id,
      style: typeof value.style === 'string' ? value.style.slice(0, 80) : '',
    },
  };
}

function isProviderConfigured(env: ImageEnv, provider: ImageProviderId): boolean {
  return provider === 'leonardo'
    ? Boolean(env.LEONARDO_API_KEY)
    : Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
}

function providerConfigError(provider: ImageProviderId): string {
  return provider === 'leonardo'
    ? 'Leonardo image generation is not configured. Add LEONARDO_API_KEY in Sites → Secrets, then redeploy.'
    : 'Cloudflare image generation is not configured. Add CF_ACCOUNT_ID and CF_API_TOKEN in Sites → Secrets, then redeploy.';
}

const imageSchemaReady = new WeakSet<object>();

export async function ensureImageSchema(db: ImageJobDatabase): Promise<void> {
  if (imageSchemaReady.has(db)) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scene_image_jobs (
        id TEXT PRIMARY KEY,
        user_sub TEXT NOT NULL,
        project_id TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        provider TEXT,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        settings TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_job_id TEXT,
        width INTEGER,
        height INTEGER,
        inference_seconds REAL,
        provider_credit_cost INTEGER,
        mime_type TEXT,
        bytes BLOB,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  // Rows written before Leonardo was added lack these columns.
  for (const statement of [
    'ALTER TABLE scene_image_jobs ADD COLUMN provider TEXT',
    'ALTER TABLE scene_image_jobs ADD COLUMN provider_job_id TEXT',
    'ALTER TABLE scene_image_jobs ADD COLUMN provider_credit_cost INTEGER',
  ]) {
    try {
      await db.prepare(statement).run();
    } catch {
      // The column already exists.
    }
  }
  await db
    .prepare(
      'CREATE INDEX IF NOT EXISTS scene_image_jobs_user ON scene_image_jobs(user_sub, created_at)',
    )
    .run();
  imageSchemaReady.add(db);
}

function toJob(row: JobRow): ImageJob {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(row.settings) as unknown;
  } catch {
    parsed = null;
  }
  const stored = isRecord(parsed) ? parsed : {};
  const spec = imageModel(String(stored.modelId ?? '')) ?? IMAGE_MODELS[0];
  return {
    id: row.id,
    status: row.status as ImageJobStatus,
    provider: row.provider ?? spec.provider,
    model: row.model,
    prompt: row.prompt,
    settings: {
      modelId: spec.id,
      style: typeof stored.style === 'string' ? stored.style : '',
    },
    sceneId: row.scene_id,
    projectId: row.project_id,
    providerJobId: row.provider_job_id,
    width: row.width,
    height: row.height,
    inferenceSeconds: row.inference_seconds,
    providerCreditCost: row.provider_credit_cost,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readJobRow(
  db: ImageJobDatabase,
  sub: string,
  id: string,
): Promise<JobRow | null> {
  const rows = await db
    .prepare(`SELECT ${JOB_COLUMNS} FROM scene_image_jobs WHERE id = ?1 AND user_sub = ?2`)
    .bind(id, sub)
    .all<JobRow>();
  return rows.results?.[0] ?? null;
}

export async function readImageJob(
  db: ImageJobDatabase,
  sub: string,
  id: string,
): Promise<ImageJob | null> {
  const row = await readJobRow(db, sub, id);
  return row ? toJob(row) : null;
}

async function readJson(
  response: Response,
  limit = 300_000,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (raw === '' || raw.length > limit) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function providerMessage(body: Record<string, unknown> | null, fallback: string): string {
  if (body) {
    const errors = body.errors;
    if (Array.isArray(errors)) {
      for (const entry of errors) {
        if (isRecord(entry) && typeof entry.message === 'string' && entry.message.trim() !== '') {
          return entry.message.slice(0, 300);
        }
      }
    }
    for (const key of ['error', 'detail', 'message'] as const) {
      const value = body[key];
      if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 300);
    }
  }
  return fallback;
}

function decodeBase64Image(value: string): Uint8Array {
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw new ImageJobError(502, 'The provider returned an unreadable image.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The declared type is not trusted; the bytes decide. */
function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  return null;
}

function checkedImage(bytes: Uint8Array): { bytes: Uint8Array; mimeType: string } {
  if (bytes.byteLength === 0) throw new ImageJobError(502, 'The provider returned an empty image.');
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new ImageJobError(502, 'The generated image is too large to keep.');
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw new ImageJobError(502, 'The provider returned an unsupported file type.');
  return { bytes, mimeType };
}

function randomSeed(): number {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0] % 2_147_483_637;
}

function cfRoot(env: ImageEnv): string {
  return (env.CF_AI_BASE || DEFAULT_CF_AI_ROOT).replace(/\/+$/, '');
}

function leonardoRoot(env: ImageEnv): string {
  return (env.LEONARDO_API_BASE || DEFAULT_LEONARDO_ROOT).replace(/\/+$/, '');
}

function leonardoHeaders(env: ImageEnv): Record<string, string> {
  return {
    authorization: `Bearer ${env.LEONARDO_API_KEY ?? ''}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

/** Cloudflare Workers AI: one synchronous billable call, never retried here. */
async function generateWithWorkersAi(
  env: ImageEnv,
  spec: ImageModelSpec,
  prompt: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let response: Response;
  try {
    response = await fetch(
      `${cfRoot(env)}/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID ?? '')}/ai/run/${spec.model}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CF_API_TOKEN ?? ''}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ prompt, steps: spec.steps ?? 4 }),
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
      },
    );
  } catch {
    throw new ImageJobError(
      504,
      'Cloudflare did not answer in time. The generation may still have been billed, so check the Workers AI usage log before generating this scene again.',
    );
  }
  // Room for a MAX_RESULT_BYTES image once base64 expands it by a third.
  const body = await readJson(response, 4_000_000);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ImageJobError(
        503,
        'Cloudflare refused these credentials. Check that CF_API_TOKEN has Workers AI permission on this account.',
      );
    }
    if (response.status === 429) {
      throw new ImageJobError(429, 'Cloudflare is rate-limiting Workers AI. Try again shortly.');
    }
    if (response.status === 400 || response.status === 422) {
      // The provider's own message names the rejection: a refused prompt, or the
      // account's daily Workers AI allowance being spent.
      throw new ImageJobError(
        400,
        providerMessage(body, 'Cloudflare rejected this generation request.'),
      );
    }
    throw new ImageJobError(
      502,
      providerMessage(body, `Cloudflare returned an unexpected response (${response.status}).`),
    );
  }
  const result = body && isRecord(body.result) ? body.result : null;
  const image = result && typeof result.image === 'string' ? result.image : null;
  if (!image) throw new ImageJobError(502, 'Cloudflare completed the request without an image.');
  return checkedImage(decodeBase64Image(image));
}

function leonardoFailure(status: number, body: Record<string, unknown> | null): ImageJobError {
  if (status === 401) {
    return new ImageJobError(
      503,
      'Leonardo refused these credentials. Check LEONARDO_API_KEY, and that its key has API access.',
    );
  }
  if (status === 403) {
    // Leonardo also uses 403 for its content moderation filter, so the
    // provider's own message is what the user needs to see.
    return new ImageJobError(
      502,
      providerMessage(body, 'Leonardo refused this generation request.'),
    );
  }
  if (status === 402) {
    return new ImageJobError(
      402,
      'The Leonardo API balance cannot cover this generation. Top up the API balance and try again.',
    );
  }
  if (status === 429) {
    return new ImageJobError(429, 'Leonardo is rate-limiting requests. Try again shortly.');
  }
  if (status === 400 || status === 422) {
    return new ImageJobError(400, providerMessage(body, 'Leonardo rejected this generation request.'));
  }
  return new ImageJobError(
    502,
    providerMessage(body, `Leonardo returned an unexpected response (${status}).`),
  );
}

interface LeonardoCreation {
  generationId: string;
  creditCost: number | null;
}

/** Leonardo.Ai: queues one generation and records its id and reported credit cost. */
async function createWithLeonardo(
  env: ImageEnv,
  spec: ImageModelSpec,
  prompt: string,
): Promise<LeonardoCreation> {
  const parameters: Record<string, unknown> = {
    prompt,
    width: spec.width,
    height: spec.height,
    quantity: 1,
    // The prompt shown in the editor is the prompt that is used.
    prompt_enhance: 'OFF',
  };
  if (spec.quality) parameters.mode = spec.quality;
  if (spec.id === 'leonardo-phoenix') {
    parameters.seed = randomSeed();
    parameters.negative_prompt = NEGATIVE_PROMPT;
  }

  let response: Response;
  try {
    response = await fetch(`${leonardoRoot(env)}/v2/generations`, {
      method: 'POST',
      headers: leonardoHeaders(env),
      body: JSON.stringify({ model: spec.model, parameters, public: false }),
      signal: AbortSignal.timeout(LEONARDO_CREATE_TIMEOUT_MS),
    });
  } catch {
    throw new ImageJobError(
      504,
      'Leonardo did not answer in time. The generation may have started, so check this scene before generating it again.',
    );
  }
  const body = await readJson(response);
  if (!response.ok) throw leonardoFailure(response.status, body);
  if (!body) throw new ImageJobError(502, 'Leonardo returned an unreadable response.');
  const container = isRecord(body.generate) ? body.generate : body;
  const rawId = container.generationId ?? body.generationId;
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    throw new ImageJobError(502, 'Leonardo did not return a generation id.');
  }
  const rawCredits = container.apiCreditCost ?? body.apiCreditCost;
  return {
    generationId: rawId.slice(0, 120),
    creditCost: typeof rawCredits === 'number' && Number.isFinite(rawCredits) ? rawCredits : null,
  };
}

interface LeonardoPoll {
  status: 'PENDING' | 'COMPLETE' | 'FAILED';
  imageUrl: string | null;
}

async function pollLeonardo(env: ImageEnv, generationId: string): Promise<LeonardoPoll> {
  let response: Response;
  try {
    response = await fetch(
      `${leonardoRoot(env)}/v1/generations/${encodeURIComponent(generationId)}`,
      {
        method: 'GET',
        headers: leonardoHeaders(env),
        signal: AbortSignal.timeout(LEONARDO_POLL_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
  } catch {
    throw new ImageJobError(
      504,
      'Leonardo did not answer in time. The generation is still recorded; check this image again.',
    );
  }
  const body = await readJson(response);
  if (!response.ok) throw leonardoFailure(response.status, body);
  const record = body && isRecord(body.generations_by_pk) ? body.generations_by_pk : null;
  const status = record?.status;
  if (status !== 'PENDING' && status !== 'COMPLETE' && status !== 'FAILED') {
    throw new ImageJobError(502, 'Leonardo returned an unreadable generation status.');
  }
  let imageUrl: string | null = null;
  const images = record?.generated_images;
  if (Array.isArray(images)) {
    for (const entry of images) {
      if (isRecord(entry) && typeof entry.url === 'string' && entry.url !== '') {
        imageUrl = entry.url;
        break;
      }
    }
  }
  return { status, imageUrl };
}

async function downloadLeonardoImage(
  url: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!/^https:\/\//i.test(url)) {
    throw new ImageJobError(502, 'Leonardo returned an unexpected download address.');
  }
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(LEONARDO_DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new ImageJobError(
      502,
      'The generated image could not be downloaded. Check this image again to retry the download.',
    );
  }
  if (!response.ok) {
    throw new ImageJobError(
      502,
      `The generated image could not be downloaded (${response.status}). Check again to retry.`,
    );
  }
  return checkedImage(new Uint8Array(await response.arrayBuffer()));
}

async function markFailed(
  db: ImageJobDatabase,
  id: string,
  sub: string,
  message: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE scene_image_jobs SET status = 'failed', bytes = NULL, error = ?1, updated_at = ?2
        WHERE id = ?3 AND user_sub = ?4`,
    )
    .bind(message, new Date().toISOString(), id, sub)
    .run();
}

async function markCompleted(
  db: ImageJobDatabase,
  id: string,
  sub: string,
  image: { bytes: Uint8Array; mimeType: string },
  inferenceSeconds: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE scene_image_jobs
          SET status = 'completed', mime_type = ?1, bytes = ?2, inference_seconds = ?3,
              error = NULL, updated_at = ?4
        WHERE id = ?5 AND user_sub = ?6`,
    )
    .bind(image.mimeType, image.bytes, inferenceSeconds, new Date().toISOString(), id, sub)
    .run();
}

/**
 * Starts one generation. The row is written before the provider is called, so a
 * duplicate submission (double click, retry after a dropped response) finds the
 * record instead of paying for a second image.
 */
export async function submitImageJob(
  db: ImageJobDatabase,
  env: ImageEnv,
  sub: string,
  request: ImageJobRequest,
  now: Date = new Date(),
): Promise<{ job: ImageJob; created: boolean }> {
  const spec = imageModel(request.settings.modelId);
  if (!spec) throw new ImageJobError(400, 'That image model is not supported.');
  if (!isProviderConfigured(env, spec.provider)) {
    throw new ImageJobError(503, providerConfigError(spec.provider));
  }
  await ensureImageSchema(db);

  const inserted = await db
    .prepare(
      `INSERT INTO scene_image_jobs
        (id, user_sub, project_id, scene_id, provider, model, prompt, settings, status, width, height, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'submitting', ?9, ?10, ?11, ?11)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
    )
    .bind(
      request.id,
      sub,
      request.projectId,
      request.sceneId,
      spec.provider,
      spec.model,
      request.prompt,
      JSON.stringify(request.settings),
      spec.width,
      spec.height,
      now.toISOString(),
    )
    .all<{ id: string }>();

  if ((inserted.results?.length ?? 0) === 0) {
    const existing = await readImageJob(db, sub, request.id);
    if (!existing) throw new ImageJobError(409, 'That request id is not available.');
    if (existing.status !== 'submitting') return { job: existing, created: false };
    const age = now.getTime() - new Date(existing.createdAt).getTime();
    if (age < SUBMITTING_STALE_MS) {
      throw new ImageJobError(409, 'That image request was already submitted.');
    }
    // The create response never arrived, so there is no provider job to check.
    // Retrying could pay for a generation that already started.
    await markFailed(
      db,
      request.id,
      sub,
      'The provider never acknowledged this submission, so it cannot be checked or retried safely. It may still have been billed. Start a new request to generate again.',
    );
    throw new ImageJobError(
      409,
      'That submission was never acknowledged by the provider and may have been billed. Start a new request to generate again.',
    );
  }

  const startedAt = Date.now();
  try {
    if (spec.lifecycle === 'sync') {
      const image = await generateWithWorkersAi(env, spec, request.prompt);
      await markCompleted(
        db,
        request.id,
        sub,
        image,
        Math.round((Date.now() - startedAt) / 10) / 100,
      );
    } else {
      const creation = await createWithLeonardo(env, spec, request.prompt);
      await db
        .prepare(
          `UPDATE scene_image_jobs
              SET status = 'queued', provider_job_id = ?1, provider_credit_cost = ?2,
                  error = NULL, updated_at = ?3
            WHERE id = ?4 AND user_sub = ?5`,
        )
        .bind(creation.generationId, creation.creditCost, new Date().toISOString(), request.id, sub)
        .run();
    }
  } catch (error) {
    const failure =
      error instanceof ImageJobError
        ? error
        : new ImageJobError(502, 'The image generation could not be started.');
    await markFailed(db, request.id, sub, failure.message);
    throw failure;
  }

  const job = await readImageJob(db, sub, request.id);
  if (!job) throw new ImageJobError(500, 'The image job could not be recorded.');
  return { job, created: true };
}

/**
 * Advances one asynchronous job with Leonardo. Polling and downloading are free;
 * nothing here submits a new billable generation.
 */
export async function refreshImageJob(
  db: ImageJobDatabase,
  env: ImageEnv,
  sub: string,
  id: string,
): Promise<ImageJob> {
  await ensureImageSchema(db);
  const row = await readJobRow(db, sub, id);
  if (!row) throw new ImageJobError(404, 'That image job was not found.');
  const job = toJob(row);
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  const spec = imageModel(job.settings.modelId) ?? IMAGE_MODELS[0];
  if (!isProviderConfigured(env, spec.provider)) {
    throw new ImageJobError(503, providerConfigError(spec.provider));
  }

  const age = Date.now() - new Date(job.createdAt).getTime();
  if (job.status === 'submitting' || !job.providerJobId) {
    if (age < SUBMITTING_STALE_MS) return job;
    await markFailed(
      db,
      id,
      sub,
      'The provider never acknowledged this submission, so there is nothing to poll. It may still have been billed. Start a new request to generate again.',
    );
    return (await readImageJob(db, sub, id)) as ImageJob;
  }
  if (spec.lifecycle === 'sync') return job;
  if (age > PENDING_STALE_MS) {
    await markFailed(
      db,
      id,
      sub,
      'Leonardo did not finish this generation within ten minutes. Check your Leonardo history before generating it again.',
    );
    return (await readImageJob(db, sub, id)) as ImageJob;
  }

  const polled = await pollLeonardo(env, job.providerJobId);
  if (polled.status === 'PENDING') {
    await db
      .prepare(
        `UPDATE scene_image_jobs SET status = 'in_progress', updated_at = ?1
          WHERE id = ?2 AND user_sub = ?3`,
      )
      .bind(new Date().toISOString(), id, sub)
      .run();
    return (await readImageJob(db, sub, id)) as ImageJob;
  }
  if (polled.status === 'FAILED') {
    await markFailed(
      db,
      id,
      sub,
      'Leonardo reported that this generation failed. Leonardo decides whether a failed generation is charged.',
    );
    return (await readImageJob(db, sub, id)) as ImageJob;
  }
  if (!polled.imageUrl) {
    await markFailed(db, id, sub, 'Leonardo completed the job without returning an image.');
    return (await readImageJob(db, sub, id)) as ImageJob;
  }

  // A failed download leaves the job queued so the next check can retry it; the
  // generation itself is already paid for.
  const image = await downloadLeonardoImage(polled.imageUrl);
  // Leonardo reports no duration this code relies on, so measure the wait instead.
  await markCompleted(
    db,
    id,
    sub,
    image,
    Math.round((Date.now() - new Date(job.createdAt).getTime()) / 10) / 100,
  );
  const finished = await readImageJob(db, sub, id);
  if (!finished) throw new ImageJobError(500, 'The image job could not be read.');
  return finished;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  return null;
}

/** Serves the stored file so a refresh or a dropped response loses nothing. */
export async function fetchImageJobImage(
  db: ImageJobDatabase,
  sub: string,
  id: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  await ensureImageSchema(db);
  const row = await readJobRow(db, sub, id);
  if (!row) throw new ImageJobError(404, 'That image job was not found.');
  if (row.status !== 'completed') {
    throw new ImageJobError(409, 'That image is not ready yet.');
  }
  const rows = await db
    .prepare(
      'SELECT mime_type, bytes FROM scene_image_jobs WHERE id = ?1 AND user_sub = ?2',
    )
    .bind(id, sub)
    .all<{ mime_type: string | null; bytes: unknown }>();
  const stored = rows.results?.[0];
  const bytes = stored ? toBytes(stored.bytes) : null;
  if (!stored || !stored.mime_type || !bytes || bytes.byteLength === 0) {
    throw new ImageJobError(
      410,
      'That generated image is no longer stored. Generate it again to keep a copy.',
    );
  }
  return { bytes, mimeType: stored.mime_type };
}

/**
 * Cancels a Leonardo generation that is still queued. Workers AI answers in the
 * create call, so there is nothing to cancel there. Whether a cancelled
 * generation is charged is Leonardo's decision, so this promises no refund.
 */
export async function cancelImageJob(
  db: ImageJobDatabase,
  env: ImageEnv,
  sub: string,
  id: string,
): Promise<ImageJob> {
  await ensureImageSchema(db);
  const row = await readJobRow(db, sub, id);
  if (!row) throw new ImageJobError(404, 'That image job was not found.');
  const job = toJob(row);
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  const spec = imageModel(job.settings.modelId) ?? IMAGE_MODELS[0];
  if (spec.lifecycle === 'sync') {
    throw new ImageJobError(
      409,
      'This provider returns the image in the request itself, so there is nothing left to cancel.',
    );
  }
  if (!isProviderConfigured(env, spec.provider)) {
    throw new ImageJobError(503, providerConfigError(spec.provider));
  }
  if (!job.providerJobId) {
    throw new ImageJobError(
      409,
      'Leonardo has not returned a generation id for this request yet, so there is nothing to cancel. It may still be submitted.',
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${leonardoRoot(env)}/v1/generations/${encodeURIComponent(job.providerJobId)}`,
      {
        method: 'DELETE',
        headers: leonardoHeaders(env),
        signal: AbortSignal.timeout(LEONARDO_POLL_TIMEOUT_MS),
      },
    );
  } catch {
    throw new ImageJobError(
      504,
      'The cancellation request did not reach Leonardo. The generation may still complete.',
    );
  }
  if (!response.ok && response.status !== 404) {
    throw leonardoFailure(response.status, await readJson(response));
  }

  await db
    .prepare(
      `UPDATE scene_image_jobs SET status = 'cancelled', error = NULL, updated_at = ?1
        WHERE id = ?2 AND user_sub = ?3`,
    )
    .bind(new Date().toISOString(), id, sub)
    .run();
  const cancelled = await readImageJob(db, sub, id);
  if (!cancelled) throw new ImageJobError(500, 'The image job could not be read.');
  return cancelled;
}
