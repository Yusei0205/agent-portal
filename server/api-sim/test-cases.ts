/**
 * Test cases from an API specification, with no AI: every case comes from a rule the schema states.
 *
 * Per operation: a valid request; each required field missing; each field with the wrong type; a value outside the
 * allowed list; a value over the length limit; a missing login token; a missing required header. Rules the document
 * only states in words ("mandatory when action = 142") become manual cases that need a person (or the AI step) to turn
 * into exact requests.
 *
 * Each case carries what the case sheet needs (scenario, steps, expected result, request, response) and, when it can be
 * run unattended, the `api_request` step the Tests runner understands.
 */

import type { ApiSpec, HttpMethod, Operation, Schema } from './types.ts';
import { generateValue } from './schema.ts';
import { describeRule, listFields } from './rules.ts';
import type { BusinessRule, RuleCondition } from './types.ts';

export type ApiCaseKind =
  | 'valid' | 'no_token' | 'missing_header' | 'missing_required' | 'wrong_type' | 'invalid_enum' | 'too_long' | 'rule' | 'conditional';

export interface ApiRequestStep {
  kind: 'api_request';
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  expectedStatus: number;
}

export interface ApiCase {
  /** TC-<operation number>.1.<case number>, in the style of the AI-generated sheets. */
  testId: string;
  operationId: string;
  kind: ApiCaseKind;
  category: string;
  scenario: string;
  precondition: string;
  steps: string;
  expectedResult: string;
  remarks: string;
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response: { status: number } | null;
  /** Runnable step; null when a person has to write the exact requests. */
  step: ApiRequestStep | null;
}

export interface GenerateOptions {
  /** Put in front of each path in the case sheet. */
  baseUrl?: string;
  /** What a rejected request is expected to return. The simulation answers 400. */
  rejectionStatus?: number;
  /** Per operation. Cases beyond it are dropped and the summary says so. */
  maxPerOperation?: number;
}

export interface GeneratedApiCases {
  cases: ApiCase[];
  /** Things the cases take for granted, for a person to confirm. */
  assumptions: string[];
}

interface FieldRef { path: Array<string | number>; name: string; schema: Schema; required: boolean }

const MAX_REQUEST_CHARS = 19_000;

function fieldsOf(schema: Schema | undefined, path: Array<string | number> = [], out: FieldRef[] = [], depth = 0): FieldRef[] {
  if (!schema || depth > 6) return out;
  const required = new Set(schema.required ?? []);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    const here = [...path, name];
    out.push({ path: here, name, schema: sub, required: required.has(name) });
    if (sub.type === 'object') fieldsOf(sub, here, out, depth + 1);
    else if (sub.type === 'array' && sub.items?.type === 'object') fieldsOf(sub.items, [...here, 0], out, depth + 1);
  }
  return out;
}

function pathLabel(path: Array<string | number>): string {
  return path.map((p) => (typeof p === 'number' ? '[]' : `.${p}`)).join('').replace(/^\./, '');
}

function getParent(root: unknown, path: Array<string | number>): Record<string | number, unknown> | null {
  let cur: unknown = root;
  for (const k of path.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur !== null && typeof cur === 'object' ? (cur as Record<string | number, unknown>) : null;
}

function mutate(body: unknown, path: Array<string | number>, change: { remove: true } | { set: unknown }): unknown {
  const copy = structuredClone(body);
  const parent = getParent(copy, path);
  const last = path[path.length - 1];
  if (!parent) return copy;
  if ('remove' in change) delete parent[last];
  else parent[last] = change.set;
  return copy;
}

function wrongValueFor(s: Schema): unknown {
  switch (s.type) {
    case 'string': return 12345;
    case 'number':
    case 'integer': return 'not-a-number';
    case 'boolean': return 'yes';
    default: return 'not-an-object';
  }
}

function trimRequest(r: ApiCase['request']): ApiCase['request'] {
  if (JSON.stringify(r).length <= MAX_REQUEST_CHARS) return r;
  const { body: _b, ...rest } = r;
  return rest;
}

/** A value of the field's own type for a rule's text value (rules keep values as text). */
function typed(type: string, v: string): unknown {
  if ((type === 'integer' || type === 'number') && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (type === 'boolean') return v === 'true';
  return v;
}

/** A value for the field that is neither of `avoid`: another allowed value if there is one. */
function otherValue(allowed: string[], avoid: string[]): string {
  return allowed.find((a) => !avoid.includes(a)) ?? (avoid.includes('other-value') ? 'other-value-2' : 'other-value');
}

/** Makes `c` hold (satisfy) or fail (!satisfy) in a copy of the body. */
function shapeCondition(body: unknown, c: RuleCondition, satisfy: boolean, info: Map<string, { type: string; allowed: string[] }>): unknown {
  const path = c.field.split('.');
  const f = info.get(c.field) ?? { type: 'string', allowed: [] };
  const set = (v: unknown): unknown => mutate(body, path, { set: v });
  const values = c.op === 'in' ? (Array.isArray(c.value) ? c.value : []) : [String(c.value ?? '')];
  switch (c.op) {
    case 'present': return satisfy ? body : mutate(body, path, { remove: true });
    case 'absent': return satisfy ? mutate(body, path, { remove: true }) : set(typed(f.type, 'sample-value'));
    case 'equals': return set(typed(f.type, satisfy ? values[0] : otherValue(f.allowed, values)));
    case 'in': return set(typed(f.type, satisfy ? values[0] : otherValue(f.allowed, values)));
    case 'not_equals': return set(typed(f.type, satisfy ? otherValue(f.allowed, values) : values[0]));
    default: return body;
  }
}

function ruleCases(rule: BusinessRule, validBody: unknown, bodySchema: Schema | undefined): Array<{ scenario: string; expected: 'ok' | 'rejected'; body: unknown; change: string }> {
  const fieldInfo = new Map(listFields(bodySchema).map((f) => [f.path, f]));
  const info = new Map([...fieldInfo].map(([k, f]) => [k, { type: f.type, allowed: f.allowed }]));
  // A field the schema already requires says nothing new about this rule, and cannot be left out when the condition fails.
  const ruleOnly = rule.requires.filter((f) => !fieldInfo.get(f)?.required);
  let holds = validBody;
  for (const c of rule.when) holds = shapeCondition(holds, c, true, info);
  const out: Array<{ scenario: string; expected: 'ok' | 'rejected'; body: unknown; change: string }> = [];
  const label = describeRule(rule);
  out.push({ scenario: `Rule "${label}": request that meets the condition and gives the field is accepted`, expected: 'ok', body: holds, change: 'condition met, required fields given' });
  for (const f of ruleOnly) {
    out.push({ scenario: `Rule "${label}": "${f}" missing when the condition is met`, expected: 'rejected', body: mutate(holds, f.split('.'), { remove: true }), change: `condition met, ${f} removed` });
  }
  if (ruleOnly.length > 0) {
    const broken = shapeCondition(validBody, rule.when[0], false, info);
    out.push({ scenario: `Rule "${label}": "${ruleOnly[0]}" may be missing when the condition is not met`, expected: 'ok', body: mutate(broken, ruleOnly[0].split('.'), { remove: true }), change: `condition not met, ${ruleOnly[0]} removed` });
  }
  return out;
}

export function generateApiCases(spec: ApiSpec, opts: GenerateOptions = {}): GeneratedApiCases {
  const rejection = opts.rejectionStatus ?? 400;
  const cap = opts.maxPerOperation ?? 60;
  const base = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const cases: ApiCase[] = [];
  const assumptions: string[] = [];
  let opIndex = 0;

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [methodKey, op] of Object.entries(item) as Array<[HttpMethod, Operation | undefined]>) {
      if (!op) continue;
      opIndex++;
      const method = methodKey.toUpperCase();
      const label = op.summary || op.operationId;
      const category = `${label} (${method} ${path})`;
      const bodySchema = op.requestBody?.content['application/json']?.schema;
      const validBody = bodySchema ? generateValue(bodySchema) : undefined;
      const okCode = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c)).sort()[0] ?? '200';
      const secured = Array.isArray(op.security) && op.security.length > 0;
      const headerParams = (op.parameters ?? []).filter((p) => p.in === 'header');

      const goodHeaders: Record<string, string> = {};
      if (secured) goodHeaders.Authorization = 'Bearer test-token';
      for (const h of headerParams) if (h.required) goodHeaders[h.name] = 'sample';

      if (op['x-flags']?.some((f) => f.code === 'MISSING_PATH')) {
        assumptions.push(`${label} has no URL path in the document. "${path}" is a placeholder; change it before running the tests.`);
      }

      const local: ApiCase[] = [];
      const add = (kind: ApiCaseKind, scenario: string, expected: string, change: string, headers: Record<string, string>, body: unknown, status: number | null, remarks = ''): void => {
        const request = trimRequest({ method, url: `${base}${path}`, headers, ...(body !== undefined ? { body } : {}) });
        const steps = [
          `1. Send ${method} ${base}${path}`,
          ...(Object.keys(headers).length ? [`2. Headers: ${Object.keys(headers).join(', ')}`] : []),
          ...(body !== undefined ? [`${Object.keys(headers).length ? 3 : 2}. Body: ${change}`] : []),
        ].join('\n');
        local.push({
          testId: '', operationId: op.operationId, kind, category, scenario, precondition: secured ? 'A valid login token is available.' : '',
          steps, expectedResult: expected, remarks, request,
          response: status === null ? null : { status },
          step: status === null ? null : {
            kind: 'api_request', method, path, headers, ...(body !== undefined ? { body } : {}), expectedStatus: status,
          },
        });
      };

      // 1. The request that should work.
      add('valid', `Valid request is accepted`, `HTTP ${okCode}. The response has the fields the specification lists.`,
        'every field filled with a valid value', goodHeaders, validBody, Number(okCode),
        'Only the status is checked automatically; the response fields are not compared yet.');

      // 2. Authentication and headers.
      if (secured) {
        const { Authorization: _a, ...noAuth } = goodHeaders;
        add('no_token', 'Request without a login token is refused', 'HTTP 401. No data is returned.', 'valid body, no Authorization header', noAuth, validBody, 401);
      }
      for (const h of headerParams.filter((x) => x.required)) {
        const { [h.name]: _h, ...rest } = goodHeaders;
        add('missing_header', `Required header "${h.name}" missing`, `HTTP ${rejection}. The error names the header.`, `valid body, no ${h.name} header`, rest, validBody, rejection);
      }

      // 3. Field rules, from the request body schema.
      const refs = fieldsOf(bodySchema);
      for (const f of refs.filter((x) => x.required)) {
        add('missing_required', `Required field "${pathLabel(f.path)}" missing`, `HTTP ${rejection}. The error names the field.`,
          `valid body without ${pathLabel(f.path)}`, goodHeaders, mutate(validBody, f.path, { remove: true }), rejection);
      }
      for (const f of refs) {
        add('wrong_type', `Field "${pathLabel(f.path)}" has the wrong type`, `HTTP ${rejection}. The error names the field.`,
          `valid body with ${pathLabel(f.path)} set to a ${typeof wrongValueFor(f.schema)}`, goodHeaders, mutate(validBody, f.path, { set: wrongValueFor(f.schema) }), rejection);
      }
      for (const f of refs.filter((x) => x.schema.enum?.length)) {
        add('invalid_enum', `Field "${pathLabel(f.path)}" has a value that is not allowed`,
          `HTTP ${rejection}. Allowed values: ${f.schema.enum!.join(', ')}.`, `valid body with ${pathLabel(f.path)} = "__invalid__"`,
          goodHeaders, mutate(validBody, f.path, { set: '__invalid__' }), rejection);
      }
      for (const f of refs.filter((x) => x.schema.type === 'string' && x.schema.maxLength !== undefined && x.schema.maxLength <= 1000 && !x.schema.enum)) {
        add('too_long', `Field "${pathLabel(f.path)}" is longer than ${f.schema.maxLength} characters`, `HTTP ${rejection}. The error names the field.`,
          `valid body with ${pathLabel(f.path)} of ${f.schema.maxLength! + 1} characters`, goodHeaders,
          mutate(validBody, f.path, { set: 'x'.repeat(f.schema.maxLength! + 1) }), rejection);
      }

      // 4. Rules the document only states in words.
      const confirmed = (op['x-rules'] ?? []).filter((r) => r.status === 'confirmed');
      const covered = new Set(confirmed.flatMap((r) => r.requires));
      for (const rule of confirmed) {
        for (const rc of ruleCases(rule, validBody, bodySchema)) {
          add('rule', rc.scenario, rc.expected === 'ok' ? `HTTP ${okCode}.` : `HTTP ${rejection}. The error names the field.`, rc.change,
            goodHeaders, rc.body, rc.expected === 'ok' ? Number(okCode) : rejection,
            'Made from a rule the document states in words, as confirmed on the API simulation tab.');
        }
      }
      for (const f of refs.filter((x) => x.schema['x-conditional'] && !covered.has(pathLabel(x.path)))) {
        const rule = String(f.schema['x-conditional']).split('\n')[0].slice(0, 300);
        add('conditional', `Conditional rule for "${pathLabel(f.path)}": ${rule}`,
          `The API applies this rule: ${rule}`, 'one request that meets the condition and one that breaks it',
          goodHeaders, mutate(validBody, f.path, { remove: true }), null,
          'Not run automatically. The document states this rule in words, so the exact requests and the expected answers need to be written (or generated with AI).');
      }

      if (local.length > cap) {
        assumptions.push(`${label}: ${local.length - cap} further cases were left out (limit ${cap} per operation).`);
        // Keep the order above: the valid and rule cases first, the long tail of field cases cut.
        local.length = cap;
      }
      local.forEach((c, i) => { c.testId = `TC-${opIndex}.1.${i + 1}`; });
      cases.push(...local);
    }
  }

  if (cases.some((c) => c.step && c.expectedResult.startsWith(`HTTP ${rejection}`))) {
    assumptions.push(`A rejected request is expected to return HTTP ${rejection}, as the simulation does. The client's real API may report errors differently (for example HTTP 200 with an error code), so check this before running the cases against it.`);
  }
  assumptions.push('A successful request is checked only by its status code; response fields are not compared.');
  return { cases, assumptions };
}
