/**
 * Integrations: services an agent can use in a run as MCP tools.
 *
 *   http        any MCP server over streamable HTTP, with secret headers
 *   stdio       any MCP server the portal starts as a command (admins only: it runs on the server)
 *   atlassian   Jira and Confluence through Atlassian's Rovo MCP server, with an email and API token
 *   aws         read-only AWS (the AWS API MCP server with READ_OPERATIONS_ONLY) through one of the AWS accounts
 *   browser     a headless web browser (Playwright MCP) the agent can open pages and take screenshots with
 *
 * Integrations are read-only unless writes are allowed: tools whose names say they change something are refused by
 * the run's guard before they are called. Secrets (headers, env, tokens) are write-only and reach a run only as the
 * environment or headers of its MCP servers. Team integrations can be attached to workspaces; personal ones only to
 * their owner's own sessions and runs.
 */
import { spawn } from 'node:child_process';
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { del, get, post, put, type Ctx } from './http.ts';
import { deleteSecret, getSecret, secretInfo, setSecret } from './secrets.ts';
import { HttpError, badRequest, newId, notFound, now, parseJson, slugify, str } from './util.ts';
import { connectionEnv, getConnection as getAwsConnection } from './aws-connections.ts';

export type IntegrationKind = 'http' | 'stdio' | 'atlassian' | 'aws' | 'browser';
const KINDS: IntegrationKind[] = ['http', 'stdio', 'atlassian', 'aws', 'browser'];

/** Pinned versions of the preset servers (changed deliberately, never "latest"). */
export const PRESET_PACKAGES = {
  browser: '@playwright/mcp@0.0.83',
  aws: 'awslabs.aws-api-mcp-server@1.5.6',
};
export const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/mcp';

type User = NonNullable<Ctx['user']>;

export interface IntegrationConfig {
  url?: string;
  headerNames?: string[];
  command?: string;
  args?: string[];
  envNames?: string[];
  email?: string;
  awsConnectionId?: string;
}

/** An MCP server as a run's engines get it. */
export type McpServer =
  | { type: 'http'; url: string; headers: Record<string, string> }
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };

const secret = (id: string) => `integ.${id}.secrets`;

export function getIntegration(id: string): Row | null {
  return one<Row>('SELECT * FROM integrations WHERE id = ?', id) ?? null;
}

export function canUseIntegration(i: Row, userId: string): boolean {
  return i.scope === 'team' || i.owner_id === userId;
}

function canManage(i: Row, user: User): boolean {
  return i.scope === 'personal' ? i.owner_id === user.id : Boolean(user.is_admin) || i.created_by === user.id;
}

function workspacesUsing(id: string): { id: string; name: string; project: string }[] {
  return all<Row>("SELECT w.id, w.name, p.name AS project FROM workspaces w JOIN projects p ON p.id = w.project_id WHERE w.integrations LIKE ?", `%"${id}"%`) as any;
}

function view(i: Row, user: User) {
  const cfg = parseJson<IntegrationConfig>(i.config, {});
  const aws = cfg.awsConnectionId ? getAwsConnection(cfg.awsConnectionId) : null;
  const used = workspacesUsing(i.id);
  return {
    id: i.id,
    name: i.name,
    kind: i.kind,
    scope: i.scope,
    allowWrites: Boolean(i.allow_writes),
    config: { url: cfg.url ?? '', headerNames: cfg.headerNames ?? [], command: cfg.command ?? '', args: cfg.args ?? [], envNames: cfg.envNames ?? [], email: cfg.email ?? '', aws: aws ? { id: aws.id, name: aws.name, region: aws.region } : null },
    secrets: secretInfo(secret(i.id)),
    test: i.tested_at ? { ok: Boolean(i.test_ok), message: i.test_message, at: i.tested_at } : null,
    workspaces: used,
    updatedAt: i.updated_at,
    canManage: canManage(i, user),
  };
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** Validate a create or edit request: the columns to save and the secret values (if any were sent). */
function readBody(body: any, user: User, cur?: Row) {
  const kind: IntegrationKind = cur?.kind ?? body.kind;
  if (!KINDS.includes(kind)) throw badRequest('Choose Jira & Confluence, AWS, a web browser, or a custom MCP server');
  if (kind === 'stdio' && !user.is_admin) throw badRequest('Only admins can add a command-line MCP server: it runs on the portal server');
  const name = str(body.name ?? cur?.name, 'Name', { max: 60 }).trim();
  if (!name) throw badRequest('Give the integration a name');
  const scope = (body.scope ?? cur?.scope) === 'personal' ? 'personal' : 'team';
  const old = parseJson<IntegrationConfig>(cur?.config, {});
  const cfg: IntegrationConfig = {};
  // Secret values sent now; names listed with an empty value keep their saved value, names left out are dropped.
  let secrets: Record<string, string> | null = null;
  let keep: string[] = [];
  const map = (raw: unknown, what: string): { names: string[]; values: Record<string, string> } | null => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest(`${what} must be name: value pairs`);
    const values: Record<string, string> = {};
    const names = Object.keys(raw as object);
    if (names.length > 20) throw badRequest(`At most 20 ${what.toLowerCase()}s`);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!NAME_RE.test(k)) throw badRequest(`"${k}" is not a valid ${what.toLowerCase()} name`);
      if (v !== '' && v !== undefined && v !== null) values[k] = str(v, k, { max: 8000 });
    }
    return { names, values };
  };
  if (kind === 'http' || kind === 'atlassian') {
    cfg.url = str(body.url ?? old.url ?? (kind === 'atlassian' ? ATLASSIAN_MCP_URL : ''), 'Server address', { max: 500 }).trim();
    // Plain http only for local test servers (PORTAL_ALLOW_HTTP_MCP=1); real servers must use https.
    const scheme = process.env.PORTAL_ALLOW_HTTP_MCP === '1' ? /^https?:\/\/\S+$/ : /^https:\/\/\S+$/;
    if (!scheme.test(cfg.url)) throw badRequest('Use the https:// address of the MCP server');
  }
  if (kind === 'http') {
    const headers = map(body.headers, 'Header');
    if (headers) {
      secrets = headers.values;
      keep = headers.names;
    }
    cfg.headerNames = headers ? headers.names : old.headerNames ?? [];
  }
  if (kind === 'atlassian') {
    cfg.email = str(body.email ?? old.email, 'Atlassian email', { max: 200 }).trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(cfg.email)) throw badRequest('Enter the email of the Atlassian account');
    if (body.token) secrets = { token: str(body.token, 'API token', { max: 4000 }).trim() };
    else if (!cur) throw badRequest('Paste an Atlassian API token (id.atlassian.com › Security › API tokens)');
  }
  if (kind === 'stdio') {
    cfg.command = str(body.command ?? old.command, 'Command', { max: 200 }).trim();
    if (!/^[\w .@/:\\()-]+$/.test(cfg.command) || cfg.command !== cfg.command.trim()) throw badRequest('The command is a program name or path, without arguments (put those under Arguments)');
    const args = body.args ?? old.args ?? [];
    if (!Array.isArray(args) || args.length > 40) throw badRequest('Arguments must be a list (at most 40)');
    cfg.args = args.map((a: unknown) => str(a, 'Argument', { max: 500 }));
    const env = map(body.env, 'Variable');
    if (env) {
      secrets = env.values;
      keep = env.names;
    }
    cfg.envNames = env ? env.names : old.envNames ?? [];
  }
  if (kind === 'aws') {
    cfg.awsConnectionId = str(body.awsConnectionId ?? old.awsConnectionId, 'AWS account', { max: 64 });
    if (!getAwsConnection(cfg.awsConnectionId)) throw badRequest('Pick one of the AWS accounts (AWS accounts page)');
  }
  // A browser only reads pages; AWS stays read-only whatever the switch says (the server enforces it too).
  const allowWrites = kind === 'aws' ? 0 : body.allowWrites === undefined ? cur?.allow_writes ?? 0 : body.allowWrites ? 1 : 0;
  return { kind, row: { name, scope, config: JSON.stringify(cfg), allow_writes: allowWrites }, secrets, keep };
}

/* ------------------------------------------------------------------ */
/* Turning integrations into MCP servers                               */
/* ------------------------------------------------------------------ */

async function secretMap(id: string): Promise<Record<string, string>> {
  return parseJson<Record<string, string>>(await getSecret(secret(id)), {});
}

/** The MCP server for one integration, with its secrets filled in. */
export async function mcpServerFor(i: Row): Promise<McpServer> {
  const cfg = parseJson<IntegrationConfig>(i.config, {});
  const s = await secretMap(i.id);
  switch (i.kind as IntegrationKind) {
    case 'http':
      return { type: 'http', url: cfg.url!, headers: s };
    case 'atlassian':
      if (!s.token) throw badRequest(`The integration "${i.name}" has no API token`);
      return { type: 'http', url: cfg.url!, headers: { Authorization: `Basic ${Buffer.from(`${cfg.email}:${s.token}`).toString('base64')}` } };
    case 'stdio':
      return { type: 'stdio', command: cfg.command!, args: cfg.args ?? [], env: s };
    case 'aws': {
      const aws = await connectionEnv(cfg.awsConnectionId!);
      return { type: 'stdio', command: 'uvx', args: [PRESET_PACKAGES.aws], env: { ...aws, READ_OPERATIONS_ONLY: 'true', AWS_API_MCP_TELEMETRY: 'false' } };
    }
    case 'browser':
      return { type: 'stdio', command: 'npx', args: ['-y', PRESET_PACKAGES.browser, '--headless', '--isolated'], env: {} };
  }
  throw badRequest(`Unknown integration kind ${i.kind}`);
}

/** Server names as agents see them: mcp__<name>__<tool>. Unique within a run. */
export function serverName(i: Row, taken: Set<string>): string {
  let base = slugify(i.name, 30).replace(/-/g, '_') || 'integration';
  let n = base;
  for (let k = 2; taken.has(n); k++) n = `${base}_${k}`;
  taken.add(n);
  return n;
}

export interface RunIntegrations {
  servers: Record<string, McpServer>;
  /** Names of the servers whose changing tools are refused. */
  readOnly: Set<string>;
  /** For the run record and the agent's prompt. */
  summary: { id: string; name: string; server: string; kind: string; readOnly: boolean }[];
}

/** Resolve the integrations a run asked for. Each must exist and be usable by the person the run acts for. */
export async function resolveIntegrations(ids: string[], userId: string): Promise<RunIntegrations> {
  const out: RunIntegrations = { servers: {}, readOnly: new Set(), summary: [] };
  const taken = new Set<string>();
  for (const id of [...new Set(ids)].slice(0, 10)) {
    const i = getIntegration(id);
    if (!i || !canUseIntegration(i, userId)) throw badRequest('An integration of this run no longer exists or is not shared with you');
    const name = serverName(i, taken);
    out.servers[name] = await mcpServerFor(i);
    const ro = !i.allow_writes && i.kind !== 'browser';
    if (ro) out.readOnly.add(name);
    out.summary.push({ id: i.id, name: i.name, server: name, kind: i.kind, readOnly: ro });
  }
  return out;
}

/** Words in a tool name that mean it changes something. */
const CHANGING = /(?:^|[_\-.\s/])(create|update|delete|remove|put|post|patch|write|edit|add|insert|upsert|send|transition|assign|move|rename|upload|comment|publish|merge|close|archive|set|invoke|execute|run|start|stop|terminate|reboot|attach|detach|tag|untag|modify|replace|restore|revoke|grant|enable|disable|deploy|import)(?:$|[_\-.\s/])/;

/** Split an MCP tool name (Claude: mcp__server__tool; Kiro: @server/tool or server/tool) into its parts. */
export function mcpToolOf(toolName: string): { server: string; tool: string } | null {
  let m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (m) return { server: m[1], tool: m[2] };
  m = /^@?([\w-]+)\/(.+)$/.exec(toolName);
  if (m) return { server: m[1], tool: m[2] };
  return null;
}

/** Why a tool of a read-only integration may not run, or null. */
export function integrationGuard(readOnly: Set<string>, toolName: string): string | null {
  const t = mcpToolOf(toolName);
  if (!t || !readOnly.has(t.server)) return null;
  // camelCase names: split into words first, then compare in lower case (listRuns → list_runs, not "run").
  const words = t.tool.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (!CHANGING.test(`_${words}_`)) return null;
  return `Blocked by Agent Portal: the integration "${t.server}" is read-only, and ${t.tool} would change something. Ask a person to allow writes for it if this is needed.`;
}

/* ------------------------------------------------------------------ */
/* Testing: a real MCP handshake                                       */
/* ------------------------------------------------------------------ */

const MCP_INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-portal', version: '1' } } };

async function readRpc(res: Response): Promise<any> {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (const d of data) {
      try {
        const m = JSON.parse(d);
        if (m.id !== undefined) return m;
      } catch {
        /* not JSON */
      }
    }
    throw new Error('the server sent no answer');
  }
  return JSON.parse(text);
}

async function testHttp(s: Extract<McpServer, { type: 'http' }>): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...s.headers };
  const res = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify(MCP_INIT), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(s.url).host} answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check the credentials)' : ''}`);
  const init = await readRpc(res);
  if (init.error) throw new Error(init.error.message || 'the server refused to start a session');
  const session = res.headers.get('mcp-session-id');
  const h2 = { ...headers, ...(session ? { 'Mcp-Session-Id': session } : {}), 'MCP-Protocol-Version': init.result?.protocolVersion ?? '2025-06-18' };
  await fetch(s.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  const tools = await fetch(s.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), signal: AbortSignal.timeout(20_000) })
    .then(readRpc)
    .catch(() => null);
  const n = tools?.result?.tools?.length;
  const who = init.result?.serverInfo?.name ?? 'the MCP server';
  return `Connected to ${who}${n !== undefined ? `; ${n} tool${n === 1 ? '' : 's'} available` : ''}.`;
}

function testStdio(s: Extract<McpServer, { type: 'stdio' }>, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']) if (process.env[k]) env[k] = process.env[k]!;
    // Bare names like npx or uvx are .cmd shims on Windows and need the shell; a full path runs directly.
    const bare = !/[\\/]/.test(s.command);
    const child = spawn(s.command, s.args, { env: { ...env, ...s.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && bare });
    let buf = '';
    let err = '';
    let stage = 0;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error(`no answer within ${timeoutMs / 1000}s${err ? `: ${err.slice(-300)}` : ''}`))), timeoutMs);
    child.on('error', (e) => done(() => reject(new Error(`could not start ${s.command}: ${e.message}`))));
    child.on('exit', (code) => stage < 2 && done(() => reject(new Error(`${s.command} stopped (exit ${code})${err ? `: ${err.trim().slice(-300)}` : ''}`))));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line.startsWith('{')) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return done(() => reject(new Error(m.error.message)));
          stage = 1;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          (child as any).serverName = m.result?.serverInfo?.name;
        } else if (m.id === 2) {
          stage = 2;
          const n2 = m.result?.tools?.length ?? 0;
          done(() => resolve(`Started ${(child as any).serverName ?? s.command}; ${n2} tool${n2 === 1 ? '' : 's'} available.`));
        }
      }
    });
    child.stdin.write(JSON.stringify(MCP_INIT) + '\n');
  });
}

export async function testIntegration(i: Row): Promise<string> {
  const s = await mcpServerFor(i);
  return s.type === 'http' ? testHttp(s) : testStdio(s);
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function runTest(i: Row) {
  let ok = true;
  let message: string;
  try {
    message = await testIntegration(i);
  } catch (e: any) {
    ok = false;
    message = String(e?.message ?? e).slice(0, 400);
  }
  update('integrations', i.id, { test_ok: ok ? 1 : 0, test_message: message, tested_at: now() });
  return { ok, message };
}

function mustUse(id: string, user: User): Row {
  const i = getIntegration(id);
  if (!i || !canUseIntegration(i, user.id)) throw notFound('Integration not found');
  return i;
}

export function registerIntegrationRoutes(): void {
  get('/api/integrations', (ctx) => ({
    integrations: all<Row>("SELECT * FROM integrations WHERE scope = 'team' OR owner_id = ? ORDER BY scope DESC, name COLLATE NOCASE", ctx.user!.id).map((i) => view(i, ctx.user!)),
    presets: PRESET_PACKAGES,
    atlassianUrl: ATLASSIAN_MCP_URL,
  }));

  post('/api/integrations', async (ctx) => {
    const { kind, row, secrets } = readBody(await ctx.json(), ctx.user!);
    const id = newId('in_');
    insert('integrations', { id, kind, ...row, owner_id: row.scope === 'personal' ? ctx.user!.id : null, created_by: ctx.user!.id, updated_by: ctx.user!.id, created_at: now(), updated_at: now() });
    if (secrets && Object.keys(secrets).length) await setSecret(secret(id), JSON.stringify(secrets));
    return { integration: view(getIntegration(id)!, ctx.user!) };
  });

  put('/api/integrations/:id', async (ctx) => {
    const cur = mustUse(ctx.params.id, ctx.user!);
    if (!canManage(cur, ctx.user!)) throw new HttpError(403, 'Only admins and whoever made it can change a team integration; only its owner a personal one');
    const { row, secrets, keep } = readBody(await ctx.json(), ctx.user!, cur);
    if (cur.scope === 'team' && row.scope === 'personal' && workspacesUsing(cur.id).length) throw badRequest('Workspaces use this integration, so it stays shared with the team');
    update('integrations', cur.id, { ...row, owner_id: row.scope === 'personal' ? ctx.user!.id : null, updated_by: ctx.user!.id, updated_at: now() });
    if (secrets) {
      // Saved values of names that are still listed stay; new values replace them.
      const old = cur.kind === 'atlassian' ? {} : Object.fromEntries(Object.entries(await secretMap(cur.id)).filter(([k]) => keep.includes(k)));
      await setSecret(secret(cur.id), JSON.stringify({ ...old, ...secrets }));
    }
    return { integration: view(getIntegration(cur.id)!, ctx.user!) };
  });

  post('/api/integrations/:id/test', async (ctx) => {
    const i = mustUse(ctx.params.id, ctx.user!);
    const test = await runTest(i);
    return { integration: view(getIntegration(i.id)!, ctx.user!), test };
  });

  del('/api/integrations/:id', (ctx) => {
    const i = mustUse(ctx.params.id, ctx.user!);
    if (!canManage(i, ctx.user!)) throw new HttpError(403, 'Only admins, its owner or whoever made it can remove this integration');
    const used = workspacesUsing(i.id);
    if (used.length) throw badRequest(`Still attached to ${used.map((w) => `${w.project} / ${w.name}`).join(', ')}. Remove it from those workspaces first.`);
    exec('DELETE FROM integrations WHERE id = ?', i.id);
    deleteSecret(secret(i.id));
    return { ok: true };
  });
}

/** Integration ids from a request: each must exist and be usable by this person (team, or their own). */
export function readIntegrationIds(raw: unknown, userId: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Integrations must be a list');
  const ids = [...new Set(raw.map(String))];
  if (ids.length > 10) throw badRequest('Use at most 10 integrations');
  for (const id of ids) {
    const i = getIntegration(id);
    if (!i || !canUseIntegration(i, userId)) throw badRequest('One of the integrations does not exist or is not shared with you');
  }
  return ids;
}

/** Integrations a workspace may hold: team ones only, so nobody's personal credentials reach other people's runs. */
export function checkWorkspaceIntegrations(ids: string[]): void {
  for (const id of ids) {
    const i = getIntegration(id);
    if (!i) throw badRequest('One of the integrations no longer exists');
    if (i.scope !== 'team') throw badRequest(`"${i.name}" is a personal integration; a workspace can only hold team integrations`);
  }
}
