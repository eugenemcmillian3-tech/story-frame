// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock('@freebuff/auth', () => ({
  createFreebuffAuth: () => ({
    getUser: mocks.getUser,
    wrap: (handler: unknown) => handler,
  }),
  isSameOriginRequest: (request: Request, origin: string) =>
    request.headers.get('origin') === origin,
}));

import {
  ensureImageSchema,
  fetchImageJobImage,
  parseImageJobRequest,
  readImageJob,
  submitImageJob,
} from '../worker/imageJobs';
import { IMAGE_MODEL, IMAGE_USD_ESTIMATE } from '../src/images/provider';
import worker from '../worker/index';

const APP_ORIGIN = 'https://app.test';
const BASE = 'https://ai.test/client/v4';
const RUN_URL = `${BASE}/accounts/acct_1/ai/run/${IMAGE_MODEL}`;

/** A D1-shaped shim over real SQLite, so the production SQL is what is tested. */
function sqliteDb() {
  const database = new DatabaseSync(':memory:');
  return {
    database,
    prepare(query: string) {
      const statement = database.prepare(query);
      let args: unknown[] = [];
      const bound = {
        bind(...values: unknown[]) {
          args = values;
          return bound;
        },
        async all<T = unknown>() {
          return { results: statement.all(...(args as never[])) as T[] };
        },
        async run() {
          statement.run(...(args as never[]));
          return {};
        },
      };
      return bound;
    },
  };
}

type TestDb = ReturnType<typeof sqliteDb>;

const env = { CF_ACCOUNT_ID: 'acct_1', CF_API_TOKEN: 'token_1', CF_AI_BASE: BASE };

/** The first bytes of a real JPEG; the server sniffs the file type from them. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_BASE64 = Buffer.from(JPEG).toString('base64');

const request = {
  id: 'ij_12345678',
  sceneId: 'scn_1',
  projectId: 'prj_1',
  prompt: 'A quiet kitchen at dawn, no words.',
  settings: { model: IMAGE_MODEL, steps: 4, style: 'cinema-still' },
};

const parseBody = {
  id: 'ij_12345678',
  sceneId: 'scn_1',
  projectId: 'prj_1',
  prompt: 'A quiet kitchen.',
  style: 'preset',
};

function generated(image = JPEG_BASE64) {
  return Response.json({ result: { image }, success: true, errors: [], messages: [] });
}

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.getUser.mockResolvedValue({ sub: 'user_1' });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(generated());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image job request validation', () => {
  it('records the one model and step count the server uses', () => {
    const parsed = parseImageJobRequest(parseBody);
    expect(parsed.settings).toEqual({ model: IMAGE_MODEL, steps: 4, style: 'preset' });
  });

  it('ignores a client-supplied model, size or step count', () => {
    const parsed = parseImageJobRequest({
      ...parseBody,
      modelId: 'someone-else',
      width: 1_792,
      steps: 8,
    });
    expect(parsed.settings.model).toBe(IMAGE_MODEL);
    expect(parsed.settings.steps).toBe(4);
  });

  it('rejects malformed fields before anything is billed', () => {
    expect(() => parseImageJobRequest({ ...parseBody, prompt: '   ' })).toThrow(/required/);
    expect(() => parseImageJobRequest({ ...parseBody, prompt: 'x'.repeat(2_049) })).toThrow(
      /too long/,
    );
    expect(() => parseImageJobRequest({ ...parseBody, id: 'short' })).toThrow(/request id/);
    expect(() => parseImageJobRequest({ ...parseBody, sceneId: 4 })).toThrow(/sceneId/);
    expect(() => parseImageJobRequest('nope')).toThrow(/object/);
  });
});

describe('generation', () => {
  it('calls Workers AI once and records the finished image', async () => {
    const db = sqliteDb();
    const { job, created } = await submitImageJob(db as never, env, 'user_1', request);

    expect(created).toBe(true);
    expect(job.status).toBe('completed');
    expect(job.model).toBe(IMAGE_MODEL);
    expect(job.width).toBe(1_024);
    expect(job.height).toBe(1_024);
    expect(job.inferenceSeconds).not.toBeNull();
    expect(job.error).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RUN_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token_1');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: request.prompt, steps: 4 });

    const file = await fetchImageJobImage(db as never, 'user_1', request.id);
    expect(file.mimeType).toBe('image/jpeg');
    expect(Array.from(file.bytes)).toEqual(Array.from(JPEG));
  });

  it('returns the recorded job for a duplicate request id instead of paying twice', async () => {
    const db = sqliteDb();
    const first = await submitImageJob(db as never, env, 'user_1', request);
    const second = await submitImageJob(db as never, env, 'user_1', request);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let another account reuse a request id', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', request);
    await expect(submitImageJob(db as never, env, 'user_2', request)).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to generate without the Workers AI credentials', async () => {
    const db = sqliteDb();
    await expect(submitImageJob(db as never, {}, 'user_1', request)).rejects.toMatchObject({
      status: 503,
    });
    await expect(submitImageJob(db as never, {}, 'user_1', request)).rejects.toThrow(
      /CF_ACCOUNT_ID and CF_API_TOKEN/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records a provider rejection as failed and does not retry it', async () => {
    const db = sqliteDb();
    fetchMock.mockResolvedValue(
      Response.json(
        { success: false, errors: [{ code: 5006, message: 'Prompt contains disallowed content.' }] },
        { status: 400 },
      ),
    );
    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = await readImageJob(db as never, 'user_1', request.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('disallowed');
    await expect(fetchImageJobImage(db as never, 'user_1', request.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('names a spent Workers AI allowance through the provider message', async () => {
    const db = sqliteDb();
    fetchMock.mockResolvedValue(
      Response.json(
        { success: false, errors: [{ code: 3040, message: 'Daily neurons limit exceeded.' }] },
        { status: 400 },
      ),
    );
    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toThrow(
      /Daily neurons limit exceeded/,
    );
  });

  it('maps refused credentials and rate limits without claiming success', async () => {
    const db = sqliteDb();
    fetchMock.mockResolvedValueOnce(Response.json({ success: false, errors: [] }, { status: 403 }));
    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toMatchObject({
      status: 503,
    });

    const second = sqliteDb();
    fetchMock.mockResolvedValueOnce(Response.json({ success: false, errors: [] }, { status: 429 }));
    await expect(
      submitImageJob(second as never, env, 'user_1', { ...request, id: 'ij_87654321' }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('rejects an unreadable image payload', async () => {
    const db = sqliteDb();
    fetchMock.mockResolvedValue(generated(Buffer.from('not an image').toString('base64')));
    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toMatchObject({
      status: 502,
    });
    const job = await readImageJob(db as never, 'user_1', request.id);
    expect(job?.status).toBe('failed');
  });

  it('rejects an image too large to store', async () => {
    const db = sqliteDb();
    const big = new Uint8Array(1_900_001);
    big.set(JPEG);
    fetchMock.mockResolvedValue(generated(Buffer.from(big).toString('base64')));
    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toThrow(
      /too large/,
    );
  });

  it('gives up on a submission that never finished, without retrying it', async () => {
    const db = sqliteDb();
    await ensureImageSchema(db as never);
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await db
      .prepare(
        `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, model, prompt, settings, status, created_at, updated_at)
         VALUES (?1, 'user_1', 'prj_1', 'scn_1', ?2, 'p', '{}', 'submitting', ?3, ?3)`,
      )
      .bind(request.id, IMAGE_MODEL, stale)
      .run();

    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = await readImageJob(db as never, 'user_1', request.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('never answered');
  });

  it('refuses to resubmit a request that is still in flight', async () => {
    const db = sqliteDb();
    await ensureImageSchema(db as never);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, model, prompt, settings, status, created_at, updated_at)
         VALUES (?1, 'user_1', 'prj_1', 'scn_1', ?2, 'p', '{}', 'submitting', ?3, ?3)`,
      )
      .bind(request.id, IMAGE_MODEL, now)
      .run();

    await expect(submitImageJob(db as never, env, 'user_1', request)).rejects.toMatchObject({
      status: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('stored results', () => {
  it('never returns another account’s file', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', request);
    await expect(fetchImageJobImage(db as never, 'user_2', request.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('reports a missing stored file instead of an empty image', async () => {
    const db = sqliteDb();
    await ensureImageSchema(db as never);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, model, prompt, settings, status, created_at, updated_at)
         VALUES (?1, 'user_1', 'prj_1', 'scn_1', ?2, 'p', '{}', 'completed', ?3, ?3)`,
      )
      .bind(request.id, IMAGE_MODEL, now)
      .run();
    await expect(fetchImageJobImage(db as never, 'user_1', request.id)).rejects.toMatchObject({
      status: 410,
    });
  });
});

describe('image routes', () => {
  function postJob(body: unknown, headers: Record<string, string> = {}) {
    return new Request(`${APP_ORIGIN}/api/images/jobs`, {
      method: 'POST',
      headers: {
        origin: APP_ORIGIN,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  function testEnv(db: TestDb = sqliteDb(), overrides: Record<string, unknown> = {}) {
    return {
      ASSETS: { fetch: async () => new Response('asset') },
      DB: db,
      FREEBUFF_CLIENT_ID: 'test-client',
      FREEBUFF_ISSUER: 'https://freebuff.com/oidc',
      APP_ORIGIN,
      CF_ACCOUNT_ID: 'acct_1',
      CF_API_TOKEN: 'token_1',
      CF_AI_BASE: BASE,
      ...overrides,
    };
  }

  it('requires sign-in and a same-origin request', async () => {
    mocks.getUser.mockResolvedValue(null);
    expect((await worker.fetch(postJob(parseBody), testEnv() as never)).status).toBe(401);

    mocks.getUser.mockResolvedValue({ sub: 'user_1' });
    const foreign = await worker.fetch(
      postJob(parseBody, { origin: 'https://evil.test' }),
      testEnv() as never,
    );
    expect(foreign.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to start without the credentials and names them', async () => {
    const response = await worker.fetch(
      postJob(parseBody),
      testEnv(sqliteDb(), { CF_API_TOKEN: undefined }) as never,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('CF_API_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts one job, then serves its record and its file', async () => {
    const db = sqliteDb();
    const goodEnv = testEnv(db);
    const response = await worker.fetch(postJob(parseBody), goodEnv as never);
    expect(response.status).toBe(201);
    const createdJob = (await response.json()) as { job: { id: string; status: string } };
    expect(createdJob.job.id).toBe(parseBody.id);
    expect(createdJob.job.status).toBe('completed');

    const check = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs/${parseBody.id}`),
      goodEnv as never,
    );
    expect(check.status).toBe(200);
    const status = (await check.json()) as { job: { status: string } };
    expect(status.job.status).toBe('completed');

    const file = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs/${parseBody.id}/image`),
      goodEnv as never,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(JPEG));
  });

  it('returns the same job for a repeated request without a second generation', async () => {
    const goodEnv = testEnv();
    const first = await worker.fetch(postJob(parseBody), goodEnv as never);
    await first.text();
    const second = await worker.fetch(postJob(parseBody), goodEnv as never);
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await second.text();
  });

  it('rejects a request over the body limit before the provider is called', async () => {
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs`, {
        method: 'POST',
        headers: { origin: APP_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ ...parseBody, prompt: 'x'.repeat(5_000_000) }),
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never returns another account’s job', async () => {
    const db = sqliteDb();
    const goodEnv = testEnv(db);
    const created = await worker.fetch(postJob(parseBody), goodEnv as never);
    await created.text();
    mocks.getUser.mockResolvedValue({ sub: 'user_2' });
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs/${parseBody.id}`),
      goodEnv as never,
    );
    expect(response.status).toBe(404);
  });

  it('counts one generation against the daily budget', async () => {
    const db = sqliteDb();
    await worker.fetch(postJob(parseBody), testEnv(db) as never);
    const rows = db.database
      .prepare("SELECT window_key, requests FROM ai_usage WHERE window_key LIKE 'img:%'")
      .all() as Array<{ window_key: string; requests: number }>;
    const day = rows.find((row) => row.window_key.startsWith('img:d:'));
    expect(day?.requests).toBe(1);
  });

  it('reports the published estimate the client shows', () => {
    expect(IMAGE_USD_ESTIMATE).toBeCloseTo(0.0019008, 7);
  });
});
