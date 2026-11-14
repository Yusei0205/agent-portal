/**
 * Business rules: rules the client's document states in words, held as checks the engine can apply.
 *
 * The AI step proposes them (see ai-rules.ts); nothing here trusts that output. A rule only uses fields that exist in
 * the request body, a short list of tests, and "these fields must then be present". Only confirmed rules are applied.
 */

import type { BusinessRule, Flag, Operation, RuleCondition, Schema } from './types.ts';
import type { ValidationIssue } from './schema.ts';

const OPS = new Set(['equals', 'not_equals', 'in', 'present', 'absent']);
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export interface FieldInfo { path: string; type: string; allowed: string[]; conditional: string; /** The schema already requires it. */ required: boolean }

/** Every field reachable without going through a list, with its type, allowed values and any rule in words. */
export function listFields(schema: Schema | undefined, prefix = '', out: FieldInfo[] = [], depth = 0): FieldInfo[] {
  if (!schema || depth > 6) return out;
  const required = new Set(schema.required ?? []);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.push({ path, type: sub.type ?? 'any', allowed: (sub.enum ?? []).map(String), conditional: sub['x-conditional'] ?? '', required: required.has(name) });
    if (sub.type === 'object') listFields(sub, path, out, depth + 1);
  }
  return out;
}

export function getAtPath(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === '';

export function conditionHolds(c: RuleCondition, body: unknown): boolean {
  const v = getAtPath(body, c.field);
  switch (c.op) {
    case 'present': return !empty(v);
    case 'absent': return empty(v);
    case 'equals': return !empty(v) && String(v) === String(c.value);
    case 'not_equals': return empty(v) || String(v) !== String(c.value);
    case 'in': return !empty(v) && Array.isArray(c.value) && c.value.map(String).includes(String(v));
    default: return false;
  }
}

export function describeCondition(c: RuleCondition): string {
  switch (c.op) {
    case 'present': return `${c.field} is given`;
    case 'absent': return `${c.field} is empty`;
    case 'equals': return `${c.field} = ${String(c.value)}`;
    case 'not_equals': return `${c.field} is not ${String(c.value)}`;
    case 'in': return `${c.field} is one of ${(Array.isArray(c.value) ? c.value : []).join(', ')}`;
    default: return c.field;
  }
}

export function describeRule(r: BusinessRule): string {
  return `${r.requires.join(', ')} required when ${r.when.map(describeCondition).join(' and ')}`;
}

/** The problems a confirmed rule finds in a request body. Unconfirmed rules are ignored. */
export function checkRules(rules: BusinessRule[] | undefined, body: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const r of rules ?? []) {
    if (r.status !== 'confirmed') continue;
    if (!r.when.every((c) => conditionHolds(c, body))) continue;
    for (const f of r.requires) {
      if (empty(getAtPath(body, f))) out.push({ path: `body.${f}`, message: `is required when ${r.when.map(describeCondition).join(' and ')}` });
    }
  }
  return out;
}

// ── Checking what the AI suggests ─────────────────────────────────────────────

export interface RuleCheck { rules: BusinessRule[]; rejected: string[] }

/**
 * Turns the model's answer into rules, keeping only what is well formed and refers to fields that exist. Everything
 * kept is `suggested`: a person confirms it before the engine applies it.
 */
export function sanitizeAiRules(raw: unknown, schema: Schema | undefined, newId: () => string): RuleCheck {
  const rules: BusinessRule[] = [];
  const rejected: string[] = [];
  const known = new Map(listFields(schema).map((f) => [f.path, f]));
  if (!Array.isArray(raw)) return { rules, rejected: ['The model did not return a list of rules.'] };

  raw.slice(0, 40).forEach((item, i) => {
    const at = `Rule ${i + 1}`;
    if (!item || typeof item !== 'object') { rejected.push(`${at}: not an object.`); return; }
    const o = item as Record<string, unknown>;
    const description = typeof o.description === 'string' ? o.description.trim().slice(0, 300) : '';
    if (!description) { rejected.push(`${at}: no description.`); return; }
    if (!Array.isArray(o.when) || o.when.length === 0 || o.when.length > 4) { rejected.push(`${at}: "when" needs 1 to 4 tests.`); return; }
    if (!Array.isArray(o.requires) || o.requires.length === 0 || o.requires.length > 8) { rejected.push(`${at}: "requires" needs 1 to 8 fields.`); return; }

    const when: RuleCondition[] = [];
    for (const c of o.when) {
      const cc = (c ?? {}) as Record<string, unknown>;
      const field = String(cc.field ?? '');
      const op = String(cc.op ?? '');
      if (!PATH_RE.test(field) || !known.has(field)) { rejected.push(`${at}: "${field}" is not a field of the request.`); return; }
      if (!OPS.has(op)) { rejected.push(`${at}: unknown test "${op}".`); return; }
      if (op === 'present' || op === 'absent') { when.push({ field, op } as RuleCondition); continue; }
      if (op === 'in') {
        if (!Array.isArray(cc.value) || cc.value.length === 0 || cc.value.length > 20) { rejected.push(`${at}: "in" needs a list of values.`); return; }
        when.push({ field, op: 'in', value: cc.value.map((x) => String(x).slice(0, 100)) });
      } else {
        if (typeof cc.value !== 'string' && typeof cc.value !== 'number' && typeof cc.value !== 'boolean') { rejected.push(`${at}: "${op}" needs a value.`); return; }
        when.push({ field, op: op as 'equals' | 'not_equals', value: String(cc.value).slice(0, 100) });
      }
    }
    const requires: string[] = [];
    for (const f of o.requires) {
      const field = String(f);
      if (!PATH_RE.test(field) || !known.has(field)) { rejected.push(`${at}: "${field}" is not a field of the request.`); return; }
      requires.push(field);
    }
    rules.push({ id: newId(), description, when, requires, status: 'suggested', source: 'ai' });
  });
  return { rules, rejected };
}

/** Adds suggested rules to an operation and says so in its flags, so the review screen shows them. */
export function attachRules(op: Operation, rules: BusinessRule[]): void {
  op['x-rules'] = [...(op['x-rules'] ?? []), ...rules];
  const flags: Flag[] = op['x-flags'] ?? [];
  for (const r of rules) {
    flags.push({ code: 'AI_RULE', severity: 'warning', message: `AI suggested a check: ${describeRule(r)}. It is not applied until you confirm it.` });
  }
  op['x-flags'] = flags;
}
