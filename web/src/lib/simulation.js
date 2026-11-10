// Helpers for the API simulation pages (pure functions, no React).

/** What each mode means, in words a person picks from. */
export const MODES = [
  { id: 'mock', label: 'Simulated', help: 'Every call is answered by the simulation. Nothing reaches the client’s server.' },
  { id: 'hybrid', label: 'Mixed', help: 'Operations you mark Live go to the client’s server; the rest stay simulated.' },
  { id: 'live', label: 'Live', help: 'Every call is forwarded to the client’s real API.' },
];

export const FAILURES = [
  { id: '', label: 'No failure' },
  { id: 'server_error', label: 'Server error (500)' },
  { id: 'rate_limited', label: 'Too many requests (429)' },
  { id: 'timeout', label: 'Timeout (504)' },
  { id: 'malformed', label: 'Broken response body' },
];

/** A plausible value for a schema, so "Fill example" gives a request that passes validation. */
export function sampleFromSchema(schema, name = 'value', depth = 0) {
  if (!schema || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case 'integer':
    case 'number': return 1;
    case 'boolean': return true;
    case 'array': return schema.items ? [sampleFromSchema(schema.items, name, depth + 1)] : [];
    case 'object': {
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties || {})) out[k] = sampleFromSchema(sub, k, depth + 1);
      return out;
    }
    default: {
      const n = String(name).toLowerCase();
      let s = `sample-${name}`;
      if (schema.format === 'date-time' || /(date|time|at)$/.test(n)) s = '2026-01-01T00:00:00Z';
      else if (schema.format === 'date') s = '2026-01-01';
      else if (n.includes('email')) s = 'user@example.com';
      else if (n.endsWith('id') || n.endsWith('uuid')) s = '00000000-0000-4000-8000-000000000001';
      return schema.maxLength && s.length > schema.maxLength ? s.slice(0, schema.maxLength) : s;
    }
  }
}

/** A schema as flat table rows: one per field, indented by depth. Lists show their item fields underneath. */
export function flattenSchema(schema, depth = 0, out = []) {
  if (!schema) return out;
  const required = new Set(schema.required || []);
  for (const [name, sub] of Object.entries(schema.properties || {})) {
    const isList = sub.type === 'array';
    const item = isList ? sub.items : null;
    const inner = isList ? item : sub;
    const kind = isList ? `list of ${item?.type || 'values'}` : (sub.type || 'any');
    out.push({
      depth,
      name,
      type: kind,
      required: required.has(name),
      conditional: sub['x-conditional'] || '',
      allowed: Array.isArray(sub.enum) ? sub.enum.map(String) : [],
      allowedNotes: sub['x-enum-descriptions'] || {},
      maxLength: sub.maxLength ?? null,
      description: sub.description || '',
    });
    if (inner && inner.type === 'object') flattenSchema(inner, depth + 1, out);
  }
  return out;
}

export function operationsOf(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec?.paths || {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!op) continue;
      out.push({
        path,
        method: method.toUpperCase(),
        operationId: op.operationId,
        summary: op.summary || '',
        secured: Array.isArray(op.security) && op.security.length > 0,
        headers: (op.parameters || []).filter((p) => p.in === 'header'),
        query: (op.parameters || []).filter((p) => p.in === 'query'),
        flags: op['x-flags'] || [],
        rules: op['x-rules'] || [],
        requestSchema: op.requestBody?.content?.['application/json']?.schema || null,
        responseSchema: op.responses?.['200']?.content?.['application/json']?.schema
          || Object.values(op.responses || {})[0]?.content?.['application/json']?.schema || null,
      });
    }
  }
  return out;
}

/** Where a caller reaches the simulated API for a spec path. */
export function simulatedUrl(origin, projectId, apiId, path) {
  return `${origin}/api/sim/${encodeURIComponent(projectId)}/${encodeURIComponent(apiId)}/call${path}`;
}

/** Parses a JSON text box. Empty text means "nothing". */
export function parseJsonField(text, label) {
  const t = String(text ?? '').trim();
  if (t === '') return { value: undefined };
  try { return { value: JSON.parse(t) }; } catch (e) { return { error: `${label} is not valid JSON (${e.message})` }; }
}

export function ruleCondition(rule) {
  const body = rule.when?.body || {};
  const parts = Object.entries(body).map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? `When ${parts.join(' and ')}` : 'Any request';
}

export function ruleOutcome(rule) {
  if (rule.failure) return FAILURES.find((f) => f.id === rule.failure)?.label || rule.failure;
  return rule.response ? `Reply ${rule.response.status}` : 'No reply set';
}

export function newRuleId(name) {
  const base = String(name || 'rule').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rule';
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Words for a rule's tests, for people. */
export function describeCondition(c) {
  switch (c.op) {
    case 'present': return `${c.field} is given`;
    case 'absent': return `${c.field} is empty`;
    case 'equals': return `${c.field} = ${c.value}`;
    case 'not_equals': return `${c.field} is not ${c.value}`;
    case 'in': return `${c.field} is one of ${(c.value || []).join(', ')}`;
    default: return c.field;
  }
}

export function describeRule(r) {
  return `${r.requires.join(', ')} required when ${r.when.map(describeCondition).join(' and ')}`;
}
