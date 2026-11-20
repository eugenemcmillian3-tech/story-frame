/**
 * Local-only check of the Worker's AI route without a real Freebuff sign-in.
 *
 * The browser flow needs a Google 2SV prompt that a headless run cannot answer,
 * so this drives the built Worker with the same @freebuff/auth SDK against a
 * stub OIDC issuer on loopback: real sign-in -> callback -> session cookie ->
 * POST /api/ai/plan for all three operations, each reaching a real Ollama call.
 * It exercises our route, quota and provider code; it is not a substitute for
 * signing in to the deployed site.
 *
 * Run: npm run check:route
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { computeScriptFingerprint } from '../src/domain/fingerprint';
import worker from '../worker/dist/index';

const ISSUER = 'http://127.0.0.1:8799/oidc';
const CLIENT_ID = 'local-test-client';
const APP_ORIGIN = 'http://localhost:8787';
const USER_SUB = 'local_test_user';
const KEY_ID = 'local-test-key';
const SERVER_PORT = 8799;

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };

interface PendingCode {
  challenge: string;
  nonce: string;
  redirectUri: string;
}
const codes = new Map<string, PendingCode>();

async function sign(
  sub: string,
  payload: Record<string, unknown>,
  type?: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, ...(type ? { typ: type } : {}) })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function issueTokens(nonce: string) {
  const claims = { email: 'local@example.test', email_verified: true, name: 'Local Check' };
  const accessToken = await sign(
    USER_SUB,
    { client_id: CLIENT_ID, ...claims },
    'at+jwt',
  );
  const idToken = await sign(USER_SUB, { nonce, ...claims });
  return {
    access_token: accessToken,
    id_token: idToken,
    refresh_token: `fbrt_${base64url(randomBytes(32))}`,
    token_type: 'Bearer',
    expires_in: 3600,
  };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${SERVER_PORT}`);
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/oidc/.well-known/openid-configuration') {
    send(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      revocation_endpoint: `${ISSUER}/revoke`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }
  if (url.pathname === '/oidc/jwks') {
    send(200, { keys: [jwk] });
    return;
  }
  if (url.pathname === '/oidc/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('code_challenge') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const code = base64url(randomBytes(24));
    codes.set(code, { challenge, nonce, redirectUri });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    target.searchParams.set('iss', ISSUER);
    response.writeHead(302, { location: target.href });
    response.end();
    return;
  }
  if (url.pathname === '/oidc/token' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      void (async () => {
        const form = new URLSearchParams(body);
        const pending = codes.get(form.get('code') ?? '');
        if (!pending) {
          send(400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const computed = base64url(createHash('sha256').update(verifier).digest());
        if (computed !== pending.challenge || form.get('redirect_uri') !== pending.redirectUri) {
          send(400, { error: 'invalid_grant' });
          return;
        }
        send(200, await issueTokens(pending.nonce));
      })();
    });
    return;
  }
  if (url.pathname === '/oidc/revoke') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
    return;
  }
  send(404, { error: 'not_found' });
});

await new Promise<void>((resolve) => server.listen(SERVER_PORT, '127.0.0.1', resolve));

// In-memory stand-in for D1 covering the statements the quota code issues.
function fakeDb() {
  const rows = new Map<string, number>();
  return {
    rows,
    prepare(query: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async all<T = unknown>() {
          if (query.includes('RETURNING requests')) {
            const key = `${String(args[0])}|${String(args[1])}`;
            const limit = Number(args[2]);
            const current = rows.get(key) ?? 0;
            if (current >= limit) return { results: [] as T[] };
            rows.set(key, current + 1);
            return { results: [{ requests: current + 1 } as T] };
          }
          if (!query.includes('SELECT window_key')) return { results: [] as T[] };
          const results: T[] = [];
          for (const key of args.slice(1)) {
            const value = rows.get(`${String(args[0])}|${String(key)}`);
            if (value !== undefined) results.push({ window_key: String(key), requests: value } as T);
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
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

const db = fakeDb();
const env = {
  ASSETS: { fetch: async () => new Response('asset') },
  DB: db,
  FREEBUFF_CLIENT_ID: CLIENT_ID,
  FREEBUFF_ISSUER: ISSUER,
  APP_ORIGIN,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
};

const jar = new Map<string, string>();
const cookieHeader = () =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

function storeCookies(headers: Headers): void {
  for (const raw of headers.getSetCookie()) {
    const [pair, ...attributes] = raw.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some((attribute) => /max-age=0$/i.test(attribute.trim()));
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; origin?: string } = {},
) {
  const headers = new Headers({ origin: options.origin ?? APP_ORIGIN });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const cookie = cookieHeader();
  if (cookie) headers.set('cookie', cookie);
  const response = await worker.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    }),
    env as never,
  );
  storeCookies(response.headers);
  return response;
}

const results: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const MODEL = 'deepseek-v4.1-flash';

const anglesPayload = {
  operation: 'angles',
  model: MODEL,
  input: {
    brief: {
      topic: 'How a bicycle stays upright',
      audience: 'Curious general viewers',
      goal: 'Explain the counterintuitive physics of balance in under a minute',
      mode: 'factual',
      targetDuration: 60,
      tone: 'clear and curious',
      visualPreset: 'clean-educational',
    },
    sourceNotes: [
      {
        id: 'src_1',
        title: 'Bicycle stability primer',
        excerpt:
          'A bicycle stays upright because steering geometry lets the front wheel turn into a fall: when the bike leans, the front wheel steers toward the lean, moving the wheels back under the centre of mass. At very low speeds this self-correction is weaker.',
        notes: '',
      },
    ],
    storyNotes: { characters: '', setting: '', continuity: '' },
  },
};

const scriptPayload = {
  operation: 'script',
  model: MODEL,
  input: {
    ...anglesPayload.input,
    angle: {
      title: 'The lean that corrects itself',
      hook: 'A moving bicycle holds itself up — the trick happens at the front wheel.',
      approach: 'Follow a lean from the front wheel back to the rider.',
      explanation: 'Steering geometry turns a fall into a correction.',
    },
  },
};

const narration =
  'A moving bicycle holds itself up, and the trick happens at the front wheel. When the bike leans, the front wheel steers toward the lean, moving the wheels back under the centre of mass. At very low speeds this self-correction is weaker, so the rider has to steer deliberately to keep balance.';

const storyboardPayload = {
  operation: 'storyboard',
  model: MODEL,
  input: {
    brief: anglesPayload.input.brief,
    script: { narration, fingerprint: computeScriptFingerprint(narration) },
  },
};

const signedOut = await call('/api/ai/plan', { method: 'POST', body: anglesPayload });
check('signed-out request is rejected', signedOut.status === 401, `status ${signedOut.status}`);
await signedOut.text();

const foreign = await call('/api/ai/plan', {
  method: 'POST',
  body: anglesPayload,
  origin: 'https://evil.test',
});
check('foreign origin is rejected', foreign.status === 403, `status ${foreign.status}`);
await foreign.text();

const signin = await call('/auth/freebuff/signin?returnTo=/');
const authorizeUrl = signin.headers.get('location') ?? '';
check('sign-in redirects to the issuer', signin.status === 303 && authorizeUrl.includes('/oidc/authorize'), `status ${signin.status}`);
await signin.text();

const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
const callbackUrl = authorize.headers.get('location') ?? '';
check(
  'issuer redirects back with a code and iss',
  authorize.status === 302 && callbackUrl.includes('code=') && callbackUrl.includes('iss='),
  `status ${authorize.status}`,
);

const callback = await call(new URL(callbackUrl).pathname + new URL(callbackUrl).search);
check('callback completes and sets a session', callback.status === 303, `status ${callback.status}`);
await callback.text();

const session = await call('/auth/freebuff/session');
const sessionBody = (await session.json()) as { user?: { sub?: string } };
check('session reports the signed-in user', sessionBody.user?.sub === USER_SUB, `sub ${sessionBody.user?.sub ?? 'none'}`);

const emptyQuota = await call('/api/ai/quota');
const emptyBody = (await emptyQuota.json()) as { daily?: { used?: number; remaining?: number } };
check(
  'quota endpoint reports an untouched budget',
  emptyQuota.status === 200 && emptyBody.daily?.used === 0 && emptyBody.daily?.remaining === 40,
  `status ${emptyQuota.status} used ${emptyBody.daily?.used ?? '?'}`,
);

const started = Date.now();
const plan = await call('/api/ai/plan', { method: 'POST', body: anglesPayload });
const planBody = (await plan.json()) as {
  model?: string;
  proposal?: { angles?: Array<{ title?: string }> };
  error?: string;
};
const titles = (planBody.proposal?.angles ?? []).map((angle) => angle.title ?? '');
check(
  'angles request returns a real Ollama proposal',
  plan.status === 200 && titles.length === 3,
  `${plan.status} ${Date.now() - started}ms model=${planBody.model ?? planBody.error ?? '?'} ${titles.join(' | ')}`,
);

const scriptReply = await call('/api/ai/plan', { method: 'POST', body: scriptPayload });
const scriptBody = (await scriptReply.json()) as {
  proposal?: { mode?: string; segments?: Array<{ claims?: unknown[] }> };
  error?: string;
};
const segments = scriptBody.proposal?.segments ?? [];
const claims = segments.reduce((total, segment) => total + (segment.claims?.length ?? 0), 0);
check(
  'script request returns a real Ollama proposal',
  scriptReply.status === 200 && scriptBody.proposal?.mode === 'script' && segments.length > 0,
  `${scriptReply.status} ${segments.length} segments, ${claims} claims${scriptBody.error ? ` — ${scriptBody.error}` : ''}`,
);

const storyboardReply = await call('/api/ai/plan', { method: 'POST', body: storyboardPayload });
const storyboardBody = (await storyboardReply.json()) as {
  proposal?: { scenes?: Array<{ plannedDuration?: number }> };
  error?: string;
};
const scenes = storyboardBody.proposal?.scenes ?? [];
const sceneSeconds = scenes.reduce((total, scene) => total + (scene.plannedDuration ?? 0), 0);
check(
  'storyboard request returns a real Ollama proposal',
  storyboardReply.status === 200 && scenes.length > 0,
  `${storyboardReply.status} ${scenes.length} scenes, ${sceneSeconds}s${storyboardBody.error ? ` — ${storyboardBody.error}` : ''}`,
);

const day = new Date().toISOString().slice(0, 10);
const minute = new Date().toISOString().slice(0, 16);
const dayCount = db.rows.get(`${USER_SUB}|d:${day}`) ?? 0;
const minuteCount = db.rows.get(`${USER_SUB}|m:${minute}`) ?? 0;
check(
  'quota counted all three requests in D1',
  dayCount === 3 && minuteCount > 0 && minuteCount <= 3,
  `day ${dayCount}, minute ${minuteCount}`,
);

const spent = await call('/api/ai/quota');
const spentBody = (await spent.json()) as {
  daily?: { used?: number; remaining?: number };
  minute?: { remaining?: number };
};
check(
  'quota endpoint reports the three requests',
  spent.status === 200 && spentBody.daily?.used === 3 && spentBody.daily?.remaining === 37,
  `used ${spentBody.daily?.used ?? '?'}, left ${spentBody.daily?.remaining ?? '?'} today, ${spentBody.minute?.remaining ?? '?'} this minute`,
);

db.rows.set(`${USER_SUB}|d:${day}`, 40);
const limited = await call('/api/ai/plan', { method: 'POST', body: anglesPayload });
const limitedBody = (await limited.json()) as { error?: string };
check('daily limit is enforced', limited.status === 429, `${limited.status} ${limitedBody.error ?? ''}`);

const signout = await call('/auth/freebuff/signout', { method: 'POST' });
check('sign-out completes', signout.status === 303, `status ${signout.status}`);
await signout.text();

const afterSignout = await call('/api/ai/plan', { method: 'POST', body: anglesPayload });
check('request after sign-out is rejected', afterSignout.status === 401, `status ${afterSignout.status}`);
await afterSignout.text();

console.log(results.join('\n'));
const failures = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failures}/${results.length} route checks passed.`);
server.close();
process.exit(failures === 0 ? 0 : 1);
