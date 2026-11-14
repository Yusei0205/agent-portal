/**
 * Test accounts for user guides.
 *
 * A user guide with screenshots needs the agent to sign in to the system it documents, often as several kinds of user (an admin, a
 * clerk, a customer). A project keeps a list of test accounts here: a role, a username and a password each. The list is stored
 * encrypted (secrets.ts) and no route ever returns a password. A guide run names the roles it may use; the runner receives only
 * those accounts and types them into the sign-in page itself (the `sign_in` browser tool), so the model never sees a password.
 *
 *   GET  /api/projects/:id/guide-accounts          the accounts without passwords
 *   PUT  /api/projects/:id/guide-accounts          replace the list (a row without a password keeps the one stored for its id)
 *   POST /api/projects/:id/guide-accounts/import   add or replace from a CSV (role, username, password, notes)
 *
 * Use accounts made for testing. Anyone who can create documents in the project can use them in a guide run.
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getSecret, setSecret, deleteSecret } from './secrets.ts';
import { appendAudit } from './audit.ts';
import { getDb } from './db.ts';
import type { Row } from './db.ts';
import { badRequest, generateId } from './util.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';

export const GUIDE_ACCOUNT_LIMITS = { accounts: 20, role: 60, username: 200, password: 200, notes: 200, csvChars: 40_000, csvRows: 200 };

export interface GuideAccountRecord { id: string; role: string; username: string; password: string; notes: string }
export interface GuideAccountView { id: string; role: string; username: string; notes: string; hasPassword: boolean }

const accountsKey = (projectId: string): string => `guide-accounts.${projectId}`;
const runKey = (workflowId: string): string => `guide-run.${workflowId}`;

export const accountView = (a: GuideAccountRecord): GuideAccountView => ({ id: a.id, role: a.role, username: a.username, notes: a.notes, hasPassword: Boolean(a.password) });

export async function loadGuideAccounts(projectId: string): Promise<GuideAccountRecord[]> {
  const raw = await getSecret(accountsKey(projectId));
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((a): a is GuideAccountRecord => Boolean(a) && typeof a.id === 'string' && typeof a.role === 'string' && typeof a.username === 'string' && typeof a.password === 'string').map((a) => ({ ...a, notes: typeof a.notes === 'string' ? a.notes : '' })) : [];
  } catch { return []; }
}

async function saveGuideAccounts(projectId: string, list: GuideAccountRecord[]): Promise<void> {
  if (list.length) await setSecret(accountsKey(projectId), JSON.stringify(list));
  else await deleteSecret(accountsKey(projectId));
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Rows of a CSV text: commas or semicolons or tabs, "quoted ""fields""" and line breaks inside quotes, a leading byte-order mark. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const COLUMN_NAMES: Record<string, 'role' | 'username' | 'password' | 'notes'> = {
  role: 'role', 'user role': 'role', 'user type': 'role', type: 'role', profile: 'role',
  username: 'username', user: 'username', 'user name': 'username', login: 'username', email: 'username', 'user id': 'username', userid: 'username', id: 'username',
  password: 'password', pass: 'password', pwd: 'password',
  notes: 'notes', note: 'notes', description: 'notes', remark: 'notes', remarks: 'notes',
};

export interface CsvAccount { role: string; username: string; password: string; notes: string }

/** The accounts in a CSV, and the rows that could not be used (with the line and why, never the password). */
export function accountsFromCsv(text: string): { rows: CsvAccount[]; errors: Array<{ line: number; reason: string }> } {
  const L = GUIDE_ACCOUNT_LIMITS;
  const out: { rows: CsvAccount[]; errors: Array<{ line: number; reason: string }> } = { rows: [], errors: [] };
  if (text.length > L.csvChars) { out.errors.push({ line: 0, reason: `The file is larger than ${L.csvChars / 1000} KB.` }); return out; }
  const table = parseCsv(text);
  if (!table.length) { out.errors.push({ line: 0, reason: 'The file is empty.' }); return out; }
  if (table.length > L.csvRows + 1) { out.errors.push({ line: 0, reason: `More than ${L.csvRows} rows.` }); return out; }
  const named = table[0].map((h) => COLUMN_NAMES[h.trim().toLowerCase()]);
  const hasHeader = named.includes('role') && named.includes('username') && named.includes('password');
  const columns: Array<'role' | 'username' | 'password' | 'notes' | undefined> = hasHeader ? named : ['role', 'username', 'password', 'notes'];
  for (const [i, cells] of table.entries()) {
    if (hasHeader && i === 0) continue;
    const line = i + 1;
    const value = (name: string): string => (cells[columns.indexOf(name as never)] ?? '').trim();
    const rec = { role: value('role'), username: value('username'), password: (cells[columns.indexOf('password')] ?? '').replace(/^\s+|\s+$/g, ''), notes: value('notes') };
    if (!rec.role || !rec.username || !rec.password) { out.errors.push({ line, reason: 'Needs a role, a username and a password.' }); continue; }
    if (rec.role.length > L.role || rec.username.length > L.username || rec.password.length > L.password || rec.notes.length > L.notes) { out.errors.push({ line, reason: 'A value is too long.' }); continue; }
    if (out.rows.some((r) => r.role.toLowerCase() === rec.role.toLowerCase())) { out.errors.push({ line, reason: `The role "${rec.role}" appears twice.` }); continue; }
    out.rows.push(rec);
  }
  return out;
}

// ── Checking what a person sends ────────────────────────────────────────────────────────────────────────

export function checkAccount(input: unknown, existing: GuideAccountRecord[]): GuideAccountRecord {
  const L = GUIDE_ACCOUNT_LIMITS;
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number, what: string, required = true): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw badRequest(`${what} is required`);
    if (s.length > max) throw badRequest(`${what} is too long (at most ${max} characters)`);
    return s;
  };
  const id = typeof o.id === 'string' && o.id ? o.id : '';
  const prev = id ? existing.find((a) => a.id === id) : undefined;
  if (id && !prev) throw badRequest('An account in the list no longer exists. Reload and try again.');
  const password = typeof o.password === 'string' && o.password !== '' ? o.password : prev?.password ?? '';
  if (!password) throw badRequest('A password is required for a new account');
  if (password.length > L.password) throw badRequest(`The password is too long (at most ${L.password} characters)`);
  return { id: prev?.id ?? generateId(), role: text(o.role, L.role, 'Role'), username: text(o.username, L.username, 'Username'), password, notes: text(o.notes, L.notes, 'Notes', false) };
}

function checkList(list: GuideAccountRecord[]): GuideAccountRecord[] {
  if (list.length > GUIDE_ACCOUNT_LIMITS.accounts) throw badRequest(`A project can keep at most ${GUIDE_ACCOUNT_LIMITS.accounts} test accounts`);
  const seen = new Set<string>();
  for (const a of list) {
    const k = a.role.toLowerCase();
    if (seen.has(k)) throw badRequest(`The role "${a.role}" is used twice. Each account needs its own role name.`);
    seen.add(k);
  }
  return list;
}

// ── What one guide run uses ─────────────────────────────────────────────────────────────────────────────

export interface GuideRunConfig { roles: string[]; hosts: string[] }

/** Remembers which roles and hosts a guide run may use (no passwords: those are read from the project's list when the run starts). */
export async function setGuideRun(workflowId: string, cfg: GuideRunConfig): Promise<void> {
  await setSecret(runKey(workflowId), JSON.stringify(cfg));
}

/** The accounts of a guide run, as the runner's payload carries them, with the hosts they may be typed on. */
export async function guideRunPayload(projectId: string, workflowId: string): Promise<{ accounts: Array<{ role: string; username: string; password: string }>; hosts: string[]; missing: string[] } | null> {
  const raw = await getSecret(runKey(workflowId));
  if (!raw) return null;
  let cfg: GuideRunConfig;
  try { cfg = JSON.parse(raw) as GuideRunConfig; } catch { return null; }
  const all = await loadGuideAccounts(projectId);
  const wanted = (cfg.roles ?? []).map((r) => r.toLowerCase());
  const picked = all.filter((a) => wanted.includes(a.role.toLowerCase()));
  const missing = (cfg.roles ?? []).filter((r) => !all.some((a) => a.role.toLowerCase() === r.toLowerCase()));
  return { accounts: picked.map(({ role, username, password }) => ({ role, username, password })), hosts: cfg.hosts ?? [], missing };
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────────────

async function requireEditor(req: PortalRequest, res: PortalResponse, projectId: string): Promise<Row | null> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return null; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (req.user.is_admin) return project;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return null; }
  if (String(member.role) === 'viewer') { sendJson(res, 403, { error: 'Editors and above can manage test accounts' }); return null; }
  return project;
}

export function registerGuideAccountRoutes(): void {
  router.get('/api/projects/:id/guide-accounts', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireEditor(req, res, req.params.id);
    if (!project) return;
    sendJson(res, 200, { accounts: (await loadGuideAccounts(String(project.id))).map(accountView), limits: GUIDE_ACCOUNT_LIMITS });
  });

  router.put('/api/projects/:id/guide-accounts', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireEditor(req, res, req.params.id);
    if (!project) return;
    const body = (req.body ?? {}) as { accounts?: unknown };
    if (!Array.isArray(body.accounts)) throw badRequest('accounts must be a list');
    const existing = await loadGuideAccounts(String(project.id));
    const next = checkList(body.accounts.map((a) => checkAccount(a, existing)));
    await saveGuideAccounts(String(project.id), next);
    appendAudit(getDb(), req.user!.id, 'guide_accounts.update', `project:${project.id}`, { count: next.length, roles: next.map((a) => a.role) }, req.ip);
    sendJson(res, 200, { accounts: next.map(accountView) });
  });

  router.post('/api/projects/:id/guide-accounts/import', async (req: PortalRequest, res: PortalResponse) => {
    const project = await requireEditor(req, res, req.params.id);
    if (!project) return;
    const body = (req.body ?? {}) as { csv?: unknown; mode?: unknown };
    if (typeof body.csv !== 'string' || !body.csv.trim()) throw badRequest('Choose a CSV file with the columns role, username, password (and notes).');
    const parsed = accountsFromCsv(body.csv);
    if (!parsed.rows.length) { sendJson(res, 400, { error: 'No account could be read from the file.', errors: parsed.errors }); return; }
    const replace = body.mode === 'replace';
    const existing = replace ? [] : await loadGuideAccounts(String(project.id));
    const merged = [...existing];
    let added = 0, updated = 0;
    for (const row of parsed.rows) {
      const at = merged.findIndex((a) => a.role.toLowerCase() === row.role.toLowerCase());
      if (at >= 0) { merged[at] = { ...merged[at], ...row }; updated++; } else { merged.push({ id: generateId(), ...row }); added++; }
    }
    const next = checkList(merged);
    await saveGuideAccounts(String(project.id), next);
    appendAudit(getDb(), req.user!.id, 'guide_accounts.import', `project:${project.id}`, { added, updated, replace, skipped: parsed.errors.length }, req.ip);
    sendJson(res, 200, { accounts: next.map(accountView), added, updated, errors: parsed.errors });
  });
}
