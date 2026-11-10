/**
 * The mock engine: one request in, one simulated response out. Pure and synchronous, with no I/O, so the hosted REST
 * endpoint and the MCP facade can share it and tests can run it directly.
 *
 * The block rule: a request that has no matching operation, or whose rule needs review, gets an explicit 501 and is
 * never answered with a guess. The engine itself makes no outbound call, so nothing can fall through to the real API.
 */

import type { ApiSpec, Flag, HttpMethod, MockRequest, MockResult, MockRule, Operation } from './types.ts';
import { generateValue, validateValue } from './schema.ts';
import { checkRules } from './rules.ts';

export interface EngineOptions {
  /** When true, an operation with no matching rule is blocked instead of answered from its response schema. */
  requireExplicitRule?: boolean;
}

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const JSON_HEADERS = { 'content-type': 'application/json' };

interface Located { operation: Operation; template: string; exact: boolean }

function templateToRegex(template: string): RegExp {
  const src = template
    .split('/')
    .map((seg) => (/^\{[^}]+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${src}/?$`);
}

function normalisePath(p: string): string {
  const q = p.indexOf('?');
  const base = q >= 0 ? p.slice(0, q) : p;
  return base.startsWith('/') ? base : `/${base}`;
}

/** Finds the operation for a request. A literal path beats a templated one. */
export function locateOperation(spec: ApiSpec, method: string, path: string): Located | null {
  const m = method.toLowerCase() as HttpMethod;
  if (!METHODS.includes(m)) return null;
  const target = normalisePath(path);
  let templated: Located | null = null;
  for (const [template, item] of Object.entries(spec.paths)) {
    const op = item[m];
    if (!op) continue;
    if (template === target) return { operation: op, template, exact: true };
    if (!templated && templateToRegex(template).test(target)) templated = { operation: op, template, exact: false };
  }
  return templated;
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function ruleMatches(rule: MockRule, req: MockRequest): boolean {
  const w = rule.when;
  if (!w) return true;
  for (const [k, v] of Object.entries(w.body ?? {})) {
    if (JSON.stringify(getPath(req.body, k)) !== JSON.stringify(v)) return false;
  }
  for (const [k, v] of Object.entries(w.query ?? {})) {
    if (req.query?.[k] !== v) return false;
  }
  return true;
}

function blocked(code: string, message: string, extra: Partial<MockResult> = {}): MockResult {
  return {
    status: 501,
    headers: { ...JSON_HEADERS, 'x-mock-source': 'blocked' },
    body: { error: code, message },
    delayMs: 0,
    source: 'blocked',
    warnings: [],
    ...extra,
  };
}

function lowerHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

function successResponse(op: Operation): { status: number; schemaBody: unknown } {
  const codes = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c)).sort();
  const code = codes[0] ?? '200';
  const media = op.responses[code]?.content?.['application/json'];
  if (!media) return { status: Number(code), schemaBody: undefined };
  return { status: Number(code), schemaBody: media.example !== undefined ? media.example : generateValue(media.schema) };
}

export function handleMockRequest(spec: ApiSpec, rules: MockRule[], req: MockRequest, opts: EngineOptions = {}): MockResult {
  const found = locateOperation(spec, req.method, req.path);
  if (!found) {
    return blocked('NO_MOCK_RULE', `No mock rule for ${req.method.toUpperCase()} ${normalisePath(req.path)}. Add the operation to the spec, or switch it to live.`);
  }
  const { operation } = found;
  const opId = operation.operationId;
  const headers = lowerHeaders(req.headers);
  const warnings: Flag[] = [];

  const invalid = (errors: Array<{ path: string; message: string }>): MockResult => ({
    status: 400,
    headers: { ...JSON_HEADERS, 'x-mock-source': 'invalid' },
    body: { error: 'INVALID_REQUEST', message: 'The request does not match the API specification.', errors },
    delayMs: 0,
    source: 'invalid',
    operationId: opId,
    warnings,
  });

  if (operation.security && operation.security.length > 0 && !headers['authorization']) {
    return {
      status: 401,
      headers: { ...JSON_HEADERS, 'x-mock-source': 'invalid' },
      body: { error: 'UNAUTHENTICATED', message: 'This operation needs an Authorization header.' },
      delayMs: 0, source: 'invalid', operationId: opId, warnings,
    };
  }

  const errors: Array<{ path: string; message: string }> = [];
  for (const p of operation.parameters ?? []) {
    if (p.in === 'header') {
      const v = headers[p.name.toLowerCase()];
      if (v === undefined) { if (p.required) errors.push({ path: `header.${p.name}`, message: 'is required' }); continue; }
    } else if (p.in === 'query') {
      const v = req.query?.[p.name];
      if (v === undefined) { if (p.required) errors.push({ path: `query.${p.name}`, message: 'is required' }); }
    }
  }

  const bodySpec = operation.requestBody?.content['application/json']?.schema;
  if (bodySpec) {
    if (req.body === undefined || req.body === null) {
      if (operation.requestBody?.required) errors.push({ path: '$', message: 'a JSON body is required' });
    } else {
      const v = validateValue(req.body, bodySpec, 'body');
      errors.push(...v.errors);
      // Rules the document states in words, once a person has confirmed them. The field itself may then no longer
      // need its "may be required" warning.
      const ruleErrors = checkRules(operation['x-rules'], req.body);
      errors.push(...ruleErrors);
      const covered = new Set((operation['x-rules'] ?? []).filter((r) => r.status === 'confirmed').flatMap((r) => r.requires.map((f) => `body.${f}`)));
      warnings.push(...v.warnings.filter((w) => !(w.at && covered.has(w.at))));
    }
  }
  if (errors.length > 0) return invalid(errors);

  const opRules = rules.filter((r) => r.operationId === opId);
  const rule = opRules.find((r) => ruleMatches(r, req));

  if (rule?.needsReview) {
    return blocked('MOCK_RULE_NEEDS_REVIEW', `The mock rule "${rule.name}" for ${opId} is waiting for review after a spec change.`, { operationId: opId, ruleId: rule.id, warnings });
  }

  if (rule?.failure) return failureResult(rule, opId, warnings);

  if (rule?.response) {
    const body = rule.response.body;
    return {
      status: rule.response.status,
      headers: { ...JSON_HEADERS, ...rule.response.headers, 'x-mock-source': 'rule' },
      body,
      delayMs: rule.delayMs ?? 0,
      source: 'rule',
      operationId: opId,
      ruleId: rule.id,
      warnings,
    };
  }

  if (opts.requireExplicitRule) {
    return blocked('NO_MOCK_RULE', `No mock rule matches ${req.method.toUpperCase()} ${normalisePath(req.path)} (${opId}).`, { operationId: opId, warnings });
  }

  const ok = successResponse(operation);
  return {
    status: ok.status,
    headers: { ...JSON_HEADERS, 'x-mock-source': 'generated' },
    body: ok.schemaBody,
    delayMs: rule?.delayMs ?? 0,
    source: 'generated',
    operationId: opId,
    warnings,
  };
}

function failureResult(rule: MockRule, operationId: string, warnings: Flag[]): MockResult {
  const base = { source: 'failure' as const, operationId, ruleId: rule.id, warnings };
  switch (rule.failure) {
    case 'timeout':
      return { ...base, status: 504, headers: { ...JSON_HEADERS, 'x-mock-source': 'failure' }, body: { error: 'GATEWAY_TIMEOUT' }, delayMs: rule.delayMs ?? 30_000 };
    case 'rate_limited':
      return { ...base, status: 429, headers: { ...JSON_HEADERS, 'retry-after': '1', 'x-mock-source': 'failure' }, body: { error: 'TOO_MANY_REQUESTS' }, delayMs: rule.delayMs ?? 0 };
    case 'malformed':
      return { ...base, status: 200, headers: { ...JSON_HEADERS, 'x-mock-source': 'failure' }, body: '{"truncated":', delayMs: rule.delayMs ?? 0 };
    case 'server_error':
    default:
      return { ...base, status: 500, headers: { ...JSON_HEADERS, 'x-mock-source': 'failure' }, body: { error: 'INTERNAL_SERVER_ERROR' }, delayMs: rule.delayMs ?? 0 };
  }
}
