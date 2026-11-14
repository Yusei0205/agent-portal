import { isIP } from 'node:net';

/**
 * The address of the person making a request.
 *
 * On the cloud portal CloudFront runs a small function that sets x-portal-client-ip to the connecting address,
 * replacing anything the client sent, and only requests carrying CloudFront's secret reach the server. So when the
 * origin secret is configured that header is trusted and X-Forwarded-For (which a client can write) is not.
 * Elsewhere: the first X-Forwarded-For entry when behind a trusted proxy, else the socket address.
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  opts: { originSecretSet: boolean; trustProxy: boolean },
): string {
  const header = (name: string): string => String(headers[name] ?? '').trim();
  if (opts.originSecretSet) {
    const viaCloudFront = header('x-portal-client-ip');
    if (isIP(viaCloudFront)) return viaCloudFront;
  }
  const forwarded = opts.trustProxy ? header('x-forwarded-for').split(',')[0].trim() : '';
  return forwarded || (socketAddress ?? '');
}
