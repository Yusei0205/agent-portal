/**
 * Signed address for AgentCore Browser Live View.
 *
 * Live View streams the agent's cloud browser (AWS DCV) to a person's browser and accepts their mouse and keyboard.
 * The page connects to AWS directly; the portal only signs the address (SigV4 query string, short lifetime) with its own
 * role, so the role needs bedrock-agentcore:ConnectBrowserLiveViewStream.
 */

import { Sha256 } from './realtime.ts';

const BROWSER_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export async function presignLiveViewUrl(browserId: string, sessionId: string, expiresIn = 300): Promise<string> {
  if (!BROWSER_ID_RE.test(browserId) || !SESSION_ID_RE.test(sessionId)) throw new Error('Invalid browser session');
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const host = `bedrock-agentcore.${region}.amazonaws.com`;
  const path = `/browser-streams/${browserId}/sessions/${sessionId}/live-view`;

  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'bedrock-agentcore',
    sha256: Sha256 as never,
  });
  const presigned = await signer.presign(
    { protocol: 'https:', hostname: host, path, method: 'GET', headers: { host }, query: {} } as never,
    { expiresIn },
  );
  const qs = Object.entries(presigned.query ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `https://${host}${path}?${qs}`;
}

/**
 * Pause or resume the agent's control of the browser (AgentCore UpdateBrowserStream, automation stream).
 * While it is DISABLED the agent's browser commands are refused, so a person can drive the page through Live View.
 */
export async function setAutomationStream(browserId: string, sessionId: string, enabled: boolean): Promise<void> {
  if (!BROWSER_ID_RE.test(browserId) || !SESSION_ID_RE.test(sessionId)) throw new Error('Invalid browser session');
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const host = `bedrock-agentcore.${region}.amazonaws.com`;
  const path = `/browsers/${browserId}/sessions/streams/update`;
  const body = JSON.stringify({ streamUpdate: { automationStreamUpdate: { streamStatus: enabled ? 'ENABLED' : 'DISABLED' } } });

  const { SignatureV4 } = await import('@smithy/signature-v4');
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  const signer = new SignatureV4({ credentials: defaultProvider(), region, service: 'bedrock-agentcore', sha256: Sha256 as never });
  const signed = await signer.sign({
    protocol: 'https:', hostname: host, method: 'PUT', path,
    query: { sessionId },
    headers: { host, 'content-type': 'application/json' },
    body,
  } as never);
  const r = await fetch(`https://${host}${path}?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: (signed as unknown as { headers: Record<string, string> }).headers,
    body,
  });
  if (!r.ok) throw new Error(`UpdateBrowserStream ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
