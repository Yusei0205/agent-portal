/**
 * Live updates through AWS AppSync Events (cloud mode).
 *
 * On Lambda, in-memory SSE cannot work: each stream holds a Lambda slot, and events only reach browsers
 * connected to the instance that produced them. Instead the server publishes every event to an AppSync
 * Events channel and browsers subscribe to those channels over WebSocket.
 *
 *   /project/<projectId>   events from emit(projectId, ...)
 *   /global/portal         events from emitGlobal(...)
 *   /run/<runId>           events from publishRunEvent(...)
 *
 * Enabled when PORTAL_EVENTS_HTTP_DOMAIN is set; otherwise everything here is a no-op and SSE is used.
 *
 * Browser access: GET /api/realtime/config returns a short-lived signed token (HS256) that the AppSync
 * Lambda authorizer verifies. The token lists the projects the user may subscribe to.
 */

import { createHash, createHmac } from 'node:crypto';
import { config } from './config.ts';

export const TOKEN_TTL_SECONDS = 3600;

export function realtimeEnabled(): boolean {
  return Boolean(process.env.PORTAL_EVENTS_HTTP_DOMAIN);
}

// ── Token ─────────────────────────────────────────────────────────────────────

/** Both the portal and the AppSync authorizer derive the signing key from the master key this way. */
function signingKey(): Buffer {
  return createHmac('sha256', config.secretKey).update('portal-realtime-v1').digest();
}

export function issueRealtimeToken(user: { id: string; is_admin: boolean }, projectIds: string[]): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({
    sub: user.id,
    adm: user.is_admin,
    prj: user.is_admin ? [] : projectIds,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  });
  const sig = createHmac('sha256', signingKey()).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${sig}`;
}

// ── Publishing ────────────────────────────────────────────────────────────────

// Minimal SHA-256 for @smithy/signature-v4 on top of node:crypto.
function Sha256(this: { _h: ReturnType<typeof createHash> | ReturnType<typeof createHmac> }, secret?: Uint8Array | string): void {
  this._h = secret != null ? createHmac('sha256', Buffer.from(secret as string)) : createHash('sha256');
}
Sha256.prototype.update = function (this: { _h: { update(d: Buffer): void } }, data: Uint8Array | string): void {
  this._h.update(Buffer.from(data as string));
};
Sha256.prototype.digest = function (this: { _h: { digest(): Buffer } }): Promise<Uint8Array> {
  return Promise.resolve(this._h.digest());
};
Sha256.prototype.reset = function (): void { /* not used */ };

type Signer = { sign(req: object): Promise<{ headers: Record<string, string> }> };
let signer: Signer | null = null;

async function getSigner(): Promise<Signer> {
  if (signer) return signer;
  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  signer = new SignatureV4({
    credentials: defaultProvider(),
    region: process.env.AWS_REGION ?? 'ap-southeast-1',
    service: 'appsync',
    sha256: Sha256 as never,
  }) as unknown as Signer;
  return signer;
}

const MAX_BATCH = 5; // AppSync Events accepts at most 5 events per publish request
const queues = new Map<string, string[]>();
let flushTimer: NodeJS.Timeout | null = null;
const inflight = new Set<Promise<void>>();

async function publishBatch(channel: string, events: string[]): Promise<void> {
  const domain = process.env.PORTAL_EVENTS_HTTP_DOMAIN!;
  const body = JSON.stringify({ channel, events });
  const signed = await (await getSigner()).sign({
    method: 'POST',
    headers: { 'content-type': 'application/json', host: domain },
    hostname: domain,
    path: '/event',
    body,
  });
  const headers = Object.fromEntries(Object.entries(signed.headers).filter(([k]) => k.toLowerCase() !== 'host'));
  const res = await fetch(`https://${domain}/event`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`AppSync publish ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function startFlush(): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [channel, events] of queues) {
    for (let i = 0; i < events.length; i += MAX_BATCH) {
      work.push(
        publishBatch(channel, events.slice(i, i + MAX_BATCH)).catch((e) => {
          console.error('[realtime] publish failed:', e instanceof Error ? e.message : e);
        }),
      );
    }
  }
  queues.clear();
  const p = Promise.all(work).then(() => undefined);
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
  return p;
}

/** Queue an event for a channel; events published within ~40 ms are sent together. */
export function publishToChannel(channel: string, event: object): void {
  if (!realtimeEnabled()) return;
  let q = queues.get(channel);
  if (!q) { q = []; queues.set(channel, q); }
  q.push(JSON.stringify(event));
  if (!flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; void startFlush(); }, 40);
  }
}

/** Wait until everything queued so far has been sent (Lambda freezes once the response ends). */
export async function flushRealtime(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; void startFlush(); }
  if (inflight.size) await Promise.all([...inflight]);
}
