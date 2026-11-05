/**
 * Pull request settings, per project.
 *
 *   GET /api/projects/:id/pull-request-settings   { openPullRequests, protectedBranches }   (project members)
 *   PUT /api/projects/:id/pull-request-settings   a partial update of the same two fields    (project editors)
 *
 * `openPullRequests` turns on opening a pull request when a session fixes code. `protectedBranches` lists the
 * branch names (a trailing * matches a prefix, as in release/*) the portal never pushes to. The repository's own
 * default branch is always protected as well; that is decided where the push happens, not stored here.
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { appendAudit } from './audit.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';

export interface PullRequestSettings {
  openPullRequests: boolean;
  protectedBranches: string[];
}

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'develop', 'release/*'];
export const MAX_PROTECTED_BRANCHES = 50;
const BRANCH_RE = /^[A-Za-z0-9*][A-Za-z0-9._/*-]{0,199}$/;

const openKey = (projectId: string): string => `project:${projectId}:openPullRequests`;
const protectedKey = (projectId: string): string => `project:${projectId}:protectedBranches`;

function readJson(key: string): unknown {
  try {
    const raw = getSetting(getDb(), key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** The project's settings, with defaults for anything never saved. */
export function getPullRequestSettings(projectId: string): PullRequestSettings {
  const open = readJson(openKey(projectId));
  const branches = readJson(protectedKey(projectId));
  return {
    openPullRequests: typeof open === 'boolean' ? open : true,
    protectedBranches: Array.isArray(branches) && branches.every((b) => typeof b === 'string')
      ? (branches as string[])
      : [...DEFAULT_PROTECTED_BRANCHES],
  };
}

/** Check a branch list from a request: trimmed, no duplicates. Throws a message fit for the person. */
function cleanBranches(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('protectedBranches must be a list of branch names');
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') throw new Error('Each protected branch must be text');
    const name = item.trim();
    if (!name) continue;
    if (!BRANCH_RE.test(name)) {
      throw new Error(`"${name.slice(0, 40)}" is not a valid branch name: use letters, digits and . _ / - *, up to 200 characters`);
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > MAX_PROTECTED_BRANCHES) throw new Error(`Protect at most ${MAX_PROTECTED_BRANCHES} branches`);
  return out;
}

/**
 * Update either or both settings. Throws on invalid input before anything is written.
 * Returns the settings as stored afterwards.
 */
export async function setPullRequestSettings(
  projectId: string,
  patch: { openPullRequests?: unknown; protectedBranches?: unknown },
): Promise<PullRequestSettings> {
  let open: boolean | undefined;
  let branches: string[] | undefined;
  if (patch.openPullRequests !== undefined) {
    if (typeof patch.openPullRequests !== 'boolean') throw new Error('openPullRequests must be true or false');
    open = patch.openPullRequests;
  }
  if (patch.protectedBranches !== undefined) branches = cleanBranches(patch.protectedBranches);
  if (open !== undefined) await setSetting(getDb(), openKey(projectId), JSON.stringify(open));
  if (branches !== undefined) await setSetting(getDb(), protectedKey(projectId), JSON.stringify(branches));
  return getPullRequestSettings(projectId);
}

async function requireAccess(req: PortalRequest, res: PortalResponse, projectId: string, edit: boolean): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  if (!await getProjectRow(projectId)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (edit && !['editor', 'owner'].includes(String(member.access ?? ''))) {
    sendJson(res, 403, { error: 'Project editor access is needed to change pull request settings' });
    return false;
  }
  return true;
}

export function registerProjectPullRequestSettingsRoutes(): void {
  router.get('/api/projects/:id/pull-request-settings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireAccess(req, res, pid, false)) return;
    sendJson(res, 200, getPullRequestSettings(pid));
  });

  router.put('/api/projects/:id/pull-request-settings', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const pid = req.params.id;
    if (!await requireAccess(req, res, pid, true)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const settings = await setPullRequestSettings(pid, body);
      try { appendAudit(null, req.user!.id, 'project.pull-request-settings', pid, null, null); } catch { /* audit must not break a request */ }
      sendJson(res, 200, settings);
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
    }
  });
}
