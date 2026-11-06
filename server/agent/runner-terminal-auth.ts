import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { parseSnapshot, type WorkspaceSnapshot } from './runner-snapshot.ts';

type GrantRequest = { workflowId: string; engine: string; origin: string; actor: string; snapshot: WorkspaceSnapshot };
const snapshotHash = (snapshot: WorkspaceSnapshot) => createHash('sha256').update(JSON.stringify({ getUrl: snapshot.getUrl ?? null, putUrl: snapshot.putUrl })).digest('hex');
function signingKey(secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Terminal signing key is not configured');
  const seed = createHmac('sha256', Buffer.from(secret, 'hex')).update('agent-portal/terminal/ed25519/v1').digest();
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}
export const terminalPublicKey = (secret: string): string => createPublicKey(signingKey(secret)).export({ format: 'pem', type: 'spki' }).toString();
export function signTerminalGrant(secret: string, request: GrantRequest): string {
  const data = Buffer.from(JSON.stringify({ ...request, snapshot: undefined, snapshotHash: snapshotHash(request.snapshot),
    scope: 'terminal', nonce: randomBytes(32).toString('hex'), expires: Date.now() + 60_000 })).toString('base64url');
  return data + '.' + sign(null, Buffer.from(data), signingKey(secret)).toString('base64url');
}
export function verifyTerminalGrant(body: Record<string, unknown>, publicKey: string, engine: string): { nonce: string; expires: number } {
  if (typeof body.grant !== 'string' || body.grant.length > 4096) throw new Error('Signed terminal grant required');
  const [data, signature, extra] = body.grant.split('.');
  const key = createPublicKey(publicKey);
  if (!data || !signature || extra || key.asymmetricKeyType !== 'ed25519'
    || !verify(null, Buffer.from(data), key, Buffer.from(signature, 'base64url'))) throw new Error('Invalid terminal grant signature');
  const grant = JSON.parse(Buffer.from(data, 'base64url').toString());
  const snapshot = parseSnapshot(body.snapshot);
  if (grant.scope !== 'terminal' || grant.engine !== engine || grant.workflowId !== body.workflowId || grant.origin !== body.origin
    || !snapshot || grant.snapshotHash !== snapshotHash(snapshot) || typeof grant.actor !== 'string' || !grant.actor
    || !/^[a-f0-9]{64}$/.test(grant.nonce) || !Number.isSafeInteger(grant.expires)
    || grant.expires <= Date.now() || grant.expires > Date.now() + 90_000) throw new Error('Expired or mismatched terminal grant');
  return { nonce: grant.nonce, expires: grant.expires };
}

/** The issuer is pinned by deployment configuration, never supplied by the caller or the agent. */
export function terminalGrantVerifier(issuer: string | undefined, engine: string) {
  let cached: { key: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return async (body: Record<string, unknown>) => {
    if (typeof body.grant !== 'string' || body.grant.length > 4096 || !issuer) throw new Error('Signed terminal grant required');
    const origin = new URL(issuer);
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('A trusted HTTPS terminal issuer is required');
    let key = cached && cached.until > Date.now() ? cached.key : undefined;
    if (!key) {
      pending ??= (async () => {
        const response = await fetch(origin.origin + '/api/terminal/public-key', { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error('Terminal issuer is unavailable');
        const text = await response.text();
        if (text.length > 4096) throw new Error('Invalid terminal public key');
        const value = JSON.parse(text).publicKey;
        if (typeof value !== 'string' || createPublicKey(value).asymmetricKeyType !== 'ed25519') throw new Error('Invalid terminal public key');
        cached = { key: value, until: Date.now() + 300_000 };
        return value;
      })();
      try { key = await pending; } finally { pending = undefined; }
    }
    return verifyTerminalGrant(body, key, engine);
  };
}
