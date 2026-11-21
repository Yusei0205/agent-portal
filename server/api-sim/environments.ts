/**
 * Environments of a simulated API (dev, UAT, prod ...): each has a base URL, variables and login headers.
 *
 * The client's real API has a different address and login in each environment. The portal keeps the whole set encrypted
 * (the same way as the live login, see live-credentials.ts) and never sends secret values to a browser. The active
 * environment is what the live calls use: switching it sets the API's live address and login, so the code that makes live
 * calls does not change. A base URL, and the value of a header, can name variables as {{name}}.
 *
 * Environments are read from files people already have: a Postman environment, a Postman collection (its variables), an
 * OpenAPI or Swagger file (its servers), or a .env file.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { decrypt, encrypt } from '../secrets.ts';
import { buildLiveHeaders } from './live-credentials.ts';

export interface EnvVariable { key: string; value: string; secret: boolean }
export interface EnvHeader { name: string; value: string }
export interface SimEnvironment { id: string; name: string; baseUrl: string; variables: EnvVariable[]; headers: EnvHeader[] }
export interface EnvironmentState { active: string; environments: SimEnvironment[] }

export const MAX_ENVIRONMENTS = 10;
export const MAX_VARIABLES = 100;
const MAX_HEADERS = 5;
const MAX_VALUE = 4000;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
// Names that usually hold a secret: anything ending in "key" (apiKey, consumerKey), tokens, passwords, secrets.
const SECRET_KEY_RE = /secret|token|passw|pwd|key$|private|credential|authorization|bearer/i;
const BASE_URL_KEY_RE = /^(base[_-]?url|baseurl|host|url|server|endpoint|api[_-]?url|api[_-]?base|api[_-]?host|root[_-]?url)$/i;

const EMPTY: EnvironmentState = { active: '', environments: [] };

// ── Stored form ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function readEnvironments(enc: string | null | undefined): EnvironmentState {
  if (!enc) return { active: '', environments: [] };
  try {
    const v = JSON.parse(decrypt(enc, config.secretKey)) as Partial<EnvironmentState>;
    const environments = (Array.isArray(v.environments) ? v.environments : []).filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string');
    return { active: typeof v.active === 'string' ? v.active : '', environments };
  } catch { return { ...EMPTY, environments: [] }; }
}

export function storeEnvironments(state: EnvironmentState): string | null {
  return state.environments.length === 0 ? null : encrypt(JSON.stringify(state), config.secretKey);
}

// ── {{variables}} ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Replaces {{name}} with the variable's value. Names that are not defined stay as they are and are listed in `missing`. */
export function substitute(text: string, vars: EnvVariable[]): { text: string; missing: string[] } {
  const byKey = new Map(vars.map((v) => [v.key, v.value]));
  const missing: string[] = [];
  const out = text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    if (byKey.has(key)) return byKey.get(key) ?? '';
    if (!missing.includes(key)) missing.push(key);
    return whole;
  });
  return { text: out, missing };
}

function isHttps(v: string): boolean {
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && v.length <= 2000; } catch { return false; }
}

export interface ResolvedEnvironment { baseUrl: string; headers: Array<{ name: string; value: string }>; missing: string[]; problem: string }

/** The base URL and login headers of an environment with its variables filled in, and what is wrong with them if anything. */
export function resolveEnvironment(env: SimEnvironment): ResolvedEnvironment {
  const missing: string[] = [];
  const base = substitute(env.baseUrl.trim(), env.variables);
  missing.push(...base.missing);
  const headers = env.headers.map((h) => {
    const r = substitute(h.value, env.variables);
    for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    return { name: h.name, value: r.text };
  });
  const baseUrl = base.text.replace(/\/+$/, '');
  let problem = '';
  if (missing.length > 0) problem = `Variable${missing.length > 1 ? 's' : ''} ${missing.map((m) => `{{${m}}}`).join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value in this environment.`;
  else if (baseUrl && !isHttps(baseUrl)) problem = 'The base URL must be a full https:// address without a user name or password.';
  return { baseUrl, headers, missing, problem };
}

/** What the API record gets when this state is saved: the stored set, and the live address and login of the active environment. */
export function recordFields(state: EnvironmentState): { environments_enc: string | null; live_base_url?: string; live_headers_enc?: string | null } {
  const fields: { environments_enc: string | null; live_base_url?: string; live_headers_enc?: string | null } = { environments_enc: storeEnvironments(state) };
  const active = state.environments.find((e) => e.id === state.active);
  if (!active) return fields;
  const r = resolveEnvironment(active);
  if (r.baseUrl && !r.problem) fields.live_base_url = r.baseUrl;
  if (active.headers.length > 0 && r.missing.length === 0) {
    const built = buildLiveHeaders(r.headers.filter((h) => h.value !== ''), null);
    if ('enc' in built) fields.live_headers_enc = built.enc;
  }
  return fields;
}

// ── What a browser sees and sends ────────────────────────────────────────────────────────────────────────────────────

/** Secret values and header values are never sent to a browser: only whether they are set. */
export function publicEnvironments(state: EnvironmentState) {
  return {
    active: state.active,
    environments: state.environments.map((e) => {
      const r = resolveEnvironment(e);
      return {
        id: e.id, name: e.name, baseUrl: e.baseUrl, resolvedBaseUrl: r.baseUrl, problem: r.problem,
        variables: e.variables.map((v) => ({ key: v.key, secret: v.secret, value: v.secret ? '' : v.value, saved: v.secret && v.value !== '' })),
        headers: e.headers.map((h) => ({ name: h.name, saved: true })),
      };
    }),
  };
}

/**
 * Builds the stored set from a form. An empty secret value or header value keeps the value already stored for that name in
 * that environment (secrets are write-only, so the form never has them to send back).
 */
export function buildEnvironments(input: unknown, existing: EnvironmentState): { state: EnvironmentState } | { error: string } {
  const body = input as { active?: unknown; environments?: unknown } | null;
  if (!body || !Array.isArray(body.environments)) return { error: 'environments must be a list' };
  if (body.environments.length > MAX_ENVIRONMENTS) return { error: `At most ${MAX_ENVIRONMENTS} environments` };
  const out: SimEnvironment[] = [];
  const seen = new Set<string>();
  for (const raw of body.environments as Array<Record<string, unknown>>) {
    const name = String(raw?.name ?? '').trim();
    if (!name || name.length > 60) return { error: 'Each environment needs a name of 1-60 characters' };
    if (seen.has(name.toLowerCase())) return { error: `There are two environments named "${name}"` };
    seen.add(name.toLowerCase());
    const id = typeof raw.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(raw.id) ? raw.id : randomUUID().slice(0, 8);
    const before = existing.environments.find((e) => e.id === id);
    const baseUrl = String(raw.baseUrl ?? '').trim();
    if (baseUrl.length > 2000 || /[\r\n]/.test(baseUrl)) return { error: `The base URL of "${name}" is not valid` };

    const vars: EnvVariable[] = [];
    const rawVars = Array.isArray(raw.variables) ? (raw.variables as Array<Record<string, unknown>>) : [];
    if (rawVars.length > MAX_VARIABLES) return { error: `At most ${MAX_VARIABLES} variables per environment` };
    for (const v of rawVars) {
      const key = String(v?.key ?? '').trim();
      if (!key) continue;
      if (!KEY_RE.test(key)) return { error: `"${key}" is not a valid variable name (letters, digits, _ . -)` };
      if (vars.some((x) => x.key === key)) return { error: `Variable "${key}" appears twice in "${name}"` };
      const secret = v.secret === true;
      let value = String(v.value ?? '');
      if (secret && value === '') value = before?.variables.find((x) => x.key === key)?.value ?? '';
      if (value.length > MAX_VALUE || /[\r\n]/.test(value)) return { error: `The value of "${key}" is not valid` };
      vars.push({ key, value, secret });
    }

    const headers: EnvHeader[] = [];
    const rawHeaders = Array.isArray(raw.headers) ? (raw.headers as Array<Record<string, unknown>>) : [];
    if (rawHeaders.length > MAX_HEADERS) return { error: `At most ${MAX_HEADERS} headers per environment` };
    for (const h of rawHeaders) {
      const hn = String(h?.name ?? '').trim();
      if (!hn) continue;
      if (!HEADER_RE.test(hn) || /^(host|content-length|transfer-encoding|connection|cookie)$/i.test(hn)) return { error: `"${hn}" cannot be used as a login header` };
      let value = String(h.value ?? '');
      if (value === '') value = before?.headers.find((x) => x.name === hn)?.value ?? '';
      if (!value) return { error: `Header "${hn}" in "${name}" needs a value` };
      if (value.length > MAX_VALUE || /[\r\n]/.test(value)) return { error: `Header "${hn}" has an invalid value` };
      headers.push({ name: hn, value });
    }
    out.push({ id, name, baseUrl, variables: vars, headers });
  }
  const wanted = typeof body.active === 'string' ? body.active : '';
  const active = out.some((e) => e.id === wanted) ? wanted : (out[0]?.id ?? '');
  return { state: { active, environments: out } };
}

// ── Reading files ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ParsedEnvironments { environments: SimEnvironment[]; notes: string[] }

const stem = (fileName: string): string => fileName.replace(/^.*[\\/]/, '').replace(/\.(postman_environment|postman_collection)?\.?(json|env|txt)$/i, '').replace(/^\.?env\.?/i, '').replace(/[._-]+$/, '').trim();
const newId = (): string => randomUUID().slice(0, 8);

function guessBaseUrl(vars: EnvVariable[]): string {
  const hit = vars.find((v) => BASE_URL_KEY_RE.test(v.key) && /^https?:\/\//i.test(v.value))
    ?? vars.find((v) => /^https?:\/\//i.test(v.value) && !v.secret);
  return hit ? `{{${hit.key}}}` : '';
}

function makeEnv(name: string, vars: EnvVariable[], baseUrl?: string): SimEnvironment {
  const clean = vars.filter((v) => KEY_RE.test(v.key)).slice(0, MAX_VARIABLES);
  return { id: newId(), name: name.slice(0, 60) || 'Environment', baseUrl: baseUrl ?? guessBaseUrl(clean), variables: clean, headers: [] };
}

const asVars = (list: unknown): EnvVariable[] => (Array.isArray(list) ? list : [])
  .filter((v) => v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string' && (v as { enabled?: unknown }).enabled !== false)
  .map((v) => {
    const o = v as { key: string; value?: unknown; type?: unknown };
    const value = typeof o.value === 'string' ? o.value : o.value == null ? '' : String(o.value);
    return { key: o.key.trim(), value: value.slice(0, MAX_VALUE), secret: o.type === 'secret' || SECRET_KEY_RE.test(o.key) };
  });

function fromOpenApi(doc: Record<string, unknown>): ParsedEnvironments {
  const notes: string[] = [];
  const environments: SimEnvironment[] = [];
  const servers = Array.isArray(doc.servers) ? (doc.servers as Array<Record<string, unknown>>) : [];
  const toVarSyntax = (url: string) => url.replace(/\{([A-Za-z0-9_.-]+)\}/g, '{{$1}}');
  for (const s of servers.slice(0, MAX_ENVIRONMENTS)) {
    if (typeof s.url !== 'string') continue;
    const vars: EnvVariable[] = [];
    for (const [k, v] of Object.entries((s.variables ?? {}) as Record<string, { default?: unknown }>)) vars.push({ key: k, value: String(v?.default ?? ''), secret: false });
    const label = typeof s.description === 'string' && s.description.trim() ? s.description.trim() : (() => { try { return new URL(s.url.replace(/\{[^}]*\}/g, 'x')).host; } catch { return s.url; } })();
    environments.push({ id: newId(), name: label.slice(0, 60), baseUrl: toVarSyntax(s.url), variables: vars, headers: [] });
  }
  if (environments.length === 0 && typeof doc.host === 'string') {
    environments.push({ id: newId(), name: String(doc.host).slice(0, 60), baseUrl: `https://${doc.host}${typeof doc.basePath === 'string' ? doc.basePath : ''}`, variables: [], headers: [] });
  }
  if (environments.length === 0) notes.push('That file has no servers, so there is no environment in it.');
  return { environments, notes };
}

/** One uploaded file -> environments. Postman environment, Postman collection, OpenAPI/Swagger or a .env file. */
export function parseEnvironmentFile(fileName: string, text: string): ParsedEnvironments {
  const notes: string[] = [];
  const label = fileName.replace(/^.*[\\/]/, '') || 'file';
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.values)) {
      const name = (typeof o.name === 'string' && o.name.trim()) || stem(label) || 'Environment';
      return { environments: [makeEnv(name, asVars(o.values))], notes };
    }
    if (o.info && typeof o.info === 'object' && Array.isArray(o.item)) {
      const vars = asVars(o.variable);
      const name = (typeof (o.info as { name?: unknown }).name === 'string' && (o.info as { name: string }).name.trim()) || stem(label) || 'Collection';
      if (vars.length === 0) return { environments: [], notes: [`${label}: the collection has no variables, so there is no environment in it.`] };
      return { environments: [makeEnv(name, vars)], notes: [`${label}: read the collection's variables as one environment named "${name}".`] };
    }
    if (typeof o.openapi === 'string' || typeof o.swagger === 'string') {
      const r = fromOpenApi(o);
      return { environments: r.environments, notes: r.notes.map((n) => `${label}: ${n}`) };
    }
    return { environments: [], notes: [`${label}: not a Postman environment, Postman collection or OpenAPI file.`] };
  }
  // .env style: KEY=VALUE per line
  const vars: EnvVariable[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    vars.push({ key: m[1], value: value.slice(0, MAX_VALUE), secret: SECRET_KEY_RE.test(m[1]) });
  }
  if (vars.length === 0) return { environments: [], notes: [`${label}: no KEY=VALUE lines or recognised JSON found.`] };
  return { environments: [makeEnv(stem(label) || 'default', vars)], notes };
}

/** The addresses a document names with a label (for example UAT and PROD) -> one environment each. */
export function environmentsFromBaseUrls(urls: Array<{ label: string; url: string }>): SimEnvironment[] {
  const out: SimEnvironment[] = [];
  for (const u of urls.slice(0, MAX_ENVIRONMENTS)) {
    const base = u.url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/i.test(base)) continue;
    let name = (u.label || '').trim() || (() => { try { return new URL(base).host; } catch { return base; } })();
    let n = 2;
    while (out.some((e) => e.name.toLowerCase() === name.toLowerCase())) name = `${(u.label || 'Environment').trim()} ${n++}`;
    out.push({ id: newId(), name: name.slice(0, 60), baseUrl: base, variables: [], headers: [] });
  }
  return out;
}

/** Adds environments to a set: one with the same name (any case) is updated, the others are added, up to the limit. */
export function mergeEnvironments(state: EnvironmentState, incoming: SimEnvironment[]): { state: EnvironmentState; added: string[]; updated: string[]; skipped: string[] } {
  const environments = state.environments.map((e) => ({ ...e, variables: [...e.variables], headers: [...e.headers] }));
  const added: string[] = []; const updated: string[] = []; const skipped: string[] = [];
  for (const inc of incoming) {
    const existing = environments.find((e) => e.name.toLowerCase() === inc.name.toLowerCase());
    if (existing) {
      if (inc.baseUrl) existing.baseUrl = inc.baseUrl;
      for (const v of inc.variables) {
        const at = existing.variables.findIndex((x) => x.key === v.key);
        if (at >= 0) existing.variables[at] = v; else if (existing.variables.length < MAX_VARIABLES) existing.variables.push(v);
      }
      updated.push(existing.name);
    } else if (environments.length < MAX_ENVIRONMENTS) {
      environments.push(inc);
      added.push(inc.name);
    } else skipped.push(inc.name);
  }
  const active = environments.some((e) => e.id === state.active) ? state.active : (environments[0]?.id ?? '');
  return { state: { active, environments }, added, updated, skipped };
}
