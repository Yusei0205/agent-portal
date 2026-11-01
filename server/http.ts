/**
 * Thin HTTP router wrapping node:http.
 *
 * Usage:
 *   import { router, requireAuth } from './http.ts';
 *
 *   router.get('/api/foo', async (req, res) => { ... });
 *   router.post('/api/foo', requireAuth, async (req, res) => { ... });
 *   router.sse('/api/foo/stream', (req, res) => { ... });
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { HttpError } from './util.ts';

// ── Request / Response types ──────────────────────────────────────────────────

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  is_admin: number;
}

export interface PortalRequest extends IncomingMessage {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  user?: PortalUser | null;
  ip: string;
  secure: boolean;
  /** Raw body buffer, lazily read. */
  rawBody?: Buffer;
  /** Scopes from the API token, if authenticated via Bearer token. Undefined for cookie/anon auth. */
  tokenScopes?: string[];
  /** True when the request was authenticated via an API token (not a browser cookie). */
  authViaToken?: boolean;
  /** For delegate-scoped tokens: the workflow ID the token is bound to. */
  tokenWorkflowId?: string | null;
}

export type PortalResponse = ServerResponse;

export type Handler = (req: PortalRequest, res: PortalResponse) => Promise<void> | void;

// ── Auth info (populated by authenticator, consumed by request handler) ───────

/** Side-channel output written by the authenticator for token-based auth. */
export interface AuthInfo {
  tokenScopes?: string[];
  authViaToken?: boolean;
  /** For delegate-scoped tokens: the workflow ID the token is bound to. */
  tokenWorkflowId?: string | null;
}

// ── Route registry ────────────────────────────────────────────────────────────

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
  isSSE: boolean;
  /** Pattern the route was registered with, for debugging. */
  pattern: string;
  /** When true: skip CSRF check and body parsing (for API-token-only endpoints). */
  bypassCsrf: boolean;
}

const routes: Route[] = [];

/** Clear all registered routes (used in tests for clean state between test runs). */
export function clearRoutes(): void {
  routes.splice(0);
}

function registerRoute(
  method: string,
  pattern: string,
  handler: Handler,
  isSSE = false,
  bypassCsrf = false,
): void {
  const keys: string[] = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, k: string) => {
        keys.push(k);
        return '/([^/]+)';
      }) +
      '/?$',
  );
  routes.push({ method, re, keys, handler, isSSE, pattern, bypassCsrf });
}

// ── Public router object ──────────────────────────────────────────────────────

export const router = {
  get(pattern: string, handler: Handler): void {
    registerRoute('GET', pattern, handler);
  },
  post(pattern: string, handler: Handler): void {
    registerRoute('POST', pattern, handler);
  },
  put(pattern: string, handler: Handler): void {
    registerRoute('PUT', pattern, handler);
  },
  delete(pattern: string, handler: Handler): void {
    registerRoute('DELETE', pattern, handler);
  },
  patch(pattern: string, handler: Handler): void {
    registerRoute('PATCH', pattern, handler);
  },
  /** Register a Server-Sent Events endpoint. No CSRF check, no JSON body parsing. */
  sse(pattern: string, handler: Handler): void {
    registerRoute('GET', pattern, handler, true);
  },
  /**
   * Register a POST endpoint that bypasses CSRF check and body parsing.
   * Use for Bearer-token-only API endpoints (e.g. MCP). The handler is
   * responsible for reading the body and enforcing its own authentication.
   */
  rawPost(pattern: string, handler: Handler): void {
    registerRoute('POST', pattern, handler, false, true);
  },
  /**
   * Register a GET endpoint that bypasses body parsing (body is never relevant for GET,
   * but marks the route so the handler can opt out of standard processing if needed).
   */
  rawGet(pattern: string, handler: Handler): void {
    registerRoute('GET', pattern, handler, false, true);
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const list = Array.isArray(prev) ? prev : prev != null ? [String(prev)] : [];
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

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body too large (max ${Math.round(limit / 1024)} KB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Static file serving ───────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

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

function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const root = config.webDir;
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
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
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
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
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// ── Authenticator injection ───────────────────────────────────────────────────

export type Authenticator = (
  req: IncomingMessage,
  authInfo: AuthInfo,
) => Promise<PortalUser | null> | PortalUser | null;

let _authenticator: Authenticator = () => null;

export function setAuthenticator(fn: Authenticator): void {
  _authenticator = fn;
}

// ── requireAuth middleware ────────────────────────────────────────────────────

/**
 * Middleware that attaches the authenticated user to `req.user`.
 * Returns 401 if not authenticated.
 * Usage: wrap your handler or register as the handler after setting the authenticator.
 */
export function requireAuth(
  handler: (req: PortalRequest, res: PortalResponse) => Promise<void> | void,
): Handler {
  return async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) {
      sendJson(res, 401, { error: 'Sign in to continue' });
      return;
    }
    return handler(req, res);
  };
}

/**
 * Middleware that requires browser-session authentication only.
 * Rejects API token requests with 403.
 * Use for routes that manage sensitive user data: tokens, credentials, settings.
 */
export function requireCookieAuth(
  handler: (req: PortalRequest, res: PortalResponse) => Promise<void> | void,
): Handler {
  return async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) {
      sendJson(res, 401, { error: 'Sign in to continue' });
      return;
    }
    if (req.authViaToken) {
      sendJson(res, 403, { error: 'This endpoint requires browser authentication, not an API token' });
      return;
    }
    return handler(req, res);
  };
}

// ── Request handler factory ───────────────────────────────────────────────────

export function createRequestHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> {
  return async (rawReq: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(rawReq.url ?? '/', 'http://localhost');
    const urlPath = url.pathname;

    // Determine if request came over HTTPS (for cookie Secure flag)
    const forwardedProto = String(rawReq.headers['x-forwarded-proto'] ?? '');
    const secure =
      config.cookieSecure === 'true' ||
      (config.cookieSecure !== 'false' &&
        (config.trustProxy && forwardedProto === 'https'));

    // Determine client IP
    const forwardedFor =
      config.trustProxy
        ? String(rawReq.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
        : '';
    const ip = forwardedFor || (rawReq.socket.remoteAddress ?? '');

    // Build PortalRequest
    const req = rawReq as PortalRequest;
    req.params = {};
    req.query = url.searchParams;
    req.body = undefined;
    req.user = null;
    req.ip = ip;
    req.secure = secure;

    try {
      // ── Static files (non-API paths) ─────────────────────────────────────
      if (!urlPath.startsWith('/api/')) {
        if (serveStatic(rawReq, res, urlPath)) return;
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      // ── CORS headers ──────────────────────────────────────────────────────
      const origin = String(rawReq.headers.origin ?? '');
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }

      // ── OPTIONS preflight ──────────────────────────────────────────────────
      if (rawReq.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.writeHead(204);
        res.end();
        return;
      }

      // ── Authenticate ──────────────────────────────────────────────────────
      const _authInfo: AuthInfo = {};
      req.user = await _authenticator(rawReq, _authInfo);
      if (_authInfo.tokenScopes !== undefined) req.tokenScopes = _authInfo.tokenScopes;
      if (_authInfo.authViaToken) req.authViaToken = true;
      if (_authInfo.tokenWorkflowId !== undefined) req.tokenWorkflowId = _authInfo.tokenWorkflowId;

      // Delegate-scoped tokens may only reach the MCP endpoint — nothing on REST.
      if (
        req.authViaToken &&
        req.tokenScopes?.length === 1 &&
        req.tokenScopes[0] === 'delegate' &&
        !urlPath.startsWith('/api/mcp')
      ) {
        throw new HttpError(401, 'Delegate tokens can only be used with the /api/mcp endpoint');
      }

      // ── Route matching ────────────────────────────────────────────────────
      const method = rawReq.method ?? 'GET';
      let matched: Route | null = null;
      let methodMismatch = false;

      for (const route of routes) {
        const m = route.re.exec(urlPath);
        if (!m) continue;
        if (route.method !== method) {
          methodMismatch = true;
          continue;
        }
        matched = route;
        route.keys.forEach((k, i) => {
          req.params[k] = decodeURIComponent(m[i + 1] ?? '');
        });
        break;
      }

      if (!matched) {
        throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed' : 'Not found');
      }

      // ── CSRF guard ─────────────────────────────────────────────────────────
      // State-changing API calls must carry the custom header that only same-origin scripts can set.
      // SSE endpoints are read-only; GET/HEAD are safe; bypassCsrf routes use Bearer tokens (CSRF-safe).
      if (
        !matched.isSSE &&
        !matched.bypassCsrf &&
        method !== 'GET' &&
        method !== 'HEAD' &&
        rawReq.headers['x-requested-with'] !== 'agent-portal'
      ) {
        throw new HttpError(403, 'Missing request header');
      }

      // ── Body parsing (JSON) ───────────────────────────────────────────────
      if (!matched.isSSE && !matched.bypassCsrf && method !== 'GET' && method !== 'HEAD') {
        const ct = String(rawReq.headers['content-type'] ?? '');
        // Multipart uploads can be up to maxUploadBytes; JSON is capped at 5 MB
        const bodyLimit = ct.includes('multipart/form-data')
          ? config.maxUploadBytes
          : 5 * 1024 * 1024;
        const raw = await readBody(rawReq, bodyLimit);
        req.rawBody = raw;
        if (raw.length > 0) {
          if (ct.includes('application/json')) {
            try {
              req.body = JSON.parse(raw.toString('utf8'));
            } catch {
              throw new HttpError(400, 'Request body is not valid JSON');
            }
          }
        }
        if (req.body === undefined) req.body = {};
      }

      await matched.handler(req, res);
    } catch (err: unknown) {
      const isHttp = err instanceof HttpError;
      const status = isHttp ? err.status : 500;
      const message = isHttp
        ? err.message
        : 'Something went wrong on the server. Check the server log.';
      if (!isHttp) {
        console.error(`[${new Date().toISOString()}] ${rawReq.method} ${rawReq.url}`, err);
      }
      if (!res.headersSent) {
        sendJson(res, status, { error: message });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

// ── WebSocket upgrade hook ────────────────────────────────────────────────────

type WsUpgradeHandler = (
  req: import('node:http').IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
) => void;

let _wsUpgradeHandler: WsUpgradeHandler | null = null;

/**
 * Register a handler for WebSocket upgrade requests.
 * Only one handler can be registered; subsequent calls overwrite the previous one.
 */
export function setWsUpgradeHandler(fn: WsUpgradeHandler): void {
  _wsUpgradeHandler = fn;
}

// ── HTTP server factory ───────────────────────────────────────────────────────

export function createServer(): http.Server {
  const handler = createRequestHandler();
  const server = http.createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      console.error('[http] Unhandled error in request handler', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });
  server.requestTimeout = 0; // uploads and SSE streams can be long
  server.headersTimeout = 60_000;

  // WebSocket upgrade events (terminal, future live features)
  server.on('upgrade', (req, socket, head) => {
    if (_wsUpgradeHandler) {
      _wsUpgradeHandler(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  return server;
}
