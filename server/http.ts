import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.ts';
import { config } from './config.ts';

export interface User {
  id: string;
  email: string;
  name: string;
  is_admin: number;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  user: User | null;
  ip: string;
  /** Parsed JSON body (lazy). */
  json<T = any>(): Promise<T>;
  /** Raw body buffer (lazy), for uploads. */
  raw(limit?: number): Promise<Buffer>;
  secure: boolean;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export interface RouteOpts {
  /** 'public' = no login, 'user' = any signed-in user, 'admin' = admins only. */
  auth?: 'public' | 'user' | 'admin';
}

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
  auth: 'public' | 'user' | 'admin';
}

const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}): void {
  const keys: string[] = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/\/:([A-Za-z_]+)/g, (_m, k) => {
        keys.push(k);
        return '/([^/]+)';
      }) +
      '/?$',
  );
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
}

export const get = (p: string, h: Handler, o?: RouteOpts) => route('GET', p, h, o);
export const post = (p: string, h: Handler, o?: RouteOpts) => route('POST', p, h, o);
export const put = (p: string, h: Handler, o?: RouteOpts) => route('PUT', p, h, o);
export const patch = (p: string, h: Handler, o?: RouteOpts) => route('PATCH', p, h, o);
export const del = (p: string, h: Handler, o?: RouteOpts) => route('DELETE', p, h, o);

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Upload is too large (max ${Math.round(limit / 1024 / 1024)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  opts: { maxAge?: number; secure: boolean },
): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Marker for handlers that already wrote the response (files, SSE). */
export const HANDLED = Symbol('handled');

export function sendFile(res: ServerResponse, body: Buffer | string, type: string, filename?: string): typeof HANDLED {
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`;
  res.writeHead(200, headers);
  res.end(body);
  return HANDLED;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveStatic(ctx: Ctx): boolean {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return false;
  const root = config.webDir;
  let rel = decodeURIComponent(ctx.path);
  if (rel.includes('\0')) return false;
  let file = path.resolve(root, '.' + rel);
  if (!file.startsWith(path.resolve(root))) return false;
  let isIndex = false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (rel.startsWith('/assets/')) return false;
    file = path.join(root, 'index.html');
    isIndex = true;
    if (!fs.existsSync(file)) return false;
  }
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  ctx.res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': isIndex || ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...(ext === '.html'
      ? {
          'Content-Security-Policy':
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
          'X-Frame-Options': 'DENY',
        }
      : {}),
  });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
  return true;
}

export type Authenticator = (ctx: Ctx) => User | null;

export function createHandler(authenticate: Authenticator) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '');
    const secure =
      config.cookieSecure === 'true' ||
      (config.cookieSecure === 'auto' &&
        ((req.socket as any).encrypted || (config.trustProxy && forwardedProto === 'https')));
    let bodyCache: Buffer | null = null;
    const ctx: Ctx = {
      req,
      res,
      method: req.method || 'GET',
      path: url.pathname,
      query: url.searchParams,
      params: {},
      user: null,
      ip: (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '',
      secure: Boolean(secure),
      async raw(limit = config.maxUploadBytes) {
        if (!bodyCache) bodyCache = await readBody(req, limit);
        return bodyCache;
      },
      async json() {
        const buf = await ctx.raw(5 * 1024 * 1024);
        if (!buf.length) return {} as any;
        try {
          return JSON.parse(buf.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Request body is not valid JSON');
        }
      },
    };

    try {
      if (!ctx.path.startsWith('/api/')) {
        if (serveStatic(ctx)) return;
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      // CSRF guard: state-changing API calls must carry the custom header that only same-origin scripts can set.
      if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && req.headers['x-requested-with'] !== 'agent-portal') {
        throw new HttpError(403, 'Missing request header');
      }
      let matched: Route | null = null;
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(ctx.path);
        if (!m) continue;
        if (r.method !== ctx.method) {
          methodMismatch = true;
          continue;
        }
        matched = r;
        r.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
        break;
      }
      if (!matched) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed' : 'Not found');
      ctx.user = authenticate(ctx);
      if (matched.auth !== 'public' && !ctx.user) throw new HttpError(401, 'Sign in to continue');
      if (matched.auth === 'admin' && !ctx.user?.is_admin) throw new HttpError(403, 'Only admins can do this');
      const out = await matched.handler(ctx);
      if (out === HANDLED || res.headersSent || res.writableEnded) return;
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(`[${new Date().toISOString()}] ${ctx.method} ${ctx.path}`, e);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server. Check the server log.' : e.message });
      else res.end();
    }
  };
}

/** Server-sent events stream. */
export function openSse(ctx: Ctx): { send: (event: string, data: unknown) => void; close: () => void; onClose: (fn: () => void) => void } {
  const { res, req } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const closers: (() => void)[] = [];
  const timer = setInterval(() => res.write(': ping\n\n'), 25_000);
  const close = () => {
    clearInterval(timer);
    for (const fn of closers.splice(0)) fn();
    if (!res.writableEnded) res.end();
  };
  req.on('close', close);
  return {
    send(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
    onClose(fn) {
      closers.push(fn);
    },
  };
}
