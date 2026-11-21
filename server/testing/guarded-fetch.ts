/**
 * fetch that checks the address it actually connects to.
 *
 * assertNotBlocked() resolves the name and checks the answer, then fetch resolves it again to connect. A DNS server
 * the caller controls can answer with a public address the first time and 169.254.169.254 or 10.x the second
 * (DNS rebinding). Here the check runs inside the connection's own lookup, on the addresses the socket will use, so
 * there is no second answer to switch to. Literal IP addresses never reach the lookup and are covered by the
 * assertNotBlocked() call made before the request.
 */
import dns from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { checkAddress } from './ssrf.ts';

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/** A lookup function that refuses blocked addresses. Exported for tests. */
export function guardedLookup(allowPrivateNetworks: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      const list = addrs as dns.LookupAddress[];
      for (const a of list) {
        const verdict = checkAddress(a.address, allowPrivateNetworks);
        if (verdict.blocked) {
          const e: NodeJS.ErrnoException = new Error(`SSRF blocked: ${verdict.reason}`);
          e.code = 'ESSRFBLOCKED';
          return callback(e);
        }
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

const agents = new Map<boolean, Agent>();
function agentFor(allowPrivateNetworks: boolean): Agent {
  let a = agents.get(allowPrivateNetworks);
  if (!a) {
    a = new Agent({ connect: { lookup: guardedLookup(allowPrivateNetworks) as never } });
    agents.set(allowPrivateNetworks, a);
  }
  return a;
}

export function guardedFetch(url: string, init: RequestInit, allowPrivateNetworks: boolean): Promise<Response> {
  return undiciFetch(url, { ...(init as object), dispatcher: agentFor(allowPrivateNetworks) } as never) as unknown as Promise<Response>;
}
