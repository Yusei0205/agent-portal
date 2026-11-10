/**
 * API simulation routes (docs/plans/2026-11-10-api-simulation.md).
 *
 * Team-facing (cookie or token auth, project members only):
 *   GET    /api/projects/:id/sim/apis                          list
 *   POST   /api/projects/:id/sim/import                        {kind:'xlsx',contentBase64,paths?} | {kind:'openapi',spec}
 *   GET    /api/projects/:id/sim/apis/:aid?version=            one API with a spec version, its flags and rules
 *   PUT    /api/projects/:id/sim/apis/:aid                     mode, liveBaseUrl, requireExplicitRule, operationModes, name
 *   DELETE /api/projects/:id/sim/apis/:aid
 *   PUT    /api/projects/:id/sim/apis/:aid/versions/:v/path    {path, operationId?}  (draft versions only)
 *   POST   /api/projects/:id/sim/apis/:aid/versions/:v/approve
 *   GET    /api/projects/:id/sim/apis/:aid/rules
 *   PUT    /api/projects/:id/sim/apis/:aid/rules/:rid
 *   DELETE /api/projects/:id/sim/apis/:aid/rules/:rid
 *   POST   /api/projects/:id/sim/apis/:aid/try                 run the engine on a sample request (no delay, no live call)
 *
 * The simulated API itself (portal API token required in Authorization; answers only from an APPROVED version):
 *   ANY    /api/sim/:projectId/:apiId/call/<path in the spec>
 * The portal token occupies Authorization, so the client's own credential goes in X-Sim-Authorization.
 * It is passed on as Authorization to the mock (for operations that need one) or to the live API. The portal token is never forwarded.
 */

import type { IncomingMessage } from 'node:http';
import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { generateId, now } from '../util.ts';
import { requireProjectAccess, bad } from './access.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import type { SimApiRecord, SimMode } from '../repositories/simulation.ts';
import { handleMockRequest } from './mock-engine.ts';
import { answerCall, clientHeaders } from './call.ts';
import { importDrafts } from './import-drafts.ts';
import { checkOpenApi } from './openapi.ts';
import { registerApiTestRoutes } from './test-routes.ts';
import { postmanToSpecs } from './postman.ts';
import { diffSpecs } from './spec-diff.ts';
import { registerApiRunRoutes } from './api-run-routes.ts';
import { registerAiRuleRoutes } from './ai-rules.ts';
import { registerSimMcpRoutes } from './mcp.ts';
import { registerAiImportRoutes } from './ai-import.ts';
import { parseSheets, readWorkbook, toDraftSpec } from './excel-spec.ts';
import type { ApiSpec, FailureKind, Flag, HttpMethod, MockRule } from './types.ts';

const MODES: SimMode[] = ['mock', 'hybrid', 'live'];
const FAILURES: FailureKind[] = ['timeout', 'server_error', 'rate_limited', 'malformed'];
const MAX_HOSTED_DELAY_MS = 10_000;
const MAX_HOSTED_BODY = 1024 * 1024;

// ── Helpers ───────────────────────────────────────────────────────────────────


export function collectFlags(spec: ApiSpec): Flag[] {
  const out: Flag[] = [...(spec['x-flags'] ?? [])];
  for (const item of Object.values(spec.paths)) for (const op of Object.values(item)) out.push(...(op?.['x-flags'] ?? []));
  return out;
}

function hasMissingPath(spec: ApiSpec): boolean {
  return collectFlags(spec).some((f) => f.code === 'MISSING_PATH');
}

function operations(spec: ApiSpec): Array<{ path: string; method: HttpMethod; operationId: string }> {
  const out: Array<{ path: string; method: HttpMethod; operationId: string }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) if (op) out.push({ path, method: method as HttpMethod, operationId: op.operationId });
  }
  return out;
}

function summary(a: SimApiRecord, spec: ApiSpec | null) {
  const flags = spec ? collectFlags(spec) : [];
  return {
    id: a.id, name: a.name, mode: a.mode, approvedVersion: a.approved_version, latestVersion: a.latest_version,
    requireExplicitRule: a.require_explicit_rule, liveBaseUrl: a.live_base_url, operationModes: a.operation_modes,
    operations: spec ? operations(spec) : [],
    flags: { total: flags.length, warnings: flags.filter((f) => f.severity === 'warning').length, missingPath: spec ? hasMissingPath(spec) : false },
    updatedAt: a.updated_at,
  };
}

function isHttpsUrl(v: string): boolean {
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && v.length <= 2000; } catch { return false; }
}

function stringMap(v: unknown, max: number): Record<string, string> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > max) return null;
  for (const [k, val] of entries) { if (typeof val !== 'string' || val.length > 2000) return null; out[k] = val; }
  return out;
}

/** Validates a rule from a request body. Returns the rule, or a message saying what is wrong. */
export function parseRule(body: Record<string, unknown>, id: string, opIds: Set<string>): MockRule | string {
  const operationId = String(body.operationId ?? '');
  if (!opIds.has(operationId)) return 'operationId is not an operation of this API';
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 120) return 'name is required (at most 120 characters)';
  const rule: MockRule = { id, operationId, name };

  if (body.when !== undefined) {
    if (!body.when || typeof body.when !== 'object') return 'when must be an object';
    const w = body.when as Record<string, unknown>;
    const q = stringMap(w.query, 20);
    if (!q) return 'when.query must be an object of strings';
    if (w.body !== undefined && (!w.body || typeof w.body !== 'object' || Array.isArray(w.body))) return 'when.body must be an object';
    rule.when = { ...(w.body ? { body: w.body as Record<string, unknown> } : {}), ...(Object.keys(q).length ? { query: q } : {}) };
  }
  if (body.response !== undefined) {
    const r = body.response as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return 'response must be an object';
    const status = Number(r.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) return 'response.status must be 100-599';
    const headers = stringMap(r.headers, 20);
    if (!headers) return 'response.headers must be an object of strings';
    if (JSON.stringify(r.body ?? null).length > 200_000) return 'response.body is larger than 200 KB';
    rule.response = { status, ...(Object.keys(headers).length ? { headers } : {}), ...(r.body !== undefined ? { body: r.body } : {}) };
  }
  if (body.failure !== undefined && body.failure !== null && body.failure !== '') {
    if (!FAILURES.includes(body.failure as FailureKind)) return `failure must be one of: ${FAILURES.join(', ')}`;
    rule.failure = body.failure as FailureKind;
  }
  if (!rule.response && !rule.failure) return 'A rule needs a response or a failure';
  if (body.delayMs !== undefined) {
    const d = Number(body.delayMs);
    if (!Number.isFinite(d) || d < 0 || d > 60_000) return 'delayMs must be 0-60000';
    rule.delayMs = Math.round(d);
  }
  // Confirming a rule after a spec change is the only way to clear this.
  if (body.needsReview === true) rule.needsReview = true;
  return rule;
}

/** The part of an operation that decides whether an existing rule still makes sense. */
function fingerprint(op: unknown): string {
  const { 'x-flags': _f, ...rest } = (op ?? {}) as Record<string, unknown>;
  return JSON.stringify(rest);
}

async function latestSpec(a: SimApiRecord): Promise<ApiSpec | null> {
  return (await getSimulationRepository().getVersion(a.id, a.latest_version))?.spec ?? null;
}

// ── Import ────────────────────────────────────────────────────────────────────

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendRaw(res: PortalResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerSimulationRoutes(): void {
  const repo = () => getSimulationRepository();
  const base = '/api/projects/:id/sim';

  router.get(`${base}/apis`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const apis = await repo().listApis(req.params.id);
    const items = [];
    for (const a of apis) items.push(summary(a, await latestSpec(a)));
    sendJson(res, 200, { apis: items });
  });

  router.post(`${base}/import`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const body = req.body as Record<string, unknown>;
    const userId = req.user!.id;

    if (body.kind === 'openapi') {
      const checked = checkOpenApi(body.spec);
      if (!checked.spec) { bad(res, checked.errors.join('; ')); return; }
      const created = await importDrafts(req.params.id, userId, [{ key: `openapi:${checked.spec.info.title}`, name: checked.spec.info.title, spec: checked.spec }]);
      sendJson(res, 201, { created });
      return;
    }

    if (body.kind === 'postman') {
      const { drafts, errors } = postmanToSpecs(body.collection);
      if (drafts.length === 0) { bad(res, errors.join(' ')); return; }
      const created = await importDrafts(req.params.id, userId, drafts.map((d) => ({ key: `postman:${d.name}`, name: d.name, spec: d.spec })));
      sendJson(res, 201, { created, flags: errors.map((message) => ({ code: 'POSTMAN_NOTE', severity: 'warning', message })) });
      return;
    }

    if (body.kind === 'xlsx') {
      if (typeof body.contentBase64 !== 'string' || body.contentBase64.length === 0) { bad(res, 'contentBase64 is required'); return; }
      const paths = stringMap(body.paths, 100);
      if (!paths) { bad(res, 'paths must be an object of sheet name to URL path'); return; }
      let parsed;
      try {
        parsed = parseSheets(await readWorkbook(Buffer.from(body.contentBase64, 'base64')));
      } catch {
        bad(res, 'Could not read that file as an Excel workbook (.xlsx)');
        return;
      }
      if (parsed.apis.length === 0) { bad(res, 'No API sheets were found. Each API sheet needs a "1. Request" section and a FIELD NAME table.'); return; }
      const drafts = parsed.apis.map((a) => ({ key: `xlsx:${a.sheet}`, name: a.sheet, spec: toDraftSpec(a, { path: paths[a.sheet] }) }));
      const created = await importDrafts(req.params.id, userId, drafts);
      sendJson(res, 201, { created, skippedSheets: parsed.skipped, flags: parsed.flags });
      return;
    }

    bad(res, 'kind must be "xlsx", "openapi" or "postman"');
  });

  router.get(`${base}/apis/:aid`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    if (!a) { bad(res, 'API not found', 404); return; }
    const wanted = Number(req.query.get('version') ?? a.latest_version);
    const ver = await repo().getVersion(a.id, wanted);
    if (!ver) { bad(res, 'Version not found', 404); return; }
    const versions = (await repo().listVersions(a.id)).map((v) => ({ version: v.version, status: v.status, createdAt: v.created_at, flags: collectFlags(v.spec).length }));
    sendJson(res, 200, { api: summary(a, ver.spec), version: { version: ver.version, status: ver.status }, spec: ver.spec, flags: collectFlags(ver.spec), versions, rules: await repo().listRules(a.id) });
  });

  router.get(`${base}/apis/:aid/diff`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    if (!a) { bad(res, 'API not found', 404); return; }
    const to = Number(req.query.get('to') ?? a.latest_version);
    const from = Number(req.query.get('from') ?? (a.approved_version > 0 && a.approved_version < to ? a.approved_version : to - 1));
    const [before, after] = await Promise.all([repo().getVersion(a.id, from), repo().getVersion(a.id, to)]);
    if (!before || !after) { bad(res, 'Version not found', 404); return; }
    sendJson(res, 200, { from, to, ...diffSpecs(before.spec, after.spec) });
  });

  router.put(`${base}/apis/:aid`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    if (!a) { bad(res, 'API not found', 404); return; }
    const b = req.body as Record<string, unknown>;
    const fields: Parameters<ReturnType<typeof repo>['updateApi']>[2] = {};
    if (b.name !== undefined) {
      const n = String(b.name).trim();
      if (!n || n.length > 120) { bad(res, 'name must be 1-120 characters'); return; }
      fields.name = n;
    }
    if (b.mode !== undefined) {
      if (!MODES.includes(b.mode as SimMode)) { bad(res, `mode must be one of: ${MODES.join(', ')}`); return; }
      fields.mode = b.mode as SimMode;
    }
    if (b.liveBaseUrl !== undefined) {
      const u = String(b.liveBaseUrl).trim();
      if (u !== '' && !isHttpsUrl(u)) { bad(res, 'liveBaseUrl must be a full https:// address without credentials'); return; }
      fields.live_base_url = u;
    }
    if (b.requireExplicitRule !== undefined) fields.require_explicit_rule = b.requireExplicitRule === true;
    if (b.operationModes !== undefined) {
      const m = b.operationModes as Record<string, unknown>;
      if (!m || typeof m !== 'object' || Array.isArray(m)) { bad(res, 'operationModes must be an object'); return; }
      const clean: Record<string, 'mock' | 'live'> = {};
      for (const [k, v] of Object.entries(m)) {
        if (v !== 'mock' && v !== 'live') { bad(res, 'operationModes values must be "mock" or "live"'); return; }
        clean[k] = v;
      }
      fields.operation_modes = clean;
    }
    const nextMode = fields.mode ?? a.mode;
    const nextUrl = fields.live_base_url ?? a.live_base_url;
    const nextOps = fields.operation_modes ?? a.operation_modes;
    const wantsLive = nextMode === 'live' || (nextMode === 'hybrid' && Object.values(nextOps).includes('live'));
    if (wantsLive && !nextUrl) { bad(res, 'Set liveBaseUrl before using live calls'); return; }
    if (Object.keys(fields).length === 0) { bad(res, 'Nothing to update'); return; }
    const updated = await repo().updateApi(req.params.id, a.id, fields);
    sendJson(res, 200, { api: updated ? summary(updated, await latestSpec(updated)) : null });
  });

  router.delete(`${base}/apis/:aid`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    if (!await repo().deleteApi(req.params.id, req.params.aid)) { bad(res, 'API not found', 404); return; }
    sendJson(res, 200, { ok: true });
  });

  router.put(`${base}/apis/:aid/versions/:v/path`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    const ver = a ? await repo().getVersion(a.id, Number(req.params.v)) : null;
    if (!a || !ver) { bad(res, 'Version not found', 404); return; }
    if (ver.status !== 'draft') { bad(res, 'Only a draft version can be changed. Import a new version instead.', 409); return; }
    const b = req.body as Record<string, unknown>;
    const path = String(b.path ?? '').trim();
    if (!/^\/[A-Za-z0-9\-._~/{}]*$/.test(path) || path.includes('..') || path.length > 200) { bad(res, 'path must start with "/" and use letters, digits and - . _ ~ / { }'); return; }
    const ops = operations(ver.spec);
    const target = b.operationId ? ops.find((o) => o.operationId === b.operationId) : ops.length === 1 ? ops[0] : undefined;
    if (!target) { bad(res, ops.length > 1 ? 'operationId is required: this API has several operations' : 'Operation not found'); return; }
    const spec = structuredClone(ver.spec);
    const op = spec.paths[target.path][target.method]!;
    if (path !== target.path) {
      if (spec.paths[path]?.[target.method]) { bad(res, `${target.method.toUpperCase()} ${path} already exists in this API`, 409); return; }
      delete spec.paths[target.path][target.method];
      if (Object.keys(spec.paths[target.path]).length === 0) delete spec.paths[target.path];
      (spec.paths[path] ??= {})[target.method] = op;
    }
    if (op['x-flags']) {
      op['x-flags'] = op['x-flags'].filter((f) => f.code !== 'MISSING_PATH');
      if (op['x-flags'].length === 0) delete op['x-flags'];
    }
    await repo().updateVersion(a.id, ver.version, { spec });
    sendJson(res, 200, { spec, flags: collectFlags(spec) });
  });

  router.post(`${base}/apis/:aid/versions/:v/approve`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    const ver = a ? await repo().getVersion(a.id, Number(req.params.v)) : null;
    if (!a || !ver) { bad(res, 'Version not found', 404); return; }
    if (hasMissingPath(ver.spec)) { bad(res, 'Enter the URL path for this API before approving it.', 409); return; }

    // Rules for an operation that changed or vanished stay blocked until someone confirms them again.
    const prev = a.approved_version > 0 ? await repo().getVersion(a.id, a.approved_version) : null;
    let flagged = 0;
    if (prev && prev.version !== ver.version) {
      const before = new Map(operations(prev.spec).map((o) => [o.operationId, fingerprint(prev.spec.paths[o.path][o.method])]));
      const after = new Map(operations(ver.spec).map((o) => [o.operationId, fingerprint(ver.spec.paths[o.path][o.method])]));
      for (const rule of await repo().listRules(a.id)) {
        if (rule.needsReview) continue;
        if (before.get(rule.operationId) !== after.get(rule.operationId)) {
          await repo().putRule(a.id, { ...rule, needsReview: true });
          flagged++;
        }
      }
    }
    await repo().updateVersion(a.id, ver.version, { status: 'approved' });
    await repo().updateApi(req.params.id, a.id, { approved_version: ver.version });
    sendJson(res, 200, { approvedVersion: ver.version, rulesNeedingReview: flagged });
  });

  router.get(`${base}/apis/:aid/rules`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    if (!a) { bad(res, 'API not found', 404); return; }
    sendJson(res, 200, { rules: await repo().listRules(a.id) });
  });

  router.put(`${base}/apis/:aid/rules/:rid`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    const spec = a ? await latestSpec(a) : null;
    if (!a || !spec) { bad(res, 'API not found', 404); return; }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.rid)) { bad(res, 'Invalid rule id'); return; }
    const rule = parseRule(req.body as Record<string, unknown>, req.params.rid, new Set(operations(spec).map((o) => o.operationId)));
    if (typeof rule === 'string') { bad(res, rule); return; }
    await repo().putRule(a.id, rule);
    sendJson(res, 200, { rule });
  });

  router.delete(`${base}/apis/:aid/rules/:rid`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    if (!a) { bad(res, 'API not found', 404); return; }
    if (!await repo().deleteRule(a.id, req.params.rid)) { bad(res, 'Rule not found', 404); return; }
    sendJson(res, 200, { ok: true });
  });

  router.post(`${base}/apis/:aid/try`, async (req, res) => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const a = await repo().getApi(req.params.id, req.params.aid);
    if (!a) { bad(res, 'API not found', 404); return; }
    const b = req.body as Record<string, unknown>;
    const ver = await repo().getVersion(a.id, Number(b.version ?? a.latest_version));
    if (!ver) { bad(res, 'Version not found', 404); return; }
    const headers = stringMap(b.headers, 30);
    const query = stringMap(b.query, 30);
    if (!headers || !query) { bad(res, 'headers and query must be objects of strings'); return; }
    const result = handleMockRequest(ver.spec, await repo().listRules(a.id), {
      method: String(b.method ?? 'POST'), path: String(b.path ?? '/'), headers, query, body: b.body,
    }, { requireExplicitRule: a.require_explicit_rule });
    sendJson(res, 200, { result });
  });

  // ── The simulated API ───────────────────────────────────────────────────────
  const hosted = async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    // These routes skip the CSRF guard, so only an API token may use them: a browser session could be driven by another site.
    if (!req.user || !req.authViaToken) { bad(res, 'Call the simulated API with an API token (Authorization: Bearer ...)', 401); return; }
    if (!await requireProjectAccess(req, res, req.params.projectId)) return;
    const a = await repo().getApi(req.params.projectId, req.params.apiId);
    if (!a) { bad(res, 'API not found', 404); return; }
    if (a.approved_version === 0) {
      sendRaw(res, 409, { 'Content-Type': 'application/json', 'x-mock-source': 'blocked' }, JSON.stringify({ error: 'API_NOT_APPROVED', message: 'This API has no approved spec version yet. Approve one in the portal.' }));
      return;
    }
    const ver = await repo().getVersion(a.id, a.approved_version);
    if (!ver) { bad(res, 'Approved version is missing', 500); return; }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = `/api/sim/${encodeURIComponent(req.params.projectId)}/${encodeURIComponent(req.params.apiId)}/call`;
    const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) || '/' : '/';
    const method = req.method ?? 'GET';

    let raw: Buffer;
    try { raw = await readRaw(req, MAX_HOSTED_BODY); } catch { bad(res, 'Request body is larger than 1 MB', 413); return; }
    const ct = String(req.headers['content-type'] ?? '');
    let parsedBody: unknown;
    if (raw.length > 0) {
      if (ct.includes('json')) { try { parsedBody = JSON.parse(raw.toString('utf8')); } catch { bad(res, 'Request body is not valid JSON'); return; } }
      else if (a.mode === 'mock') { bad(res, 'Send a JSON body with Content-Type: application/json'); return; }
    }

    const out = await answerCall(a, ver, await repo().listRules(a.id), {
      method, path: rest, search: url.search, headers: clientHeaders(req.headers), rawBody: raw, body: parsedBody,
    });
    if (out.delayMs > 0) await new Promise((r) => setTimeout(r, Math.min(out.delayMs, MAX_HOSTED_DELAY_MS)));
    console.log(`[api-sim] ${a.project_id}/${a.id} ${method} ${rest} -> ${out.status} ${out.source}${out.ruleId ? ` rule=${out.ruleId}` : ''}${out.warnings ? ` warnings=${out.warnings}` : ''}`);
    sendRaw(res, out.status, out.headers, out.text);
  };
  const hostedPattern = '/api/sim/:projectId/:apiId/call(?:/.*)?';
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) router.rawMethod(m, hostedPattern, hosted);

  registerApiTestRoutes();
  registerApiRunRoutes();
  registerAiRuleRoutes();
  registerSimMcpRoutes();
  registerAiImportRoutes();
}
