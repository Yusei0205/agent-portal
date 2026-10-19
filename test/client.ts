import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

export interface TestServer {
  base: string;
  dataDir: string;
  server: Server;
  close: () => Promise<void>;
}

export async function bootServer(): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEMO_SPEED = '0';
  process.env.PORTAL_NO_AUTOSTART = '1';
  process.env.PORTAL_SECRET_KEY = 'test-secret-key-for-unit-tests';
  const { startServer } = await import('../server/index.ts');
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  const addr = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${addr.port}`,
    dataDir,
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export class Client {
  cookie = '';
  constructor(public base: string) {}

  async req(method: string, url: string, body?: unknown, opts: { raw?: Buffer; noCsrf?: boolean } = {}): Promise<{ status: number; data: any; headers: Headers; buf?: Buffer }> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (!opts.noCsrf) headers['x-requested-with'] = 'agent-portal';
    let payload: Uint8Array | string | undefined;
    if (opts.raw) {
      headers['content-type'] = 'application/octet-stream';
      payload = new Uint8Array(opts.raw);
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + url, { method, headers, body: payload });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair.startsWith('portal_session=')) this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) return { status: res.status, data: await res.json(), headers: res.headers };
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, data: buf.toString('utf8'), headers: res.headers, buf };
  }

  async ok(method: string, url: string, body?: unknown, opts?: { raw?: Buffer }): Promise<any> {
    const r = await this.req(method, url, body, opts);
    if (r.status >= 400) throw new Error(`${method} ${url} -> ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  }

  get = (u: string) => this.ok('GET', u);
  post = (u: string, b?: unknown) => this.ok('POST', u, b ?? {});
  put = (u: string, b?: unknown) => this.ok('PUT', u, b ?? {});
  patch = (u: string, b?: unknown) => this.ok('PATCH', u, b ?? {});
  del = (u: string, b?: unknown) => this.ok('DELETE', u, b);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last}` : ''}`);
}
