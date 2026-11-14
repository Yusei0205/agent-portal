/**
 * The address people use to reach the portal, for links the server builds (OAuth callbacks, invite links).
 *
 * Behind CloudFront the request's Host header is the internal Lambda URL, which is not what the browser (or an
 * OAuth provider's allow-list) knows. PORTAL_PUBLIC_URL (deploy context `publicUrl`) is used when set; local and
 * Docker installs fall back to the address of the request.
 */
import type { PortalRequest } from './http.ts';

export function publicBaseUrl(req: PortalRequest): string {
  const configured = process.env.PORTAL_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = req.headers.host ?? 'localhost:8787';
  return `${req.secure ? 'https' : 'http'}://${host}`;
}
