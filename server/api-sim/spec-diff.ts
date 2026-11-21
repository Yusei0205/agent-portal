/**
 * What changed between two versions of a specification, in words a person can check against the client's new document.
 * Operations are matched by operationId, so a path that moved is reported as a change, not as one removed and one added.
 */

import type { ApiSpec, HttpMethod, Operation, Schema } from './types.ts';

export interface OperationChange {
  operationId: string;
  label: string;
  kind: 'added' | 'removed' | 'changed';
  details: string[];
}

export interface SpecDiff {
  changes: OperationChange[];
  /** Total number of individual differences, for a badge. */
  count: number;
}

interface FieldSummary { type: string; required: boolean; allowed: string; maxLength: string; conditional: string }

function fieldsOf(schema: Schema | undefined, prefix = '', out = new Map<string, FieldSummary>(), depth = 0): Map<string, FieldSummary> {
  if (!schema || depth > 8) return out;
  const required = new Set(schema.required ?? []);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    const inner = sub.type === 'array' ? sub.items : sub;
    out.set(path, {
      type: sub.type === 'array' ? `list of ${sub.items?.type ?? 'values'}` : (sub.type ?? 'any'),
      required: required.has(name),
      allowed: (sub.enum ?? []).map(String).join(','),
      maxLength: sub.maxLength !== undefined ? String(sub.maxLength) : '',
      conditional: sub['x-conditional'] ? 'rule in words' : '',
    });
    if (inner?.type === 'object') fieldsOf(inner, path, out, depth + 1);
  }
  return out;
}

function compareFields(where: string, before: Schema | undefined, after: Schema | undefined): string[] {
  const a = fieldsOf(before);
  const b = fieldsOf(after);
  const out: string[] = [];
  for (const [path, f] of b) if (!a.has(path)) out.push(`${where}: field "${path}" added (${f.type}${f.required ? ', required' : ''})`);
  for (const path of a.keys()) if (!b.has(path)) out.push(`${where}: field "${path}" removed`);
  for (const [path, nf] of b) {
    const of = a.get(path);
    if (!of) continue;
    if (of.type !== nf.type) out.push(`${where}: "${path}" changed type from ${of.type} to ${nf.type}`);
    if (of.required !== nf.required) out.push(`${where}: "${path}" is now ${nf.required ? 'required' : 'optional'}`);
    if (of.allowed !== nf.allowed) out.push(`${where}: allowed values of "${path}" changed (${of.allowed || 'any'} → ${nf.allowed || 'any'})`);
    if (of.maxLength !== nf.maxLength) out.push(`${where}: length limit of "${path}" changed (${of.maxLength || 'none'} → ${nf.maxLength || 'none'})`);
    if (of.conditional !== nf.conditional) out.push(`${where}: the rule in words for "${path}" ${nf.conditional ? 'was added' : 'was removed'}`);
  }
  return out;
}

function index(spec: ApiSpec): Map<string, { path: string; method: HttpMethod; op: Operation }> {
  const out = new Map<string, { path: string; method: HttpMethod; op: Operation }>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item) as Array<[HttpMethod, Operation | undefined]>) {
      if (op) out.set(op.operationId, { path, method, op });
    }
  }
  return out;
}

const responseSchema = (op: Operation): Schema | undefined =>
  op.responses['200']?.content?.['application/json']?.schema ?? Object.values(op.responses)[0]?.content?.['application/json']?.schema;

export function diffSpecs(before: ApiSpec, after: ApiSpec): SpecDiff {
  const a = index(before);
  const b = index(after);
  const changes: OperationChange[] = [];

  for (const [id, n] of b) {
    if (!a.has(id)) changes.push({ operationId: id, label: `${n.method.toUpperCase()} ${n.path}`, kind: 'added', details: ['New operation'] });
  }
  for (const [id, o] of a) {
    if (!b.has(id)) changes.push({ operationId: id, label: `${o.method.toUpperCase()} ${o.path}`, kind: 'removed', details: ['Operation removed'] });
  }
  for (const [id, o] of a) {
    const n = b.get(id);
    if (!n) continue;
    const details: string[] = [];
    if (o.path !== n.path) details.push(`URL path changed from ${o.path} to ${n.path}`);
    if (o.method !== n.method) details.push(`method changed from ${o.method.toUpperCase()} to ${n.method.toUpperCase()}`);
    if (Boolean(o.op.security?.length) !== Boolean(n.op.security?.length)) details.push(n.op.security?.length ? 'now needs a login token' : 'no longer needs a login token');
    const hp = (op: Operation) => new Map((op.parameters ?? []).map((p) => [`${p.in}:${p.name}`, Boolean(p.required)]));
    const ha = hp(o.op);
    const hb = hp(n.op);
    const label = (k: string): string => `${k.split(':')[0]} "${k.split(':')[1]}"`;
    for (const [k, req] of hb) if (!ha.has(k)) details.push(`${label(k)} added${req ? ' (required)' : ''}`);
    for (const k of ha.keys()) if (!hb.has(k)) details.push(`${label(k)} removed`);
    for (const [k, req] of hb) if (ha.has(k) && ha.get(k) !== req) details.push(`${label(k)} is now ${req ? 'required' : 'optional'}`);
    details.push(...compareFields('Request', o.op.requestBody?.content['application/json']?.schema, n.op.requestBody?.content['application/json']?.schema));
    details.push(...compareFields('Response', responseSchema(o.op), responseSchema(n.op)));
    const ra = (o.op['x-rules'] ?? []).filter((r) => r.status === 'confirmed').length;
    const rb = (n.op['x-rules'] ?? []).filter((r) => r.status === 'confirmed').length;
    if (ra !== rb) details.push(`applied checks for rules in words: ${ra} → ${rb}`);
    if (details.length > 0) changes.push({ operationId: id, label: `${n.method.toUpperCase()} ${n.path}`, kind: 'changed', details });
  }
  return { changes, count: changes.reduce((n, c) => n + c.details.length, 0) };
}
