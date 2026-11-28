/**
 * Validating a value against a Schema, and making a plausible value from one.
 *
 * Hard problems (wrong type, missing required field, value not in the enum, too long) are `errors`.
 * Conditional rules (`x-conditional`) are `warnings`: the text is surfaced, never enforced.
 */

import type { Flag, Schema } from './types.ts';

export interface ValidationIssue { path: string; message: string }
export interface ValidationResult { errors: ValidationIssue[]; warnings: Flag[] }

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function validateValue(value: unknown, schema: Schema, at = ''): ValidationResult {
  const out: ValidationResult = { errors: [], warnings: [] };
  walk(value, schema, at || '$', out, true);
  return out;
}

function walk(value: unknown, schema: Schema, at: string, out: ValidationResult, present: boolean): void {
  if (!present) return;
  const t = typeOf(value);
  const fail = (message: string): void => { out.errors.push({ path: at, message }); };

  switch (schema.type) {
    case 'string':
      if (t !== 'string') { fail(`must be a string, got ${t}`); return; }
      if (schema.maxLength !== undefined && (value as string).length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
      if (schema.minLength !== undefined && (value as string).length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
      break;
    case 'number':
      if (t !== 'number' || !Number.isFinite(value)) { fail(`must be a number, got ${t}`); return; }
      break;
    case 'integer':
      if (t !== 'number' || !Number.isInteger(value)) { fail(`must be an integer, got ${t === 'number' ? 'a decimal' : t}`); return; }
      break;
    case 'boolean':
      if (t !== 'boolean') { fail(`must be true or false, got ${t}`); return; }
      break;
    case 'array': {
      if (t !== 'array') { fail(`must be an array, got ${t}`); return; }
      const items = schema.items;
      if (items) (value as unknown[]).forEach((v, i) => walk(v, items, `${at}[${i}]`, out, true));
      return;
    }
    case 'object': {
      if (t !== 'object') { fail(`must be an object, got ${t}`); return; }
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const name of schema.required ?? []) {
        if (obj[name] === undefined || obj[name] === null) out.errors.push({ path: `${at}.${name}`, message: 'is required' });
      }
      for (const [name, sub] of Object.entries(props)) {
        const v = obj[name];
        if (sub['x-conditional'] && (v === undefined || v === null || v === '')) {
          out.warnings.push({ code: 'CONDITIONAL_RULE', severity: 'warning', at: `${at}.${name}`, message: `${name} may be required: ${sub['x-conditional']}` });
        }
        if (v !== undefined && v !== null) walk(v, sub, `${at}.${name}`, out, true);
      }
      return;
    }
    default:
      break; // no declared type: accept anything
  }

  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    fail(`must be one of: ${schema.enum.join(', ')}`);
  }
}

// ── Generating a value ────────────────────────────────────────────────────────

const MAX_DEPTH = 8;

/** A deterministic, plausible value: the example, else the first enum value, else something typed from the name. */
export function generateValue(schema: Schema, name = 'value', depth = 0): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (depth > MAX_DEPTH) return null;

  switch (schema.type) {
    case 'integer': return 1;
    case 'number': return 1;
    case 'boolean': return true;
    case 'array': return schema.items ? [generateValue(schema.items, name, depth + 1)] : [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) out[k] = generateValue(sub, k, depth + 1);
      return out;
    }
    case 'string':
    default: {
      let s = stringFor(name, schema.format);
      if (schema.maxLength !== undefined && s.length > schema.maxLength) s = s.slice(0, schema.maxLength);
      return s;
    }
  }
}

function stringFor(name: string, format?: string): string {
  const n = name.toLowerCase();
  if (format === 'date-time' || /(date|time|at)$/.test(n)) return '2026-01-01T00:00:00Z';
  if (format === 'date') return '2026-01-01';
  if (format === 'email' || n.includes('email')) return 'user@example.com';
  if (n.endsWith('uuid') || n.endsWith('id')) return '00000000-0000-4000-8000-000000000001';
  if (n === 'token' || n.endsWith('token')) return 'mock-token';
  return `sample-${name}`;
}
