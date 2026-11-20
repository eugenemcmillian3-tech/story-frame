/**
 * Live check of the image routes: one real, billable Workers AI generation
 * driven through the built Worker, over real HTTP routes, with a real-SQLite D1
 * shim and a stub OIDC issuer on loopback.
 *
 * It proves the route, the quota, the D1 schema, the provider call, the stored
 * bytes, the duplicate-submission guard and cross-user isolation. It attaches
 * nothing to a project and renders nothing; those steps are the client's, so
 * they need a signed-in browser.
 *
 * Requires the Worker's own credentials:
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run check:image:route -- --yes
 *
 * It refuses to generate without an explicit confirmation (--yes, or typing
 * "yes"), because it spends a real generation on the account.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { IMAGE_MODEL, IMAGE_MODEL_LABEL, IMAGE_USD_ESTIMATE } from '../src/images/provider';
import worker from '../worker/dist/index';
import { confirmSpend } from './confirm-spend';

const ISSUER = 'http://127.0.0.1:8798/oidc';
const CLIENT_ID = 'local-image-client';
const APP_ORIGIN = 'http://localhost:8787';
const KEY_ID = 'local-image-key';
const SERVER_PORT = 8798;

const accountId = process.env.CF_ACCOUNT_ID;
const apiToken = process.env.CF_API_TOKEN;
if (!accountId || !apiToken) {
  console.error('CF_ACCOUNT_ID and CF_API_TOKEN must be set in this environment. Rerun once they are.');
  process.exit(2);
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };

interface PendingCode {
  challenge: string;
  nonce: string;
  redirectUri: string;
  subject: string;
}
const codes = new Map<string, PendingCode>();

async function sign(sub: string, payload: Record<string, unknown>, type?: string): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, ...(type ? { typ: type } : {}) })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function issueTokens(sub: string, nonce: string) {
  const claims = { email: `${sub}@example.test`, email_verified: true, name: sub };
  const accessToken = await sign(sub, { client_id: CLIENT_ID, ...claims }, 'at+jwt');
  const idToken = await sign(sub, { nonce, ...claims });
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
    // The stub reads the account from login_hint so one run can sign in twice.
    const subject = url.searchParams.get('login_hint') ?? 'local_image_user';
    const code = base64url(randomBytes(24));
    codes.set(code, { challenge, nonce, redirectUri, subject });
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
        send(200, await issueTokens(pending.subject, pending.nonce));
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

/** A D1-shaped shim over real SQLite, so the production SQL is what runs. */
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

const db = sqliteDb();
const env = {
  ASSETS: { fetch: async () => new Response('asset') },
  DB: db,
  FREEBUFF_CLIENT_ID: CLIENT_ID,
  FREEBUFF_ISSUER: ISSUER,
  APP_ORIGIN,
  CF_ACCOUNT_ID: accountId,
  CF_API_TOKEN: apiToken,
};

function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    store(headers: Headers) {
      for (const raw of headers.getSetCookie()) {
        const [pair, ...attributes] = raw.split(';');
        const index = pair.indexOf('=');
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        const expired = attributes.some((attribute) => /max-age=0$/i.test(attribute.trim()));
        if (expired || value === '') jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

const results: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call(
  jar: ReturnType<typeof cookieJar>,
  path: string,
  options: { method?: string; body?: unknown; origin?: string } = {},
) {
  const headers = new Headers({ origin: options.origin ?? APP_ORIGIN });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const cookie = jar.header();
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
  jar.store(response.headers);
  return response;
}

/** Runs the stub issuer's sign-in sequence and leaves a session cookie in the jar. */
async function signIn(jar: ReturnType<typeof cookieJar>, sub: string): Promise<void> {
  const signin = await call(jar, '/auth/freebuff/signin?returnTo=/');
  const authorizeUrl = signin.headers.get('location') ?? '';
  await signin.text();
  // The stub reads the account from login_hint, so it is passed here.
  const withSubject = new URL(authorizeUrl);
  withSubject.searchParams.set('login_hint', sub);
  const authorize = await fetch(withSubject.href, { redirect: 'manual' });
  const callbackUrl = authorize.headers.get('location') ?? '';
  const callback = await call(
    jar,
    new URL(callbackUrl).pathname + new URL(callbackUrl).search,
  );
  await callback.text();
}

/** Reads the pixel size out of a JPEG's start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

const alice = cookieJar();
const bob = cookieJar();

const signedOutCreate = await call(alice, '/api/images/jobs', {
  method: 'POST',
  body: { id: 'ij_live_route_anon', sceneId: 'scn_1', projectId: 'prj_1', prompt: 'x' },
});
check('signed-out image request is rejected', signedOutCreate.status === 401, `status ${signedOutCreate.status}`);
await signedOutCreate.text();

const foreign = await call(alice, '/api/images/jobs', {
  method: 'POST',
  body: { id: 'ij_live_route_foreign', sceneId: 'scn_1', projectId: 'prj_1', prompt: 'x' },
  origin: 'https://evil.test',
});
check('foreign origin is rejected', foreign.status === 403, `status ${foreign.status}`);
await foreign.text();

await signIn(alice, 'local_alice');
const sessionA = (await (await call(alice, '/auth/freebuff/session')).json()) as {
  user?: { sub?: string };
};
check('sign-in produces a session', Boolean(sessionA.user?.sub), `sub ${sessionA.user?.sub ?? 'none'}`);

const jobId = `ij_live_${Date.now().toString(36)}`;
const body = {
  id: jobId,
  sceneId: 'scn_live_1',
  projectId: 'prj_live_1',
  prompt:
    'A stone lighthouse on a storm-worn cliff at first light, wet grass, low sea fog, ' +
    'cinematic film still, soft directional light, no words, no text, no logos.',
  style: 'cinema-still',
};

await confirmSpend(
  `This will generate 1 image through the image route with ${IMAGE_MODEL_LABEL} (${IMAGE_MODEL}). Workers AI list price: about $${IMAGE_USD_ESTIMATE.toFixed(4)}, before the account plan, its free daily allowance and taxes.`,
);

const create = await call(alice, '/api/images/jobs', { method: 'POST', body });
const created = (await create.json()) as {
  job?: { id?: string; status?: string; model?: string; width?: number; height?: number };
  error?: string;
};
const generation = created.job;
check(
  'a real generation is created with 201',
  create.status === 201 && generation?.id === jobId,
  `${create.status} ${generation?.status ?? created.error ?? '?'}`,
);
check(
  'the job records the Workers AI model and a completed image',
  generation?.status === 'completed' && generation?.model === IMAGE_MODEL,
  `${generation?.status ?? '?'} · ${generation?.model ?? '?'}`,
);
check(
  'the recorded frame is the model’s documented size',
  generation?.width === 1024 && generation?.height === 1024,
  `${generation?.width ?? '?'}×${generation?.height ?? '?'}`,
);

const duplicate = await call(alice, '/api/images/jobs', { method: 'POST', body });
const duplicateBody = (await duplicate.json()) as { job?: { id?: string; status?: string } };
check(
  'a duplicate submission returns the recorded job instead of billing twice',
  duplicate.status === 200 && duplicateBody.job?.id === jobId,
  `${duplicate.status} ${duplicateBody.job?.id ?? '?'}`,
);

const image = await call(alice, `/api/images/jobs/${jobId}/image`);
const bytes = new Uint8Array(await image.arrayBuffer());
const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
const size = isJpeg ? jpegSize(bytes) : null;
check(
  'the stored bytes download as a 1024×1024 JPEG',
  image.status === 200 &&
    image.headers.get('content-type') === 'image/jpeg' &&
    size?.width === 1024 &&
    size?.height === 1024,
  `${image.status} ${image.headers.get('content-type')} ${(bytes.byteLength / 1024).toFixed(0)} KB ${
    size ? `${size.width}×${size.height}` : ''
  }`,
);
if (isJpeg) {
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/live-route-scene.jpg', bytes);
}

const reread = await call(alice, `/api/images/jobs/${jobId}`);
const rereadBody = (await reread.json()) as { job?: { status?: string } };
check(
  'a finished job is served from storage',
  rereadBody.job?.status === 'completed',
  rereadBody.job?.status ?? 'unknown',
);

const quotaRows = db.database
  .prepare("SELECT window_key, requests FROM ai_usage WHERE user_sub = ? AND window_key LIKE 'img:%'")
  .all('local_alice') as Array<{ window_key: string; requests: number }>;
const dayRow = quotaRows.find((row) => row.window_key.startsWith('img:d:'));
check(
  'one billable image was counted against the daily budget',
  dayRow?.requests === 1,
  quotaRows.map((row) => `${row.window_key}=${row.requests}`).join(', ') || 'no rows',
);

await signIn(bob, 'local_bob');
const foreignJob = await call(bob, `/api/images/jobs/${jobId}`);
check("another user cannot read the job", foreignJob.status === 404, `status ${foreignJob.status}`);
await foreignJob.text();
const foreignImage = await call(bob, `/api/images/jobs/${jobId}/image`);
check("another user cannot download the image", foreignImage.status === 404, `status ${foreignImage.status}`);
await foreignImage.text();

console.log(results.join('\n'));
const failures = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`\n${results.length - failures}/${results.length} live image route checks passed.`);
server.close();
process.exit(failures === 0 ? 0 : 1);
