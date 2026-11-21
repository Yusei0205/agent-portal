/**
 * Document types a project defines itself, for Create › Documents and Knowledge › Build from repositories
 * (docs/superpowers/specs/2026-11-21-knowledge-from-code-design.md, "custom types"). Kept as one setting per project.
 *
 *   GET    /api/projects/:id/doc-types            { builtIn: [{ id, label }], custom: [{ id, label, guide }] }   (members)
 *   POST   /api/projects/:id/doc-types            { label, guide } → { type }                                  (editors)
 *   DELETE /api/projects/:id/doc-types/:typeId                                                                (editors)
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { DOC_TYPES, DOC_TYPE_LABELS, CUSTOM_TYPE_LIMITS, cleanCustomType, type CustomDocType } from './generated-doc-text.ts';

export interface SavedDocType extends CustomDocType { id: string }

const key = (projectId: string): string => `docs.custom_types.${projectId}`;

export function listCustomTypes(projectId: string): SavedDocType[] {
  try {
    const raw = JSON.parse(getSetting(getDb(), key(projectId)) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((t) => {
      const c = cleanCustomType(t);
      return 'error' in c || typeof t?.id !== 'string' ? [] : [{ id: t.id, ...c }];
    });
  } catch { return []; }
}

async function saveCustomTypes(projectId: string, types: SavedDocType[]): Promise<void> {
  await setSetting(getDb(), key(projectId), JSON.stringify(types));
}

/** The built-in types a person picks from (the 'custom' marker type is not one of them). */
export const BUILT_IN_TYPES = DOC_TYPES.filter((t) => t !== 'custom').map((id) => ({ id, label: DOC_TYPE_LABELS[id] }));

async function access(req: PortalRequest, res: PortalResponse, projectId: string, editor: boolean): Promise<boolean> {
  if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return false; }
  const projects = getProjectRepository();
  const project = await projects.getProjectById(projectId);
  if (!project) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (req.user.is_admin) return true;
  const member = await projects.getMember(projectId, req.user.id);
  if (!member) { sendJson(res, 404, { error: 'Project not found' }); return false; }
  if (editor && String(member.role) === 'viewer') { sendJson(res, 403, { error: 'Editors and above can change document types' }); return false; }
  return true;
}

export function registerDocTypeRoutes(): void {
  router.get('/api/projects/:id/doc-types', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await access(req, res, projectId, false))) return;
    sendJson(res, 200, { builtIn: BUILT_IN_TYPES, custom: listCustomTypes(projectId) });
  });

  router.post('/api/projects/:id/doc-types', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await access(req, res, projectId, true))) return;
    const c = cleanCustomType(req.body);
    if ('error' in c) { sendJson(res, 400, { error: c.error }); return; }
    const types = listCustomTypes(projectId);
    const same = types.find((t) => t.label.toLowerCase() === c.label.toLowerCase());
    if (same) {
      // Saving a type with a name that exists updates what it should contain.
      same.guide = c.guide;
      await saveCustomTypes(projectId, types);
      sendJson(res, 200, { type: same });
      return;
    }
    if (types.length >= CUSTOM_TYPE_LIMITS.perProject) { sendJson(res, 400, { error: `A project can keep at most ${CUSTOM_TYPE_LIMITS.perProject} document types` }); return; }
    const type: SavedDocType = { id: `ct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...c };
    await saveCustomTypes(projectId, [...types, type]);
    sendJson(res, 200, { type });
  });

  router.delete('/api/projects/:id/doc-types/:typeId', async (req: PortalRequest, res: PortalResponse) => {
    const projectId = String(req.params.id);
    if (!(await access(req, res, projectId, true))) return;
    const types = listCustomTypes(projectId);
    const rest = types.filter((t) => t.id !== String(req.params.typeId));
    if (rest.length === types.length) { sendJson(res, 404, { error: 'Document type not found' }); return; }
    await saveCustomTypes(projectId, rest);
    sendJson(res, 200, { ok: true });
  });
}
