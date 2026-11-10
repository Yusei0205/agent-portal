/**
 * "Claude plan (Pro / Max)" sign-in from the Add credential dialog.
 *
 * Does what `claude setup-token` does, without needing the CLI on the host: a PKCE sign-in at claude.ai with the
 * inference-only scope and a one-year lifetime. The person opens the returned URL, signs in, and pastes back the
 * code the page shows; the portal exchanges it and returns the long-lived token to fill into the credential form.
 *
 * Nothing is stored between the two calls. The PKCE verifier travels in `flow`, an encrypted blob bound to the
 * signed-in user that expires after 10 minutes, so this works across Lambda invocations.
 */

import { createHash, randomBytes } from 'node:crypto';
import { router, sendJson, requireCookieAuth } from './http.ts';
import { config } from './config.ts';
import { encrypt, decrypt } from './secrets.ts';
import { HttpError } from './util.ts';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPE = 'user:inference';
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const FLOW_TTL_MS = 10 * 60_000;

let fetcher: typeof fetch = fetch;
export function setClaudePlanFetchForTests(value: typeof fetch | null): void { fetcher = value ?? fetch; }

interface Flow { v: 1; user: string; state: string; verifier: string; exp: number }
const b64url = (b: Buffer) => b.toString('base64url');

export function startClaudePlanSignIn(userId: string): { url: string; flow: string } {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  const flow: Flow = { v: 1, user: userId, state, verifier, exp: Date.now() + FLOW_TTL_MS };
  return { url: url.href, flow: encrypt(JSON.stringify(flow), config.secretKey) };
}

function openFlow(blob: unknown, userId: string): Flow {
  const expired = new HttpError(400, 'This sign-in has expired. Start again.');
  if (typeof blob !== 'string' || blob.length > 4096) throw expired;
  let flow: Flow;
  try { flow = JSON.parse(decrypt(blob, config.secretKey)); } catch { throw expired; }
  if (flow?.v !== 1 || flow.user !== userId || !(flow.exp > Date.now())) throw expired;
  return flow;
}

export async function finishClaudePlanSignIn(userId: string, blob: unknown, pasted: unknown): Promise<string> {
  const flow = openFlow(blob, userId);
  if (typeof pasted !== 'string' || !pasted.trim() || pasted.length > 2048) throw new HttpError(400, 'Paste the code shown after you signed in.');
  // The page shows "<code>#<state>"; accept the bare code too.
  const [code, state] = pasted.trim().split('#');
  if (!code) throw new HttpError(400, 'Paste the code shown after you signed in.');
  if (state !== undefined && state !== flow.state) throw new HttpError(400, 'That code is from a different sign-in. Start again and use the newest link.');
  let res: Response;
  try {
    res = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID,
        code_verifier: flow.verifier, state: flow.state, expires_in: ONE_YEAR_SECONDS,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new HttpError(502, 'Could not reach Claude to finish sign-in. Try again.'); }
  if (res.status === 400 || res.status === 401) throw new HttpError(400, 'Claude did not accept that code. It may have expired or been used already. Start again.');
  if (!res.ok) throw new HttpError(502, 'Claude could not finish sign-in. Try again.');
  const token = ((await res.json().catch(() => ({}))) as { access_token?: unknown }).access_token;
  if (typeof token !== 'string' || !token.startsWith('sk-ant-')) throw new HttpError(502, 'Claude did not return a token. Start again.');
  return token;
}

export function registerClaudePlanRoutes(): void {
  router.post('/api/credentials/claude-plan/start', requireCookieAuth(async (req, res) => {
    sendJson(res, 200, startClaudePlanSignIn(req.user!.id));
  }));
  router.post('/api/credentials/claude-plan/finish', requireCookieAuth(async (req, res) => {
    const body = (req.body ?? {}) as { flow?: unknown; code?: unknown };
    // no-store: the response carries a secret.
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { token: await finishClaudePlanSignIn(req.user!.id, body.flow, body.code) });
  }));
}
