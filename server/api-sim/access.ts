/** Project access check shared by the API simulation routes. */

import { sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { getMemberRow, getProjectRow } from '../project-access.ts';

export async function requireProjectAccess(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const project = await getProjectRow(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await getMemberRow(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  return true;
}

export function bad(res: PortalResponse, message: string, status = 400): void { sendJson(res, status, { error: message }); }
