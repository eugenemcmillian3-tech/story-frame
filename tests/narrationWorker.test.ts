import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NarrationError,
  generateNarration,
  listNarrationUsage,
  parseNarrationRequest,
} from '../worker/narration';

const ENV = { CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'token', CF_AI_BASE: 'https://ai.test/client/v4' };

interface Row {
  id: string;
  user_sub: string;
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

/** Enough of D1 for this module's queries, matched on the statement text. */
class FakeDb {
  rows: Row[] = [];

  private find(id: unknown, user: unknown): Row | undefined {
    return this.rows.find((row) => row.id === id && row.user_sub === user);
  }

  prepare(query: string) {
    const flat = query.replace(/\s+/g, ' ').trim();
    const db = this;
    let params: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      async all<T = unknown>() {
        if (/^SELECT id FROM narration_jobs/.test(flat)) {
          const [id, user] = params;
          const row = db.find(id, user);
          return { results: (row ? [{ id: row.id }] : []) as T[] };
        }
        if (/^SELECT COUNT\(\*\) AS used FROM narration_jobs/.test(flat)) {
          const [user, since] = params as string[];
          return {
            results: [
              {
                used: db.rows.filter((row) => row.user_sub === user && row.created_at >= since)
                  .length,
              },
            ] as T[],
          };
        }
        if (/^SELECT id, project_id, purpose/.test(flat)) {
          const [user, since] = params as string[];
          return {
            results: db.rows
              .filter((row) => row.user_sub === user && row.created_at >= since)
              .sort((a, b) => b.created_at.localeCompare(a.created_at))
              .slice(0, 20) as unknown as T[],
          };
        }
        throw new Error(`unexpected all(): ${flat}`);
      },
      async run() {
        if (/^CREATE TABLE IF NOT EXISTS narration_jobs/.test(flat)) return {};
        if (/^INSERT INTO narration_jobs/.test(flat)) {
          const [
            id,
            user_sub,
            project_id,
            purpose,
            provider,
            model,
            voice,
            characters,
            estimated_usd,
            script_fingerprint,
            created_at,
          ] = params as [string, string, string | null, string, string, string, string, number, number, string | null, string];
          db.rows.push({
            id,
            user_sub,
            project_id,
            purpose,
            provider,
            model,
            voice,
            characters,
            estimated_usd,
            script_fingerprint,
            status: 'generating',
            attempts: 0,
            provider_status: null,
            error: null,
            created_at,
            updated_at: created_at,
          });
          return {};
        }
        if (/^UPDATE narration_jobs SET status = 'completed'/.test(flat)) {
          const [id, user, attempts, providerStatus, updatedAt] = params as [string, string, number, number, string];
          const row = db.find(id, user);
          if (row) Object.assign(row, { status: 'completed', attempts, provider_status: providerStatus, error: null, updated_at: updatedAt });
          return {};
        }
        if (/^UPDATE narration_jobs SET status = 'failed'/.test(flat)) {
          const [id, user, error, updatedAt] = params as [string, string, string, string];
          const row = db.find(id, user);
          if (row) Object.assign(row, { status: 'failed', error, updated_at: updatedAt });
          return {};
        }
        throw new Error(`unexpected run(): ${flat}`);
      },
    };
    return statement;
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return parseNarrationRequest({
    id: 'nar_1',
    text: 'Yawning is contagious, and the evidence for why is thin.',
    voice: 'luna',
    purpose: 'narration',
    projectId: 'prj_1',
    scriptFingerprint: 'fnv1a:abc:52',
    ...overrides,
  });
}

function mp3(): Response {
  return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('narration request validation', () => {
  it('accepts a documented voice and rejects an invented one', () => {
    expect(request().voice).toBe('luna');
    expect(() => request({ voice: 'robot' })).toThrow(NarrationError);
  });

  it('rejects empty text and text over the app cap', () => {
    expect(() => request({ text: '   ' })).toThrow(/no script text/i);
    expect(() => request({ text: 'a'.repeat(5001) })).toThrow(/at most 5000 characters/i);
  });
});

describe('narration generation', () => {
  it('returns the provider audio and records the job with its real character count', async () => {
    const db = new FakeDb();
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return mp3();
    });
    const input = request();
    const result = await generateNarration(db, ENV, 'user_1', input);

    expect(result.bytes.byteLength).toBe(6);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.job.status).toBe('completed');
    expect(result.job.characters).toBe(input.text.length);
    expect(result.job.estimatedUsd).toBeCloseTo((input.text.length / 1000) * 0.015, 6);
    expect(result.job.attempts).toBe(1);
    expect(calls[0]).toBe('https://ai.test/client/v4/accounts/acct/ai/run/@cf/deepgram/aura-1');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe('completed');
    expect(db.rows[0].script_fingerprint).toBe('fnv1a:abc:52');
  });

  it('retries once on a 5xx and reports the attempt count', async () => {
    const db = new FakeDb();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1 ? new Response('boom', { status: 503 }) : mp3();
    });
    const result = await generateNarration(db, ENV, 'user_1', request());
    expect(calls).toBe(2);
    expect(result.job.attempts).toBe(2);
    expect(result.job.status).toBe('completed');
  });

  it('never retries a 4xx and keeps the failed job on record', async () => {
    const db = new FakeDb();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    });
    await expect(generateNarration(db, ENV, 'user_1', request())).rejects.toThrow(
      /refused the request \(HTTP 400\)/i,
    );
    expect(calls).toBe(1);
    expect(db.rows[0].status).toBe('failed');
    expect(db.rows[0].error).toMatch(/HTTP 400/);
  });

  it('retries a transport failure and says the request may be billed', async () => {
    const db = new FakeDb();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      throw new TypeError('network down');
    });
    await expect(generateNarration(db, ENV, 'user_1', request())).rejects.toThrow(
      /could not be reached.*may still be billed/i,
    );
    expect(calls).toBe(2);
    expect(db.rows[0].status).toBe('failed');
  });

  it('does not retry refused credentials and points at the secrets', async () => {
    const db = new FakeDb();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('no', { status: 401 });
    });
    await expect(generateNarration(db, ENV, 'user_1', request())).rejects.toThrow(
      /CF_ACCOUNT_ID and CF_API_TOKEN/,
    );
    expect(calls).toBe(1);
  });

  it('refuses a repeated request id instead of billing twice', async () => {
    const db = new FakeDb();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return mp3();
    });
    await generateNarration(db, ENV, 'user_1', request());
    await expect(generateNarration(db, ENV, 'user_1', request())).rejects.toThrow(
      /already submitted/i,
    );
    expect(calls).toBe(1);
  });

  it('stops at the daily limit without calling the provider', async () => {
    const db = new FakeDb();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return mp3();
    });
    const now = new Date().toISOString();
    for (let index = 0; index < 20; index += 1) {
      db.rows.push({
        ...({
          id: `old_${index}`,
          user_sub: 'user_1',
          project_id: null,
          purpose: 'sample',
          provider: 'Deepgram Aura',
          model: '@cf/deepgram/aura-1',
          voice: 'luna',
          characters: 10,
          estimated_usd: 0.00015,
          script_fingerprint: null,
          status: 'completed',
          attempts: 1,
          provider_status: 200,
          error: null,
          created_at: now,
          updated_at: now,
        } satisfies Row),
      });
    }
    await expect(generateNarration(db, ENV, 'user_1', request())).rejects.toThrow(/all 20 narration/i);
    expect(calls).toBe(0);
  });
});

describe('narration usage', () => {
  it('reports jobs, spend and the minute window', async () => {
    const db = new FakeDb();
    vi.stubGlobal('fetch', async () => mp3());
    await generateNarration(db, ENV, 'user_1', request({ purpose: 'sample' }));
    const usage = await listNarrationUsage(db, 'user_1');
    expect(usage.usedToday).toBe(1);
    expect(usage.usedThisMinute).toBe(1);
    expect(usage.estimatedUsdToday).toBeGreaterThan(0);
    expect(usage.jobs[0].purpose).toBe('sample');
    expect(usage.dailyLimit).toBe(20);
  });
});
