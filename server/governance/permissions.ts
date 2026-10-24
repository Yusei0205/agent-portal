/** Portal roles, the permissions matrix and effective project access. */
import { all, one } from '../db.ts';
import { get, type User } from '../http.ts';
import { type Access } from '../projects.ts';

export type PortalRole = 'admin' | 'member';
export type TeamRole = 'maintainer' | 'member';
export type ProjectAccess = 'viewer' | 'editor' | 'owner';

/** Full permissions matrix exposed by GET /api/roles-matrix */
export const PERMISSIONS_MATRIX = {
  portalAdmin: [
    'manage users (create, edit, disable, delete)',
    'manage all projects',
    'manage all teams',
    'manage portal settings',
    'manage API tokens (any user)',
    'view audit log',
    'manage SCIM tokens',
    'create invitations for any role / project',
    'view usage for all users',
    'manage Google OIDC settings',
  ],
  portalMember: [
    'view and join projects they are a member of',
    'create and manage own API tokens',
    'update own profile and password',
    'accept invitations',
    'view own usage',
  ],
  projectOwner: [
    'full project configuration',
    'add / remove project members',
    'create invitations for the project',
    'manage loop specs, repositories, agents, skills',
    'start, stop, and delete any session in the project',
    'push changes and approve any request in the project',
    'manage project budget',
  ],
  projectEditor: [
    'start sessions and runs',
    'manage loop specs',
    'upload and manage knowledge documents',
    'push changes',
    'answer own session requests',
  ],
  projectViewer: [
    'view sessions, runs, documents, and review findings',
    'take knowledge quizzes',
  ],
  teamMaintainer: [
    'manage team members',
    'manage team project access',
    'manage team budget',
    'invite new users to the team',
  ],
  teamMember: [
    'inherit project access granted to the team',
    'view team details',
  ],
};

/**
 * Effective access to a project for a user, considering both direct membership and team grants.
 * Returns the highest of direct access and all team grants.
 */
export function effectiveAccess(user: User, projectId: string): Access | null {
  if (user.is_admin) return 'owner';
  const RANK: Record<Access, number> = { viewer: 1, editor: 2, owner: 3 };
  const RRANK: Record<number, Access> = { 1: 'viewer', 2: 'editor', 3: 'owner' };
  let best = 0;
  // Direct project membership
  const direct = one<{ access: Access }>('SELECT access FROM project_members WHERE project_id = ? AND user_id = ?', projectId, user.id);
  if (direct) best = Math.max(best, RANK[direct.access] ?? 0);
  // Team grants
  const teamGrants = all<{ access: Access }>(
    `SELECT tp.access FROM team_projects tp
       JOIN team_members tm ON tm.team_id = tp.team_id
      WHERE tp.project_id = ? AND tm.user_id = ?`,
    projectId, user.id,
  );
  for (const tg of teamGrants) {
    best = Math.max(best, RANK[tg.access] ?? 0);
  }
  return best > 0 ? RRANK[best] : null;
}

export function registerPermissionsRoutes(): void {
  // ── Roles / permissions matrix ────────────────────────────────────────────
  get('/api/roles-matrix', () => ({ matrix: PERMISSIONS_MATRIX }), { auth: 'user' });
}
