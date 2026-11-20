/**
 * Server-side scene image generation through Cloudflare Workers AI, verified
 * against Cloudflare's model and REST documentation on 2026-11-20:
 *
 * - POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/
 *     @cf/black-forest-labs/flux-1-schnell
 *   with `Authorization: Bearer $CF_API_TOKEN` and `{ prompt, steps }` answers
 *   `{ result: { image: "<base64 JPEG>" }, success, errors, messages }`.
 * - prompt is 1–2048 characters and steps 1–8. The model takes no seed, frame
 *   size or negative prompt, and rejects a parameter it does not document.
 * - Output is always one 1024×1024 JPEG, so no frame size is requested.
 * - The call is synchronous: one request either returns the image or fails, so
 *   there is no job to poll and nothing to cancel.
 *
 * The D1 row is the idempotency record, so a double click or a resent request id
 * never pays twice, and the finished bytes are kept server-side so a dropped
 * response loses nothing. A row left in `submitting` is never retried
 * automatically: that generation may already have been billed.
 */

import { IMAGE_MODEL, IMAGE_SIZE, IMAGE_STEPS, MAX_PROMPT_CHARS } from '../src/images/provider';

export const IMAGE_NOT_CONFIGURED =
  'Image generation is not configured. Add CF_ACCOUNT_ID and CF_API_TOKEN in Sites → Secrets, then redeploy.';

const PROVIDER_TIMEOUT_MS = 60_000;
/** A submission this old never recorded a result, so it is given up, not retried. */
const SUBMITTING_STALE_MS = 120_000;
/** A D1 row is limited to 2 MB, so a larger result cannot be kept. */
const MAX_RESULT_BYTES = 1_900_000;
/** Room for a MAX_RESULT_BYTES image once base64 expands it by a third. */
const MAX_PROVIDER_BODY_CHARS = 4_000_000;
const DEFAULT_AI_ROOT = 'https://api.cloudflare.com/client/v4';

export type ImageJobStatus = 'submitting' | 'completed' | 'failed';

export interface ImageJobSettings {
  /** The Workers AI model, recorded with every image. */
  model: string;
  steps: number;
  /** The style setting the prompt was composed for; recorded, not interpreted. */
  style: string;
}

export interface ImageJob {
  id: string;
  status: ImageJobStatus;
  model: string;
  prompt: string;
  settings: ImageJobSettings;
  sceneId: string;
  projectId: string;
  width: number | null;
  height: number | null;
  inferenceSeconds: number | null;
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

export interface WorkersAiEnv {
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  /** Test-only override; production calls api.cloudflare.com. */
  CF_AI_BASE?: string;
}

interface JobRow {
  id: string;
  status: string;
  model: string;
  prompt: string;
  settings: string;
  scene_id: string;
  project_id: string;
  width: number | null;
  height: number | null;
  inference_seconds: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** `bytes` is left out on purpose: reading a job must not read its 2 MB image. */
const JOB_COLUMNS = `id, status, model, prompt, settings, scene_id, project_id, width, height,
  inference_seconds, error, created_at, updated_at`;

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
 * Validates the request before anything is submitted or billed. The model and
 * step count are fixed by the server, so a client cannot select or spoof them.
 */
export function parseImageJobRequest(value: unknown): ImageJobRequest {
  if (!isRecord(value)) throw new ImageJobError(400, 'The image request must be an object.');
  const id = text(value.id, 'id', 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw new ImageJobError(400, 'id must be an 8–80 character request id.');
  }
  return {
    id,
    sceneId: text(value.sceneId, 'sceneId', 200),
    projectId: text(value.projectId, 'projectId', 200),
    prompt: text(value.prompt, 'prompt', MAX_PROMPT_CHARS),
    settings: {
      model: IMAGE_MODEL,
      steps: IMAGE_STEPS,
      style: typeof value.style === 'string' ? value.style.slice(0, 80) : '',
    },
  };
}

export function isImageProviderConfigured(env: WorkersAiEnv): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
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
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        settings TEXT NOT NULL,
        status TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        inference_seconds REAL,
        mime_type TEXT,
        bytes BLOB,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
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
  return {
    id: row.id,
    status: row.status as ImageJobStatus,
    model: row.model,
    prompt: row.prompt,
    settings: {
      model: row.model,
      steps: typeof stored.steps === 'number' ? stored.steps : IMAGE_STEPS,
      style: typeof stored.style === 'string' ? stored.style : '',
    },
    sceneId: row.scene_id,
    projectId: row.project_id,
    width: row.width,
    height: row.height,
    inferenceSeconds: row.inference_seconds,
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

function aiRoot(env: WorkersAiEnv): string {
  return (env.CF_AI_BASE || DEFAULT_AI_ROOT).replace(/\/+$/, '');
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  if (raw === '' || raw.length > MAX_PROVIDER_BODY_CHARS) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Cloudflare reports failures as `errors: [{ code, message }]`. */
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

/** Maps Workers AI's HTTP failures onto responses this app can show honestly. */
function providerFailure(status: number, body: Record<string, unknown> | null): ImageJobError {
  if (status === 401 || status === 403) {
    return new ImageJobError(
      503,
      'Cloudflare refused these credentials. Check that CF_API_TOKEN has Workers AI permission on this account.',
    );
  }
  if (status === 429) {
    return new ImageJobError(429, 'Cloudflare is rate-limiting Workers AI. Try again shortly.');
  }
  if (status === 400 || status === 422) {
    // The provider's own message names the rejection: a refused prompt, or the
    // account's daily Workers AI allowance being spent.
    return new ImageJobError(
      400,
      providerMessage(body, 'Cloudflare rejected this generation request.'),
    );
  }
  return new ImageJobError(
    502,
    providerMessage(body, `Cloudflare returned an unexpected response (${status}).`),
  );
}

function decodeBase64Image(value: string): Uint8Array {
  const payload = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw new ImageJobError(502, 'Cloudflare returned an unreadable image.');
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
  if (bytes.byteLength === 0) {
    throw new ImageJobError(502, 'Cloudflare returned an empty image.');
  }
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new ImageJobError(502, 'The generated image is too large to keep.');
  }
  const mimeType = sniffImageType(bytes);
  if (!mimeType) {
    throw new ImageJobError(502, 'Cloudflare returned an unsupported file type.');
  }
  return { bytes, mimeType };
}

/** One billable call. It is never retried here: a retry could pay twice. */
async function generateImage(
  env: WorkersAiEnv,
  prompt: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let response: Response;
  try {
    response = await fetch(
      `${aiRoot(env)}/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID ?? '')}/ai/run/${IMAGE_MODEL}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CF_API_TOKEN ?? ''}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ prompt, steps: IMAGE_STEPS }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
  } catch {
    throw new ImageJobError(
      504,
      'Cloudflare did not answer in time. The generation may still have been billed, so check the Workers AI usage log before generating this scene again.',
    );
  }
  const body = await readJson(response);
  if (!response.ok) throw providerFailure(response.status, body);
  const result = body && isRecord(body.result) ? body.result : null;
  const image = result && typeof result.image === 'string' ? result.image : null;
  if (!image) throw new ImageJobError(502, 'Cloudflare completed the request without an image.');
  return checkedImage(decodeBase64Image(image));
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

/**
 * Generates one scene image. The row is written before Cloudflare is called, so
 * a duplicate submission (double click, retry after a dropped response) finds
 * the record instead of paying for a second image.
 */
export async function submitImageJob(
  db: ImageJobDatabase,
  env: WorkersAiEnv,
  sub: string,
  request: ImageJobRequest,
  now: Date = new Date(),
): Promise<{ job: ImageJob; created: boolean }> {
  if (!isImageProviderConfigured(env)) {
    throw new ImageJobError(503, IMAGE_NOT_CONFIGURED);
  }
  await ensureImageSchema(db);

  const inserted = await db
    .prepare(
      `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, model, prompt, settings, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'submitting', ?8, ?8)
       ON CONFLICT(id) DO NOTHING RETURNING id`,
    )
    .bind(
      request.id,
      sub,
      request.projectId,
      request.sceneId,
      IMAGE_MODEL,
      request.prompt,
      JSON.stringify(request.settings),
      now.toISOString(),
    )
    .all<{ id: string }>();

  if ((inserted.results?.length ?? 0) === 0) {
    const existing = await readImageJob(db, sub, request.id);
    if (!existing) throw new ImageJobError(409, 'That request id is not available.');
    if (existing.status !== 'submitting') return { job: existing, created: false };
    const age = now.getTime() - new Date(existing.createdAt).getTime();
    if (age < SUBMITTING_STALE_MS) {
      throw new ImageJobError(409, 'That image request is already being generated.');
    }
    // No response was recorded, so there is nothing to check and nothing safe
    // to retry: Cloudflare may already have generated and billed this image.
    await markFailed(
      db,
      request.id,
      sub,
      'Cloudflare never answered this submission, so it cannot be retried safely. It may have been billed. Start a new request to generate again.',
    );
    throw new ImageJobError(
      409,
      'That submission was never answered and may have been billed. Start a new request to generate again.',
    );
  }

  const startedAt = Date.now();
  let image: { bytes: Uint8Array; mimeType: string };
  try {
    image = await generateImage(env, request.prompt);
  } catch (error) {
    const failure =
      error instanceof ImageJobError
        ? error
        : new ImageJobError(502, 'The image generation failed. Nothing was attached.');
    await markFailed(db, request.id, sub, failure.message);
    throw failure;
  }

  await db
    .prepare(
      `UPDATE scene_image_jobs
          SET status = 'completed', width = ?1, height = ?2, inference_seconds = ?3,
              mime_type = ?4, bytes = ?5, error = NULL, updated_at = ?6
        WHERE id = ?7 AND user_sub = ?8`,
    )
    .bind(
      IMAGE_SIZE,
      IMAGE_SIZE,
      Math.round((Date.now() - startedAt) / 10) / 100,
      image.mimeType,
      image.bytes,
      new Date().toISOString(),
      request.id,
      sub,
    )
    .run();

  const job = await readImageJob(db, sub, request.id);
  if (!job) throw new ImageJobError(500, 'The image job could not be recorded.');
  return { job, created: true };
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  return null;
}

/** Serves the stored file so a dropped response or a reload loses nothing. */
export async function fetchImageJobImage(
  db: ImageJobDatabase,
  sub: string,
  id: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  await ensureImageSchema(db);
  const row = await readJobRow(db, sub, id);
  if (!row) throw new ImageJobError(404, 'That image job was not found.');
  if (row.status !== 'completed') {
    throw new ImageJobError(409, 'That image was not generated successfully.');
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
