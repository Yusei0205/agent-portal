/** Shared permission helpers for project-scoped routes (members read, owners and admins write). */

import { sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getMemberRow, getProjectRow } from './project-access.ts';

/** Any project member (or an admin) may read; non-members see 404. */
export async function requireProjectMember(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  if (!await getProjectRow(projectId)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  if (!await getMemberRow(projectId, req.user.id)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

/** Only a portal admin or a project owner may change the policy or pause a project. */
export async function requireProjectOwnerOrAdmin(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  if (!await getProjectRow(projectId)) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (String(member.access) !== 'owner') { sendJson(res, 403, { error: 'Project owner or admin access required' }); return false; }
  return true;
}
