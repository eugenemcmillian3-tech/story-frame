/**
 * Server-side narration generation through the one TTS provider this app
 * offers. Every endpoint, parameter and price is quoted from the provider's own
 * documentation, checked on 2026-11-20.
 *
 * Deepgram's REST API, with the deployment's own DEEPGRAM_API_KEY:
 * - POST https://api.deepgram.com/v1/speak?model=aura-luna-en with
 *   `authorization: Token {key}` and `{ text }` answers with the audio bytes and
 *   `content-type: audio/mpeg`; mp3 is the documented default encoding.
 * - Aura-1 voices use the model name `aura-{voice}-en`, so the chosen voice is
 *   the model id sent in the query string.
 * - $0.015 per 1k characters. The request is billed once it reaches the
 *   provider, so a failed or aborted call is still counted here.
 *
 * The D1 row is both the quota unit and the job record: it is written before the
 * provider call, so a crash mid-call still leaves an auditable, billed job. A
 * repeated request id is refused rather than silently generating (and billing)
 * a second time.
 */

import {
  NARRATION_MODEL,
  estimateNarrationUsd,
  isNarrationVoice,
} from '../src/narration/provider';

export type NarrationPurpose = 'narration' | 'sample';
export type NarrationJobStatus = 'generating' | 'completed' | 'failed';

export interface NarrationJob {
  id: string;
  status: NarrationJobStatus;
  provider: string;
  model: string;
  voice: string;
  characters: number;
  estimatedUsd: number;
  scriptFingerprint: string | null;
  purpose: NarrationPurpose;
  projectId: string | null;
  attempts: number;
  providerStatus: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NarrationRequest {
  id: string;
  text: string;
  voice: string;
  purpose: NarrationPurpose;
  projectId: string | null;
  scriptFingerprint: string | null;
}

export class NarrationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'NarrationError';
    this.status = status;
  }
}

interface Statement {
  bind(...values: unknown[]): Statement;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface NarrationDatabase {
  prepare(query: string): Statement;
}

export interface NarrationEnv {
  DEEPGRAM_API_KEY?: string;
  /** Test-only override; production calls Deepgram's own API host. */
  DEEPGRAM_API_BASE?: string;
}

/** One billed generation plus one retry at most. */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;
const PROVIDER_TIMEOUT_MS = 60_000;
const DAILY_LIMIT = 20;
const MINUTE_LIMIT = 3;
const MAX_ID_LENGTH = 120;
const DEFAULT_DEEPGRAM_API = 'https://api.deepgram.com';

const schemaReady = new WeakSet<object>();

export async function ensureNarrationSchema(db: NarrationDatabase): Promise<void> {
  if (schemaReady.has(db as unknown as object)) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS narration_jobs (
        id TEXT PRIMARY KEY,
        user_sub TEXT NOT NULL,
        project_id TEXT,
        purpose TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        voice TEXT NOT NULL,
        characters INTEGER NOT NULL,
        estimated_usd REAL NOT NULL,
        script_fingerprint TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        provider_status INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    )
    .run();
  schemaReady.add(db as unknown as object);
}

interface JobRow {
  id: string;
  project_id: string | null;
  purpose: string;
  provider: string;
  model: string;
  voice: string;
  characters: number;
  estimated_usd: number;
  script_fingerprint: string | null;
  status: string;
  attempts: number;
  provider_status: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): NarrationJob {
  return {
    id: row.id,
    status: row.status as NarrationJobStatus,
    provider: row.provider,
    model: row.model,
    voice: row.voice,
    characters: row.characters,
    estimatedUsd: row.estimated_usd,
    scriptFingerprint: row.script_fingerprint,
    purpose: row.purpose as NarrationPurpose,
    projectId: row.project_id,
    attempts: row.attempts,
    providerStatus: row.provider_status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Validates one request. The text is spoken exactly as sent: the caller is
 * responsible for sending the saved script, and nothing here rewrites it.
 */
export function parseNarrationRequest(body: unknown): NarrationRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new NarrationError(400, 'The narration request is not readable.');
  }
  const raw = body as Record<string, unknown>;
  const id = asString(raw.id)?.trim() ?? '';
  if (id === '' || id.length > MAX_ID_LENGTH) {
    throw new NarrationError(400, 'The narration request needs a valid request id.');
  }
  const text = asString(raw.text) ?? '';
  if (text.trim() === '') {
    throw new NarrationError(400, 'There is no script text to speak yet.');
  }
  if (text.length > NARRATION_MODEL.maxCharacters) {
    throw new NarrationError(
      400,
      `This app sends at most ${NARRATION_MODEL.maxCharacters} characters per narration request; this script is ${text.length}.`,
    );
  }
  const voice = asString(raw.voice) ?? '';
  if (!isNarrationVoice(voice)) {
    throw new NarrationError(400, 'That voice is not one the provider offers.');
  }
  const purpose =
    raw.purpose === 'sample' || raw.purpose === 'narration' ? raw.purpose : null;
  if (purpose === null) {
    throw new NarrationError(400, 'The narration request needs a purpose of narration or sample.');
  }
  return {
    id,
    text,
    voice,
    purpose,
    projectId: asString(raw.projectId)?.slice(0, 120) ?? null,
    scriptFingerprint: asString(raw.scriptFingerprint)?.slice(0, 200) ?? null,
  };
}

function dayStartIso(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function minuteStartIso(now: Date): string {
  return `${now.toISOString().slice(0, 16)}:00.000Z`;
}

async function countSince(db: NarrationDatabase, userSub: string, since: string): Promise<number> {
  const rows = await db
    .prepare(
      'SELECT COUNT(*) AS used FROM narration_jobs WHERE user_sub = ?1 AND created_at >= ?2',
    )
    .bind(userSub, since)
    .all<{ used: number }>();
  return rows.results?.[0]?.used ?? 0;
}

export interface NarrationUsage {
  dailyLimit: number;
  minuteLimit: number;
  usedToday: number;
  usedThisMinute: number;
  estimatedUsdToday: number;
  jobs: NarrationJob[];
}

/** Reads today's spend without consuming anything, for the panel's display. */
export async function listNarrationUsage(
  db: NarrationDatabase,
  userSub: string,
): Promise<NarrationUsage> {
  const now = new Date();
  const dayStart = dayStartIso(now);
  const rows = await db
    .prepare(
      `SELECT id, project_id, purpose, provider, model, voice, characters, estimated_usd,
              script_fingerprint, status, attempts, provider_status, error, created_at, updated_at
         FROM narration_jobs
        WHERE user_sub = ?1 AND created_at >= ?2
        ORDER BY created_at DESC
        LIMIT 20`,
    )
    .bind(userSub, dayStart)
    .all<JobRow>();
  const jobs = (rows.results ?? []).map(toJob);
  const minuteStart = minuteStartIso(now);
  return {
    dailyLimit: DAILY_LIMIT,
    minuteLimit: MINUTE_LIMIT,
    usedToday: jobs.length,
    // The daily limit caps this list, so it already holds every billed job of the day.
    usedThisMinute: jobs.filter((job) => job.createdAt >= minuteStart).length,
    estimatedUsdToday: Number(jobs.reduce((total, job) => total + job.estimatedUsd, 0).toFixed(6)),
    jobs,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProviderResult {
  bytes: Uint8Array;
  mimeType: string;
  attempts: number;
  providerStatus: number;
}

const UNREACHABLE =
  'The text-to-speech provider could not be reached. The request may still be billed; check the usage list before retrying.';
const MAYBE_BILLED = ' The provider may have billed this attempt.';

type SpeechAttempt =
  | { ok: true; result: ProviderResult }
  | { ok: false; retryable: boolean; error: NarrationError };

/**
 * One provider call. Only a transport error or a 429/5xx is worth repeating; a
 * 4xx answer is final because retrying it cannot help.
 */
async function attemptSpeech(
  env: NarrationEnv,
  text: string,
  voice: string,
  attempt: number,
): Promise<SpeechAttempt> {
  const root = (env.DEEPGRAM_API_BASE || DEFAULT_DEEPGRAM_API).replace(/\/+$/, '');
  const url = `${root}/v1/speak?model=${encodeURIComponent(voice)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, retryable: true, error: new NarrationError(502, UNREACHABLE) };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      retryable: false,
      error: new NarrationError(
        503,
        'The deployment’s Deepgram API key was refused. Check DEEPGRAM_API_KEY in Sites → Secrets.',
      ),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status === 429 || response.status >= 500,
      error:
        response.status === 429
          ? new NarrationError(
              429,
              `The text-to-speech provider is rate limiting this account. Try again shortly.${MAYBE_BILLED}`,
            )
          : new NarrationError(
              502,
              `The text-to-speech provider refused the request (HTTP ${response.status}).${MAYBE_BILLED}`,
            ),
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      retryable: false,
      error: new NarrationError(502, 'The provider returned empty audio. Nothing was saved.'),
    };
  }
  return {
    ok: true,
    result: {
      bytes,
      mimeType: response.headers.get('content-type') || 'audio/mpeg',
      attempts: attempt,
      providerStatus: response.status,
    },
  };
}

/** One billed generation, retried at most once. */
async function callProvider(
  env: NarrationEnv,
  text: string,
  voice: string,
): Promise<ProviderResult> {
  const first = await attemptSpeech(env, text, voice, 1);
  if (first.ok) return first.result;
  if (!first.retryable) throw first.error;
  await sleep(RETRY_DELAY_MS);
  const second = await attemptSpeech(env, text, voice, 2);
  if (second.ok) return second.result;
  throw second.error;
}

/**
 * Generates one take. The D1 row is written before the provider is called, so
 * the quota is consumed even when the call fails: the provider may have billed
 * it, and this app never pretends otherwise.
 */
export async function generateNarration(
  db: NarrationDatabase,
  env: NarrationEnv,
  userSub: string,
  request: NarrationRequest,
): Promise<{ job: NarrationJob; bytes: Uint8Array; mimeType: string }> {
  if (!env.DEEPGRAM_API_KEY) {
    throw new NarrationError(
      503,
      'Narration is not configured on this deployment. Add DEEPGRAM_API_KEY in Sites → Secrets.',
    );
  }

  const existing = await db
    .prepare('SELECT id FROM narration_jobs WHERE id = ?1 AND user_sub = ?2')
    .bind(request.id, userSub)
    .all<{ id: string }>();
  if ((existing.results ?? []).length > 0) {
    throw new NarrationError(
      409,
      'That narration request was already submitted. Start a new generation for another take; it is billed again.',
    );
  }

  const now = new Date();
  if ((await countSince(db, userSub, dayStartIso(now))) >= DAILY_LIMIT) {
    throw new NarrationError(
      429,
      `This account has used all ${DAILY_LIMIT} narration generations for today.`,
    );
  }
  if ((await countSince(db, userSub, minuteStartIso(now))) >= MINUTE_LIMIT) {
    throw new NarrationError(
      429,
      `Narration is limited to ${MINUTE_LIMIT} generations per minute. Wait a moment and try again.`,
    );
  }

  const characters = request.text.length;
  const estimatedUsd = estimateNarrationUsd(characters);
  const createdAt = now.toISOString();
  // One row describes the job for the insert, the response and the usage list.
  const row: JobRow = {
    id: request.id,
    project_id: request.projectId,
    purpose: request.purpose,
    provider: NARRATION_MODEL.provider,
    model: NARRATION_MODEL.model,
    voice: request.voice,
    characters,
    estimated_usd: estimatedUsd,
    script_fingerprint: request.scriptFingerprint,
    status: 'generating',
    attempts: 0,
    provider_status: null,
    error: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  await db
    .prepare(
      `INSERT INTO narration_jobs
        (id, user_sub, project_id, purpose, provider, model, voice, characters, estimated_usd,
         script_fingerprint, status, attempts, provider_status, error, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'generating', 0, NULL, NULL, ?11, ?11)`,
    )
    .bind(
      row.id,
      userSub,
      row.project_id,
      row.purpose,
      row.provider,
      row.model,
      row.voice,
      row.characters,
      row.estimated_usd,
      row.script_fingerprint,
      row.created_at,
    )
    .run();

  try {
    const result = await callProvider(env, request.text, request.voice);
    const updatedAt = new Date().toISOString();
    await db
      .prepare(
        `UPDATE narration_jobs
            SET status = 'completed', attempts = ?3, provider_status = ?4, error = NULL, updated_at = ?5
          WHERE id = ?1 AND user_sub = ?2`,
      )
      .bind(request.id, userSub, result.attempts, result.providerStatus, updatedAt)
      .run();
    return {
      job: toJob({
        ...row,
        status: 'completed',
        attempts: result.attempts,
        provider_status: result.providerStatus,
        updated_at: updatedAt,
      }),
      bytes: result.bytes,
      mimeType: result.mimeType,
    };
  } catch (error) {
    const failure = error instanceof NarrationError ? error : new NarrationError(502, 'Narration failed.');
    await db
      .prepare(
        `UPDATE narration_jobs
            SET status = 'failed', error = ?3, updated_at = ?4
          WHERE id = ?1 AND user_sub = ?2`,
      )
      .bind(request.id, userSub, failure.message.slice(0, 500), new Date().toISOString())
      .run();
    throw failure;
  }
}
