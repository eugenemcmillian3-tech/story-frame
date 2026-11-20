// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestFingerprint } from '../src/ai/input';
import { DEFAULT_AI_MODEL } from '../src/ai/models';

const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock('@freebuff/auth', () => ({
  createFreebuffAuth: () => ({
    getUser: mocks.getUser,
    wrap: (handler: unknown) => handler,
  }),
  isSameOriginRequest: (request: Request, origin: string) =>
    request.headers.get('origin') === origin,
}));

import worker from '../worker/index';

const APP_ORIGIN = 'https://app.test';
// The quota windows are derived from the clock at request time. Pin it so a
// suite that straddles a minute or UTC-day boundary cannot seed yesterday's key.
const NOW = new Date('2026-01-01T00:00:30.000Z');
const DAY_KEY = `d:${NOW.toISOString().slice(0, 10)}`;
const MINUTE_KEY = `m:${NOW.toISOString().slice(0, 16)}`;

const anglesInput = {
  brief: {
    topic: 'How a bicycle stays upright',
    audience: 'Curious adults',
    goal: 'Explain the evidence',
    mode: 'factual' as const,
    targetDuration: 60 as const,
    tone: 'Calm',
    visualPreset: 'clean-educational' as const,
  },
  sourceNotes: [],
  storyNotes: { characters: '', setting: '', continuity: '' },
};

const payload = {
  operation: 'angles' as const,
  model: DEFAULT_AI_MODEL,
  input: anglesInput,
};

const anglesProposal = {
  angles: [
    {
      title: 'The lean that corrects itself',
      hook: 'A rolling bicycle does not simply fall over.',
      approach: 'Explain steering geometry.',
      explanation: 'A concrete visual sequence.',
    },
    {
      title: 'What riders actually do',
      hook: 'Balance is partly a rider skill.',
      approach: 'Follow a rider countersteering.',
      explanation: 'A human-scale opening.',
    },
    {
      title: 'The limits of the evidence',
      hook: 'The simple explanation is incomplete.',
      approach: 'Compare competing studies.',
      explanation: 'A skeptical ending.',
    },
  ],
};

interface FakeStatement {
  bind(...values: unknown[]): FakeStatement;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

function fakeDb(seed: Array<[string, string, number]> = []) {
  const rows = new Map<string, number>();
  for (const [sub, key, count] of seed) rows.set(`${sub}|${key}`, count);
  return {
    rows,
    prepare(query: string): FakeStatement {
      let args: unknown[] = [];
      const statement: FakeStatement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async all<T = unknown>() {
          // The quota claim is one conditional upsert; a full window returns no row.
          if (query.includes('RETURNING requests')) {
            const key = `${String(args[0])}|${String(args[1])}`;
            const limit = Number(args[2]);
            const current = rows.get(key) ?? 0;
            if (current >= limit) return { results: [] as T[] };
            rows.set(key, current + 1);
            return { results: [{ requests: current + 1 } as T] };
          }
          if (!query.includes('SELECT window_key')) return { results: [] as T[] };
          const sub = String(args[0]);
          const results: T[] = [];
          for (const key of args.slice(1)) {
            const value = rows.get(`${sub}|${String(key)}`);
            if (value !== undefined) {
              results.push({ window_key: String(key), requests: value } as T);
            }
          }
          return { results };
        },
        async run() {
          if (query.includes('UPDATE ai_usage')) {
            const key = `${String(args[0])}|${String(args[1])}`;
            const current = rows.get(key) ?? 0;
            if (current > 0) rows.set(key, current - 1);
          }
          return {};
        },
      };
      return statement;
    },
  };
}

type TestDb = ReturnType<typeof fakeDb>;

function testEnv(db: TestDb = fakeDb(), overrides: Record<string, unknown> = {}) {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: db,
    FREEBUFF_CLIENT_ID: 'test-client',
    FREEBUFF_ISSUER: 'https://freebuff.com/oidc',
    APP_ORIGIN,
    OLLAMA_API_KEY: 'test-key',
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${APP_ORIGIN}/api/ai/plan`, {
    method: 'POST',
    headers: {
      origin: APP_ORIGIN,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function chatReply(content: string): Response {
  return Response.json({ message: { role: 'assistant', content }, done: true });
}

const providerFetch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.getUser.mockReset();
  mocks.getUser.mockResolvedValue({ sub: 'user_1' });
  providerFetch.mockReset();
  vi.stubGlobal('fetch', providerFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('POST /api/ai/plan access control', () => {
  it('rejects signed-out callers before any provider request', async () => {
    mocks.getUser.mockResolvedValue(null);
    const response = await worker.fetch(post(payload), testEnv() as never);
    expect(response.status).toBe(401);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects a foreign origin before any provider request', async () => {
    const response = await worker.fetch(
      post(payload, { origin: 'https://evil.test' }),
      testEnv() as never,
    );
    expect(response.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods', async () => {
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/ai/plan`, { method: 'GET' }),
      testEnv() as never,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('refuses to run without the Ollama key', async () => {
    const response = await worker.fetch(
      post(payload),
      testEnv(fakeDb(), { OLLAMA_API_KEY: undefined }) as never,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('OLLAMA_API_KEY');
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/plan input validation', () => {
  it('rejects invalid JSON, unknown operations, and unlisted models', async () => {
    const invalidJson = await worker.fetch(post('{not json'), testEnv() as never);
    expect(invalidJson.status).toBe(400);

    const badOperation = await worker.fetch(
      post({ ...payload, operation: 'translate' }),
      testEnv() as never,
    );
    expect(badOperation.status).toBe(400);

    const badModel = await worker.fetch(
      post({ ...payload, model: 'gpt-5.9-unbounded' }),
      testEnv() as never,
    );
    expect(badModel.status).toBe(400);
    expect(await badModel.text()).toContain('model');

    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects a script whose fingerprint does not match the narration', async () => {
    const response = await worker.fetch(
      post({
        operation: 'storyboard',
        model: DEFAULT_AI_MODEL,
        input: {
          brief: anglesInput.brief,
          script: { narration: 'One saved sentence.', fingerprint: 'fnv1a:stale:1' },
        },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(400);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('rejects bodies over the size cap before parsing', async () => {
    const response = await worker.fetch(post('x'.repeat(180_001)), testEnv() as never);
    expect(response.status).toBe(413);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/plan quotas', () => {
  it('blocks the daily limit without calling the provider', async () => {
    const db = fakeDb([['user_1', DAY_KEY, 40]]);
    const response = await worker.fetch(post(payload), testEnv(db) as never);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('daily');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('blocks the per-minute limit without calling the provider', async () => {
    const db = fakeDb([['user_1', MINUTE_KEY, 6]]);
    const response = await worker.fetch(post(payload), testEnv(db) as never);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('one minute');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('counts a successful request against both windows', async () => {
    const db = fakeDb();
    providerFetch.mockResolvedValue(chatReply(JSON.stringify(anglesProposal)));
    const response = await worker.fetch(post(payload), testEnv(db) as never);
    expect(response.status).toBe(200);
    expect(db.rows.get(`user_1|${DAY_KEY}`)).toBe(1);
    expect(db.rows.get(`user_1|${MINUTE_KEY}`)).toBe(1);
  });

  it('refuses the request that would exceed the minute limit', async () => {
    const db = fakeDb([['user_1', MINUTE_KEY, 5]]);
    providerFetch.mockResolvedValue(chatReply(JSON.stringify(anglesProposal)));
    const first = await worker.fetch(post(payload), testEnv(db) as never);
    const second = await worker.fetch(post(payload), testEnv(db) as never);
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(db.rows.get(`user_1|${MINUTE_KEY}`)).toBe(6);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it('hands the minute slot back when the daily limit refuses the request', async () => {
    const db = fakeDb([['user_1', DAY_KEY, 40]]);
    const response = await worker.fetch(post(payload), testEnv(db) as never);
    expect(response.status).toBe(429);
    expect(db.rows.get(`user_1|${MINUTE_KEY}`) ?? 0).toBe(0);
    expect(db.rows.get(`user_1|${DAY_KEY}`)).toBe(40);
  });
});

describe('POST /api/ai/plan directed edit', () => {
  const editInput = {
    brief: anglesInput.brief,
    request: 'Replace the first scene visual only',
    script: { narration: 'Opening line.', locked: false },
    scenes: [
      {
        id: 'scn_1',
        title: 'Opening',
        narration: 'Opening line.',
        visualDirection: '',
        onScreenText: '',
        plannedDuration: 10,
        status: 'draft' as const,
        locks: { narration: false, visuals: false, text: false, timing: false },
      },
    ],
  };
  const editPayload = { operation: 'edit' as const, model: DEFAULT_AI_MODEL, input: editInput };

  it('returns the allowlisted commands the provider proposed', async () => {
    providerFetch.mockResolvedValue(
      chatReply(
        JSON.stringify({
          commands: [
            { kind: 'scene.visual', sceneId: 'scn_1', visualDirection: 'A slow push in' },
          ],
          explanation: 'One visual change.',
          alternatives: [],
        }),
      ),
    );
    const response = await worker.fetch(post(editPayload), testEnv() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      operation: string;
      proposal: { commands: unknown[]; explanation: string };
    };
    expect(body.operation).toBe('edit');
    expect(body.proposal.commands).toEqual([
      { kind: 'scene.visual', sceneId: 'scn_1', visualDirection: 'A slow push in' },
    ]);
    expect(body.proposal.explanation).toBe('One visual change.');
  });

  it('returns the provider-named blocked target alongside an empty command list', async () => {
    providerFetch.mockResolvedValue(
      chatReply(
        JSON.stringify({
          commands: [],
          explanation: 'The scene visual is locked.',
          alternatives: ['Unlock visuals on scene 1.'],
          blocked: [{ sceneId: 'scn_1', component: 'visuals' }],
          blockedScript: true,
        }),
      ),
    );
    const response = await worker.fetch(post(editPayload), testEnv() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      proposal: { commands: unknown[]; blocked: unknown[]; blockedScript: boolean };
    };
    expect(body.proposal.commands).toEqual([]);
    expect(body.proposal.blocked).toEqual([{ sceneId: 'scn_1', component: 'visuals' }]);
    expect(body.proposal.blockedScript).toBe(true);
  });

  it('refuses a blocked target whose component is not a scene component', async () => {
    providerFetch.mockResolvedValue(
      chatReply(
        JSON.stringify({
          commands: [],
          blocked: [{ sceneId: 'scn_1', component: 'script' }],
        }),
      ),
    );
    const response = await worker.fetch(post(editPayload), testEnv() as never);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('unreadable response');
  });

  it('refuses a response that adds a field outside the allowlist', async () => {
    providerFetch.mockResolvedValue(
      chatReply(
        JSON.stringify({
          commands: [
            {
              kind: 'scene.visual',
              sceneId: 'scn_1',
              visualDirection: 'A slow push in',
              plannedDuration: 99,
            },
          ],
        }),
      ),
    );
    const response = await worker.fetch(post(editPayload), testEnv() as never);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('unreadable response');
  });
});

describe('GET /api/ai/quota', () => {
  const get = () =>
    new Request(`${APP_ORIGIN}/api/ai/quota`, { headers: { Origin: APP_ORIGIN } });

  it('reports what is left without consuming any of it', async () => {
    const db = fakeDb([
      ['user_1', DAY_KEY, 4],
      ['user_1', MINUTE_KEY, 2],
    ]);
    const response = await worker.fetch(get(), testEnv(db) as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.daily).toEqual({ used: 4, limit: 40, remaining: 36 });
    expect(body.minute).toEqual({ used: 2, limit: 6, remaining: 4 });
    expect(db.rows.get(`user_1|${DAY_KEY}`)).toBe(4);
    expect(db.rows.get(`user_1|${MINUTE_KEY}`)).toBe(2);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('reports an untouched budget for a user with no usage', async () => {
    const response = await worker.fetch(get(), testEnv() as never);
    const body = (await response.json()) as Record<string, { remaining: number }>;
    expect(response.status).toBe(200);
    expect(body.daily.remaining).toBe(40);
    expect(body.minute.remaining).toBe(6);
  });

  it('requires sign-in and rejects other methods', async () => {
    mocks.getUser.mockResolvedValue(null);
    const signedOut = await worker.fetch(get(), testEnv() as never);
    expect(signedOut.status).toBe(401);

    mocks.getUser.mockResolvedValue({ sub: 'user_1' });
    const wrongMethod = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/ai/quota`, { method: 'POST' }),
      testEnv() as never,
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
  });

  it('rejects a foreign origin before reading usage', async () => {
    const db = fakeDb([['user_1', DAY_KEY, 4]]);
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/ai/quota`, {
        headers: { Origin: 'https://evil.example' },
      }),
      testEnv(db) as never,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'This request did not come from this site.',
    });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(db.rows.get(`user_1|${DAY_KEY}`)).toBe(4);
  });
});

describe('narration route access control', () => {
  it('rejects a foreign origin before sign-in on both narration routes', async () => {
    const requests = [
      new Request(`${APP_ORIGIN}/api/narration/jobs`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      }),
      new Request(`${APP_ORIGIN}/api/narration/usage`, {
        headers: { origin: 'https://evil.example' },
      }),
    ];
    for (const request of requests) {
      const response = await worker.fetch(request, testEnv() as never);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'This request did not come from this site.',
      });
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it('requires sign-in on a same-origin narration usage read', async () => {
    mocks.getUser.mockResolvedValue(null);
    const response = await worker.fetch(
      new Request(`${APP_ORIGIN}/api/narration/usage`, {
        headers: { Origin: APP_ORIGIN },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(401);
  });
});

describe('POST /api/ai/plan provider contract', () => {
  it('sends the allowlisted model to Ollama and returns the validated proposal', async () => {
    providerFetch.mockResolvedValue(chatReply(JSON.stringify(anglesProposal)));
    const env = testEnv();
    const response = await worker.fetch(post(payload), env as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.operation).toBe('angles');
    expect(body.inputFingerprint).toBe(requestFingerprint(payload));
    expect((body.proposal as { angles: unknown[] }).angles).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain('test-key');

    expect(providerFetch).toHaveBeenCalledTimes(1);
    const [url, init] = providerFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ollama.com/api/chat');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.model).toBe(DEFAULT_AI_MODEL);
    expect(sent.stream).toBe(false);
    expect(sent.think).toBe(false);
    expect(sent.options).toEqual({ temperature: 0.5, num_predict: 1600 });
    expect(Array.isArray(sent.messages)).toBe(true);
  });

  it('fails closed on unreadable provider payloads after the one retry', async () => {
    providerFetch.mockImplementation(async () => Response.json({ choices: [] }));
    const unreadable = await worker.fetch(post(payload), testEnv() as never);
    expect(unreadable.status).toBe(502);
    expect(await unreadable.text()).toContain('unreadable');
    expect(providerFetch).toHaveBeenCalledTimes(2);

    providerFetch.mockImplementation(async () => chatReply('This is not JSON.'));
    const noJson = await worker.fetch(post(payload), testEnv() as never);
    expect(noJson.status).toBe(502);
    expect(await noJson.text()).toContain('valid JSON');

    providerFetch.mockImplementation(async () => chatReply('   '));
    const empty = await worker.fetch(post(payload), testEnv() as never);
    expect(empty.status).toBe(502);
  });

  it('rejects provider JSON that does not satisfy the angle contract', async () => {
    providerFetch.mockImplementation(async () => chatReply(JSON.stringify({ angles: [] })));
    const response = await worker.fetch(post(payload), testEnv() as never);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('three angles');
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('retries once when a reply fails contract validation and returns the fresh reply', async () => {
    providerFetch
      .mockResolvedValueOnce(chatReply(JSON.stringify({ angles: [] })))
      .mockResolvedValueOnce(chatReply(JSON.stringify(anglesProposal)));
    const response = await worker.fetch(post(payload), testEnv() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { proposal: { angles: unknown[] } };
    expect(body.proposal.angles).toHaveLength(3);
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('names the broken rule in the repair retry', async () => {
    providerFetch
      .mockResolvedValueOnce(chatReply(JSON.stringify({ angles: [] })))
      .mockResolvedValueOnce(chatReply(JSON.stringify(anglesProposal)));
    await worker.fetch(post(payload), testEnv() as never);
    const first = JSON.parse(String((providerFetch.mock.calls[0] as [string, RequestInit])[1].body));
    const second = JSON.parse(String((providerFetch.mock.calls[1] as [string, RequestInit])[1].body));
    expect(first.messages).toHaveLength(2);
    expect(JSON.stringify(first.messages)).not.toContain('rejected');
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2].content).toContain('exactly three angles');
    expect(second.messages[2].content).toContain('Your previous reply was rejected');
    expect(first.options.temperature).toBe(0.5);
    expect(first.options.top_k).toBeUndefined();
    expect(second.options.temperature).toBe(0);
    expect(second.options.top_k).toBe(1);
    expect(first.format).toBeUndefined();
    expect(second.format).toBe('json');
  });

  it('re-samples without a repair note when the provider itself failed', async () => {
    providerFetch
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await worker.fetch(post(payload), testEnv() as never);
    const second = JSON.parse(String((providerFetch.mock.calls[1] as [string, RequestInit])[1].body));
    expect(second.messages).toHaveLength(2);
  });

  it('maps an upstream server failure to a safe 502 after one retry', async () => {
    providerFetch
      .mockResolvedValueOnce(new Response('upstream boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('upstream boom', { status: 500 }));
    const response = await worker.fetch(post(payload), testEnv() as never);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('request failed');
    expect(text).not.toContain('upstream boom');
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('maps an unreachable provider to a safe 502', async () => {
    providerFetch.mockRejectedValue(new TypeError('network down'));
    const response = await worker.fetch(post(payload), testEnv() as never);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('did not respond');
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('maps upstream rate limiting to 429', async () => {
    providerFetch
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    const response = await worker.fetch(post(payload), testEnv() as never);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('rate-limiting');
  });
});
