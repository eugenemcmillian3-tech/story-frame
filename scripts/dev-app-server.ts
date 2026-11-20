/**
 * A local app server for driving the real UI in a browser: the built Worker,
 * the built static assets, a real-SQLite D1 shim, and a local OpenID Connect
 * issuer at `{APP_ORIGIN}/oidc` so the app's own sign-in flow can complete.
 *
 * This exists because Freebuff sign-in sends the browser to freebuff.com (and
 * on to Google, GitHub or Apple), which an automated browser cannot finish. The
 * issuer here is a stub that lives only inside this process: it signs real
 * tokens with a key generated at startup, and the app validates them through
 * its normal `createFreebuffAuth` path. Nothing here is used by a deployment.
 *
 * The provider credentials are read from the environment and never written to a
 * file:
 *   APP_ORIGIN=https://<this chat's preview host> PORT=8787 \
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... LEONARDO_API_KEY=... npm run dev:app
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../worker/dist/index';

const PORT = Number(process.env.PORT ?? 8787);
const APP_ORIGIN = (process.env.APP_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
const CLIENT_ID = 'storyframe-dev';
const KEY_ID = 'storyframe-dev-key';
const DIST = resolve('dist');
const USER = {
  sub: process.env.DEV_USER_SUB ?? 'dev_user',
  email: process.env.DEV_USER_EMAIL ?? 'dev@example.test',
  name: 'Dev User',
};

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };

interface PendingCode {
  challenge: string;
  nonce: string;
  redirectUri: string;
}
const codes = new Map<string, PendingCode>();

async function sign(
  issuer: string,
  payload: Record<string, unknown>,
  type?: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, ...(type ? { typ: type } : {}) })
    .setIssuer(issuer)
    .setAudience(CLIENT_ID)
    .setSubject(USER.sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The stub issuer: discovery, JWKS, authorize, token and revoke. The issuer is
 * always APP_ORIGIN, because the preview proxy forwards requests with a loopback
 * Host header while the browser is on the public origin.
 */
async function handleOidc(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const issuer = `${url.origin}/oidc`;
  const path = url.pathname;
  if (path === '/oidc/.well-known/openid-configuration') {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    });
  }
  if (path === '/oidc/jwks') return json({ keys: [jwk] });
  if (path === '/oidc/revoke') return json({});
  if (path === '/oidc/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const code = base64url(randomBytes(24));
    codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      redirectUri,
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    target.searchParams.set('iss', issuer);
    return new Response(null, { status: 302, headers: { location: target.href } });
  }
  if (path === '/oidc/token' && request.method === 'POST') {
    const form = new URLSearchParams(await request.text());
    const pending = codes.get(form.get('code') ?? '');
    if (!pending) return json({ error: 'invalid_grant' }, 400);
    codes.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    const computed = base64url(createHash('sha256').update(verifier).digest());
    if (computed !== pending.challenge || form.get('redirect_uri') !== pending.redirectUri) {
      return json({ error: 'invalid_grant' }, 400);
    }
    const claims = { email: USER.email, email_verified: true, name: USER.name };
    return json({
      access_token: await sign(issuer, { client_id: CLIENT_ID, ...claims }, 'at+jwt'),
      id_token: await sign(issuer, { nonce: pending.nonce, ...claims }),
      refresh_token: `fbrt_${base64url(randomBytes(32))}`,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
  return json({ error: 'not_found' }, 404);
}

/** A D1-shaped shim over real SQLite, so the production SQL is what runs. */
function sqliteDb() {
  const database = new DatabaseSync(':memory:');
  return {
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

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serveAsset(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);
  const candidate = normalize(join(DIST, pathname === '/' ? 'index.html' : pathname));
  if (!candidate.startsWith(DIST)) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(candidate);
    return new Response(body, {
      headers: { 'content-type': CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream' },
    });
  } catch {
    // The app is a single-page app: unknown routes fall back to index.html, but a
    // missing file must stay a 404 rather than quietly becoming HTML.
    if (extname(candidate) !== '') return new Response('Not found', { status: 404 });
    const index = await readFile(join(DIST, 'index.html'));
    return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

const db = sqliteDb();

function envFor(origin: string) {
  return {
    ASSETS: { fetch: serveAsset },
    DB: db,
    FREEBUFF_CLIENT_ID: CLIENT_ID,
    FREEBUFF_ISSUER: `${origin}/oidc`,
    APP_ORIGIN: origin,
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_API_TOKEN: process.env.CF_API_TOKEN,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    LEONARDO_API_KEY: process.env.LEONARDO_API_KEY,
  };
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/oidc/')) return handleOidc(request);
  return worker.fetch(request, envFor(APP_ORIGIN) as never);
}

/**
 * The Worker fetches its issuer over the network. Point those calls back at this
 * process, so discovery, JWKS and the token exchange never leave the sandbox.
 */
const networkFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (new URL(url).pathname.startsWith('/oidc/')) {
    return handleOidc(new Request(url, init));
  }
  return networkFetch(input as RequestInfo, init);
};

function toRequest(incoming: IncomingMessage, body: Buffer | null): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  const method = incoming.method ?? 'GET';
  return new Request(`${APP_ORIGIN}${incoming.url ?? '/'}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

const server = createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  try {
    const response = await handle(toRequest(incoming, chunks.length ? Buffer.concat(chunks) : null));
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') headers[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers['set-cookie'] = cookies;
    outgoing.writeHead(response.status, headers);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('dev server request failed', error instanceof Error ? error.message : error);
    outgoing.writeHead(500, { 'content-type': 'text/plain' });
    outgoing.end('dev server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
  console.log(`  app origin   ${APP_ORIGIN}`);
  console.log(`  dev issuer   ${APP_ORIGIN}/oidc (signs in as ${USER.sub})`);
  console.log(
    `  credentials  cloudflare ${process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN ? 'set' : 'missing'} · deepgram ${process.env.DEEPGRAM_API_KEY ? 'set' : 'missing'} · leonardo ${process.env.LEONARDO_API_KEY ? 'set' : 'missing'}`,
  );
});
