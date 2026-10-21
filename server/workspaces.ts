/**
 * Workspaces: named sets of a project's repositories, each with the branch work starts from, picked when starting a
 * session. A session copies the workspace when it starts, so editing a workspace only affects sessions started later.
 * Integrations (MCP tools) attached to a workspace come with it.
 */
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { del, get, post, put } from './http.ts';
import { notifyProject, requireProject } from './projects.ts';
import { checkBranch, getRepo } from './repos.ts';
import { badRequest, newId, notFound, now, parseJson, str } from './util.ts';

export interface WorkspaceRepo {
  repoId: string;
  /** '' follows the repository's default branch. */
  branch: string;
}

export function getWorkspace(id: string): Row {
  const w = one<Row>('SELECT * FROM workspaces WHERE id = ?', id);
  if (!w) throw notFound('Workspace not found');
  return w;
}

export function workspaceRepos(w: Row): WorkspaceRepo[] {
  return parseJson<WorkspaceRepo[]>(w.repos, []);
}

export function workspaceIntegrations(w: Row): string[] {
  return parseJson<string[]>(w.integrations, []);
}

function view(w: Row) {
  return {
    id: w.id,
    project_id: w.project_id,
    name: w.name,
    description: w.description,
    repos: workspaceRepos(w).map((x) => {
      const r = one<Row>('SELECT name, default_branch, status FROM repos WHERE id = ?', x.repoId);
      return { repoId: x.repoId, branch: x.branch, name: r?.name ?? '(removed repository)', defaultBranch: r?.default_branch ?? '', status: r?.status ?? 'missing' };
    }),
    integrations: workspaceIntegrations(w),
    sessions: Number(one<Row>('SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ?', w.id)?.n ?? 0),
    updated_by: w.updated_by ? one<Row>('SELECT name FROM users WHERE id = ?', w.updated_by)?.name ?? null : null,
    updated_at: w.updated_at,
  };
}

function readBody(projectId: string, body: any, cur?: Row) {
  const name = str(body.name ?? cur?.name, 'Name', { max: 80 }).trim();
  if (!name) throw badRequest('Give the workspace a name');
  const clash = one<Row>('SELECT id FROM workspaces WHERE project_id = ? AND name = ? COLLATE NOCASE', projectId, name);
  if (clash && clash.id !== cur?.id) throw badRequest(`There is already a workspace called "${name}"`);
  const raw: any[] = body.repos === undefined ? workspaceRepos(cur ?? ({} as Row)) : Array.isArray(body.repos) ? body.repos : [];
  if (raw.length > 8) throw badRequest('A workspace can hold at most 8 repositories');
  const repos: WorkspaceRepo[] = [];
  for (const x of raw) {
    const repo = getRepo(String(x?.repoId ?? ''));
    if (repo.project_id !== projectId) throw badRequest('That repository belongs to another project');
    if (repos.some((r) => r.repoId === repo.id)) throw badRequest(`${repo.name} is listed twice`);
    repos.push({ repoId: repo.id, branch: x.branch ? checkBranch(String(x.branch)) : '' });
  }
  const integrations = body.integrations === undefined ? workspaceIntegrations(cur ?? ({} as Row)) : Array.isArray(body.integrations) ? body.integrations.map(String) : [];
  if (integrations.length > 10) throw badRequest('Attach at most 10 integrations');
  const description = str(body.description ?? cur?.description ?? '', 'Description', { max: 500, optional: true }).trim();
  return { name, description, repos: JSON.stringify(repos), integrations: JSON.stringify([...new Set(integrations)]) };
}

export function registerWorkspaceRoutes(): void {
  get('/api/projects/:pid/workspaces', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { workspaces: all<Row>('SELECT * FROM workspaces WHERE project_id = ? ORDER BY name COLLATE NOCASE', project.id).map(view) };
  });

  post('/api/projects/:pid/workspaces', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const row = readBody(project.id, await ctx.json());
    const id = newId('ws_');
    insert('workspaces', { id, project_id: project.id, ...row, created_by: ctx.user!.id, updated_by: ctx.user!.id, created_at: now(), updated_at: now() });
    notifyProject(project.id, 'workspace.updated', { id });
    return { workspace: view(getWorkspace(id)) };
  });

  put('/api/workspaces/:id', async (ctx) => {
    const cur = getWorkspace(ctx.params.id);
    requireProject(ctx, cur.project_id, 'editor');
    update('workspaces', cur.id, { ...readBody(cur.project_id, await ctx.json(), cur), updated_by: ctx.user!.id, updated_at: now() });
    notifyProject(cur.project_id, 'workspace.updated', { id: cur.id });
    return { workspace: view(getWorkspace(cur.id)) };
  });

  del('/api/workspaces/:id', (ctx) => {
    const cur = getWorkspace(ctx.params.id);
    requireProject(ctx, cur.project_id, 'editor');
    // Sessions keep their own copy of the repositories, so they are unaffected.
    exec('UPDATE workflows SET workspace_id = NULL WHERE workspace_id = ?', cur.id);
    exec('DELETE FROM workspaces WHERE id = ?', cur.id);
    notifyProject(cur.project_id, 'workspace.updated', { id: cur.id });
    return { ok: true };
  });
}
