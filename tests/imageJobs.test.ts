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
  cancelImageJob,
  ensureImageSchema,
  fetchImageJobImage,
  parseImageJobRequest,
  readImageJob,
  refreshImageJob,
  submitImageJob,
} from '../worker/imageJobs';
import { IMAGE_MODELS, imageModel } from '../src/images/provider';
import worker from '../worker/index';

const APP_ORIGIN = 'https://app.test';
const CF_BASE = 'https://cf.test/client/v4';
const LEO_BASE = 'https://leo.test/api/rest';
const CDN_URL = 'https://cdn.leo.test/a.jpg';
const CF_MODEL = imageModel('cf-flux-schnell')!.model;
const LEO_MODEL = imageModel('leonardo-phoenix')!.model;

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

const env = {
  CF_ACCOUNT_ID: 'acct_1',
  CF_API_TOKEN: 'token_1',
  CF_AI_BASE: CF_BASE,
  LEONARDO_API_KEY: 'key_1',
  LEONARDO_API_BASE: LEO_BASE,
};

/** The first bytes of a real JPEG; the server sniffs the file type from them. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_BASE64 = Buffer.from(JPEG).toString('base64');

const cloudflareRequest = {
  id: 'ij_cf_12345678',
  sceneId: 'scn_1',
  projectId: 'prj_1',
  prompt: 'A quiet kitchen at dawn, no words.',
  settings: { modelId: 'cf-flux-schnell' as const, style: 'cinema-still' },
};

const leonardoRequest = {
  id: 'ij_leo_12345678',
  sceneId: 'scn_1',
  projectId: 'prj_1',
  prompt: 'A quiet kitchen at dawn, no words.',
  settings: { modelId: 'leonardo-phoenix' as const, style: 'cinema-still' },
};

function cfGenerated(image = JPEG_BASE64) {
  return Response.json({ result: { image }, success: true, errors: [], messages: [] });
}

function leonardoPoll(
  status: 'PENDING' | 'COMPLETE' | 'FAILED',
  options: { url?: string | null } = {},
) {
  const url = options.url === undefined ? CDN_URL : options.url;
  return Response.json({
    generations_by_pk: {
      status,
      generated_images: status === 'COMPLETE' && url ? [{ url, id: 'img_1' }] : [],
    },
  });
}

interface RouterOptions {
  cf?: () => Response;
  create?: () => Response;
  poll?: () => Response;
  image?: () => Response;
  remove?: () => Response;
}

/** Routes the Workers AI call, the three Leonardo calls and the CDN download. */
function router(options: RouterOptions = {}) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === `${CF_BASE}/accounts/acct_1/ai/run/${CF_MODEL}`) {
      return options.cf ? options.cf() : cfGenerated();
    }
    if (url === `${LEO_BASE}/v2/generations`) {
      return options.create
        ? options.create()
        : Response.json({ generate: { generationId: 'gen_1', apiCreditCost: 12 } });
    }
    if (url.startsWith(`${LEO_BASE}/v1/generations/`)) {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        return options.remove
          ? options.remove()
          : Response.json({ delete_generations_by_pk: { id: 'gen_1' } });
      }
      return options.poll ? options.poll() : leonardoPoll('COMPLETE');
    }
    if (url === CDN_URL) {
      return options.image
        ? options.image()
        : new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  mocks.getUser.mockReset();
  mocks.getUser.mockResolvedValue({ sub: 'user_1' });
  fetchMock.mockReset();
  fetchMock.mockImplementation(router());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image job request validation', () => {
  it('accepts both providers’ models and records the chosen one', () => {
    expect(parseImageJobRequest({ ...cloudflareRequest, settings: undefined }).settings.modelId).toBe(
      'cf-flux-schnell',
    );
    expect(
      parseImageJobRequest({
        id: 'ij_12345678',
        sceneId: 's',
        projectId: 'p',
        prompt: 'x',
        modelId: 'leonardo-lucid-origin',
      }).settings.modelId,
    ).toBe('leonardo-lucid-origin');
    expect(IMAGE_MODELS).toHaveLength(3);
  });

  it('rejects an unverified model, a blank prompt and a prompt over the model’s cap', () => {
    const base = {
      id: 'ij_12345678',
      sceneId: 's',
      projectId: 'p',
      prompt: 'x',
    };
    expect(() => parseImageJobRequest({ ...base, modelId: 'midjourney' })).toThrow(/not supported/);
    expect(() => parseImageJobRequest({ ...base, prompt: '  ' })).toThrow(/required/);
    // Phoenix caps prompts at 2000 characters, FLUX.1 Schnell at 2048.
    expect(() =>
      parseImageJobRequest({ ...base, modelId: 'leonardo-phoenix', prompt: 'x'.repeat(2_001) }),
    ).toThrow(/2000/);
    expect(() =>
      parseImageJobRequest({ ...base, modelId: 'cf-flux-schnell', prompt: 'x'.repeat(2_049) }),
    ).toThrow(/too long/);
    expect(() => parseImageJobRequest({ ...base, id: 'short' })).toThrow(/request id/);
  });
});

describe('Cloudflare Workers AI', () => {
  it('generates synchronously and records the image', async () => {
    const db = sqliteDb();
    const { job, created } = await submitImageJob(db as never, env, 'user_1', cloudflareRequest);

    expect(created).toBe(true);
    expect(job.status).toBe('completed');
    expect(job.provider).toBe('workers-ai');
    expect(job.model).toBe(CF_MODEL);
    expect(job.width).toBe(1_024);
    expect(job.height).toBe(1_024);
    expect(job.providerCreditCost).toBeNull();
    expect(job.inferenceSeconds).not.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CF_BASE}/accounts/acct_1/ai/run/${CF_MODEL}`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token_1');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: cloudflareRequest.prompt, steps: 4 });

    const file = await fetchImageJobImage(db as never, 'user_1', cloudflareRequest.id);
    expect(file.mimeType).toBe('image/jpeg');
    expect(Array.from(file.bytes)).toEqual(Array.from(JPEG));
  });

  it('refuses to generate without its own credentials', async () => {
    const db = sqliteDb();
    await expect(
      submitImageJob(db as never, { LEONARDO_API_KEY: 'key_1' }, 'user_1', cloudflareRequest),
    ).rejects.toThrow(/CF_ACCOUNT_ID and CF_API_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Leonardo.Ai', () => {
  it('queues a generation, records its id and credit cost, then polls it', async () => {
    const db = sqliteDb();
    const { job } = await submitImageJob(db as never, env, 'user_1', leonardoRequest);

    expect(job.status).toBe('queued');
    expect(job.provider).toBe('leonardo');
    expect(job.model).toBe(LEO_MODEL);
    expect(job.providerJobId).toBe('gen_1');
    expect(job.providerCreditCost).toBe(12);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as {
      model: string;
      public: boolean;
      parameters: Record<string, unknown>;
    };
    expect(sent.model).toBe(LEO_MODEL);
    expect(sent.public).toBe(false);
    expect(sent.parameters).toMatchObject({
      prompt: leonardoRequest.prompt,
      width: 1_024,
      height: 1_792,
      quantity: 1,
      mode: 'FAST',
      prompt_enhance: 'OFF',
    });
    expect(typeof sent.parameters.seed).toBe('number');
    expect(typeof sent.parameters.negative_prompt).toBe('string');

    const finished = await refreshImageJob(db as never, env, 'user_1', leonardoRequest.id);
    expect(finished.status).toBe('completed');
    expect(finished.inferenceSeconds).toBeGreaterThanOrEqual(0);
    const file = await fetchImageJobImage(db as never, 'user_1', leonardoRequest.id);
    expect(Array.from(file.bytes)).toEqual(Array.from(JPEG));
  });

  it('sends Lucid Origin only the parameters it documents', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', {
      ...leonardoRequest,
      id: 'ij_lucid_12345678',
      settings: { modelId: 'leonardo-lucid-origin', style: 'preset' },
    });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      model: string;
      parameters: Record<string, unknown>;
    };
    expect(sent.model).toBe('lucid-origin');
    expect(sent.parameters.seed).toBeUndefined();
    expect(sent.parameters.negative_prompt).toBeUndefined();
  });

  it('reports progress instead of completing on PENDING', async () => {
    const db = sqliteDb();
    fetchMock.mockImplementation(router({ poll: () => leonardoPoll('PENDING') }));
    await submitImageJob(db as never, env, 'user_1', leonardoRequest);
    const job = await refreshImageJob(db as never, env, 'user_1', leonardoRequest.id);
    expect(job.status).toBe('in_progress');
  });

  it('records a failed generation with the provider’s decision on charging', async () => {
    const db = sqliteDb();
    fetchMock.mockImplementation(router({ poll: () => leonardoPoll('FAILED') }));
    await submitImageJob(db as never, env, 'user_1', leonardoRequest);
    const job = await refreshImageJob(db as never, env, 'user_1', leonardoRequest.id);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('charged');
  });

  it('fails a completed generation that carries no image', async () => {
    const db = sqliteDb();
    fetchMock.mockImplementation(router({ poll: () => leonardoPoll('COMPLETE', { url: null }) }));
    await submitImageJob(db as never, env, 'user_1', leonardoRequest);
    const job = await refreshImageJob(db as never, env, 'user_1', leonardoRequest.id);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('without returning an image');
  });

  it('keeps a failed download retryable instead of losing the paid image', async () => {
    const db = sqliteDb();
    fetchMock.mockImplementation(router({ image: () => new Response('nope', { status: 500 }) }));
    await submitImageJob(db as never, env, 'user_1', leonardoRequest);
    await expect(refreshImageJob(db as never, env, 'user_1', leonardoRequest.id)).rejects.toMatchObject(
      { status: 502 },
    );
    const job = await readImageJob(db as never, 'user_1', leonardoRequest.id);
    expect(job?.status).toBe('queued');
  });

  it('cancels a queued generation at Leonardo', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', leonardoRequest);
    const job = await cancelImageJob(db as never, env, 'user_1', leonardoRequest.id);
    expect(job.status).toBe('cancelled');
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`${LEO_BASE}/v1/generations/gen_1`);
    expect(init.method).toBe('DELETE');
  });

  it('refuses to cancel a synchronous image that already completed', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', cloudflareRequest);
    const job = await cancelImageJob(db as never, env, 'user_1', cloudflareRequest.id);
    expect(job.status).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to generate without its own key', async () => {
    const db = sqliteDb();
    await expect(
      submitImageJob(
        db as never,
        { CF_ACCOUNT_ID: 'acct_1', CF_API_TOKEN: 'token_1' },
        'user_1',
        leonardoRequest,
      ),
    ).rejects.toThrow(/LEONARDO_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a moderation refusal without retrying it', async () => {
    const db = sqliteDb();
    fetchMock.mockImplementation(
      router({
        create: () =>
          Response.json({ error: 'content moderation filter: naked' }, { status: 403 }),
      }),
    );
    await expect(submitImageJob(db as never, env, 'user_1', leonardoRequest)).rejects.toMatchObject({
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const job = await readImageJob(db as never, 'user_1', leonardoRequest.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('moderation');
  });
});

describe('idempotency and stale submissions', () => {
  it('returns the recorded job for a duplicate request id instead of paying twice', async () => {
    const db = sqliteDb();
    const first = await submitImageJob(db as never, env, 'user_1', cloudflareRequest);
    const second = await submitImageJob(db as never, env, 'user_1', cloudflareRequest);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let another account reuse a request id', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', cloudflareRequest);
    await expect(
      submitImageJob(db as never, env, 'user_2', cloudflareRequest),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a submission that never finished, without retrying it', async () => {
    const db = sqliteDb();
    await ensureImageSchema(db as never);
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await db
      .prepare(
        `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, provider, model, prompt, settings, status, created_at, updated_at)
         VALUES (?1, 'user_1', 'prj_1', 'scn_1', 'workers-ai', ?2, 'p', ?3, 'submitting', ?4, ?4)`,
      )
      .bind(
        cloudflareRequest.id,
        CF_MODEL,
        JSON.stringify(cloudflareRequest.settings),
        stale,
      )
      .run();

    await expect(
      submitImageJob(db as never, env, 'user_1', cloudflareRequest),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    const job = await readImageJob(db as never, 'user_1', cloudflareRequest.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('never acknowledged');
  });

  it('stops polling a generation that stays pending for ten minutes', async () => {
    const db = sqliteDb();
    await ensureImageSchema(db as never);
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    await db
      .prepare(
        `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, provider, model, prompt, settings, status, provider_job_id, created_at, updated_at)
         VALUES (?1, 'user_1', 'prj_1', 'scn_1', 'leonardo', ?2, 'p', ?3, 'queued', 'gen_old', ?4, ?4)`,
      )
      .bind(
        leonardoRequest.id,
        LEO_MODEL,
        JSON.stringify(leonardoRequest.settings),
        stale,
      )
      .run();
    const job = await refreshImageJob(db as never, env, 'user_1', leonardoRequest.id);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('ten minutes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('stored results', () => {
  it('never returns another account’s file', async () => {
    const db = sqliteDb();
    await submitImageJob(db as never, env, 'user_1', cloudflareRequest);
    await expect(
      fetchImageJobImage(db as never, 'user_2', cloudflareRequest.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('reports a missing stored file instead of an empty image', async () => {
    const db = sqliteDb();
    await ensureImageSchema(db as never);
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO scene_image_jobs (id, user_sub, project_id, scene_id, provider, model, prompt, settings, status, created_at, updated_at)
         VALUES (?1, 'user_1', 'prj_1', 'scn_1', 'workers-ai', ?2, 'p', ?3, 'completed', ?4, ?4)`,
      )
      .bind(cloudflareRequest.id, CF_MODEL, JSON.stringify(cloudflareRequest.settings), now)
      .run();
    await expect(
      fetchImageJobImage(db as never, 'user_1', cloudflareRequest.id),
    ).rejects.toMatchObject({ status: 410 });
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
      ...env,
      ...overrides,
    };
  }

  const body = {
    id: 'ij_route_12345678',
    sceneId: 'scn_1',
    projectId: 'prj_1',
    prompt: 'A quiet kitchen at dawn.',
    style: 'preset',
    modelId: 'cf-flux-schnell',
  };

  it('requires sign-in and a same-origin request', async () => {
    mocks.getUser.mockResolvedValue(null);
    expect((await worker.fetch(postJob(body), testEnv() as never)).status).toBe(401);

    mocks.getUser.mockResolvedValue({ sub: 'user_1' });
    const foreign = await worker.fetch(
      postJob(body, { origin: 'https://evil.test' }),
      testEnv() as never,
    );
    expect(foreign.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to start without the chosen provider’s credentials and names them', async () => {
    const response = await worker.fetch(
      postJob(body),
      testEnv(sqliteDb(), { CF_API_TOKEN: undefined }) as never,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('CF_API_TOKEN');

    const leonardoResponse = await worker.fetch(
      postJob({ ...body, modelId: 'leonardo-phoenix' }),
      testEnv(sqliteDb(), { LEONARDO_API_KEY: undefined }) as never,
    );
    expect(leonardoResponse.status).toBe(503);
    expect(await leonardoResponse.text()).toContain('LEONARDO_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 201 with a finished Workers AI image', async () => {
    const goodEnv = testEnv();
    const response = await worker.fetch(postJob(body), goodEnv as never);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { job: { id: string; status: string } };
    expect(created.job.status).toBe('completed');

    const file = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs/${body.id}/image`),
      goodEnv as never,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(JPEG));
  });

  it('returns 202 for a queued Leonardo generation and serves it once polled', async () => {
    const goodEnv = testEnv();
    const response = await worker.fetch(
      postJob({ ...body, id: 'ij_route_leo_1', modelId: 'leonardo-phoenix' }),
      goodEnv as never,
    );
    expect(response.status).toBe(202);
    const created = (await response.json()) as { job: { status: string } };
    expect(created.job.status).toBe('queued');

    const checked = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs/ij_route_leo_1`),
      goodEnv as never,
    );
    const checkedBody = (await checked.json()) as { job: { status: string; provider: string } };
    expect(checkedBody.job.status).toBe('completed');
    expect(checkedBody.job.provider).toBe('leonardo');
  });

  it('rejects a request over the body limit before the provider is called', async () => {
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs`, {
        method: 'POST',
        headers: { origin: APP_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, prompt: 'x'.repeat(5_000_000) }),
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never returns another account’s job', async () => {
    const goodEnv = testEnv();
    const created = await worker.fetch(postJob(body), goodEnv as never);
    await created.text();
    mocks.getUser.mockResolvedValue({ sub: 'user_2' });
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/images/jobs/${body.id}`),
      goodEnv as never,
    );
    expect(response.status).toBe(404);
  });

  it('counts one generation against the daily budget', async () => {
    const db = sqliteDb();
    await worker.fetch(postJob(body), testEnv(db) as never);
    const rows = db.database
      .prepare("SELECT window_key, requests FROM ai_usage WHERE window_key LIKE 'img:%'")
      .all() as Array<{ window_key: string; requests: number }>;
    const day = rows.find((row) => row.window_key.startsWith('img:d:'));
    expect(day?.requests).toBe(1);
  });
});
