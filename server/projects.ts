/**
 * Projects API routes.
 *
 * Routes:
 *   GET    /api/projects                      — list projects user is member of (all if admin)
 *   POST   /api/projects                      — create project
 *   GET    /api/projects/:id                  — get project details + members
 *   PUT    /api/projects/:id                  — update name/description (owner only)
 *   DELETE /api/projects/:id                  — archive project (owner only)
 *   GET    /api/projects/:id/members          — list members with roles
 *   POST   /api/projects/:id/members          — add member (owner only)
 *   PUT    /api/projects/:id/members/:userId  — change member role (owner only)
 *   DELETE /api/projects/:id/members/:userId  — remove member (owner only)
 *   GET    /api/projects/:id/events           — SSE stream for project events
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, run, insert } from './db.ts';
import { generateId, now, str, badRequest, notFound, forbidden } from './util.ts';
import { config } from './config.ts';
import { subscribe, emit } from './events.ts';
import { SUPERPOWERS_SKILLS } from './superpowers-skills.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
  archived: number;
}

export interface ProjectMember {
  project_id: string;
  user_id: string;
  access: string;
  role: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a name to a URL-safe kebab-case slug. */
export function generateSlug(name: string, existingSlugs: string[]): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';

  if (!existingSlugs.includes(base)) return base;

  let n = 2;
  while (existingSlugs.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Generate CLAUDE.md content for a project. */
export function renderClaudeMd(project: Project): string {
  return `# ${project.name}

${project.description ? project.description + '\n' : ''}
**Project ID:** ${project.id}

## Paths

- Agents: \`.claude/agents/\`
- Skills: \`.claude/skills/\`
- Documents: \`docs/md/\`
- Decisions: \`docs/decisions.md\`
- Generated docs: \`docs/generated/\`
- Architecture diagrams: \`docs/diagrams/\`

# Superpowers bootstrap

Before responding, read .claude/skills/superpowers-bootstrap/SKILL.md and follow its instructions.
`;
}

/** Run a git command in the given directory, resolving with stdout or rejecting on failure. */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8').trim());
      } else {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/** Seed the 9 built-in Superpowers skills into the project directory. */
export async function ensureBuiltInSkills(projectDir: string): Promise<void> {
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  await fsp.mkdir(skillsDir, { recursive: true });

  for (const skill of SUPERPOWERS_SKILLS) {
    const skillDir = path.join(skillsDir, skill.name);
    await fsp.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    // Only write if it doesn't already exist
    if (!fs.existsSync(skillFile)) {
      await fsp.writeFile(skillFile, skill.content, 'utf8');
    }
  }
}

/** Create the project directory on disk, initialise git, and write CLAUDE.md. */
export async function initProjectDir(slug: string, dataDir: string, project: Project): Promise<void> {
  const dir = path.join(dataDir, 'projects', slug);
  await fsp.mkdir(dir, { recursive: true });

  // Create subdirectories
  for (const sub of ['repos', 'work', 'docs/md', 'docs/generated', 'docs/diagrams', '.claude/agents', '.claude/skills']) {
    await fsp.mkdir(path.join(dir, sub), { recursive: true });
  }

  // Initialise git repo
  try {
    await runGit(['init'], dir);
  } catch {
    // Non-fatal: git may not be available in all environments
  }

  // Write CLAUDE.md
  const claudeMd = renderClaudeMd(project);
  await fsp.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf8');

  // Write .gitignore
  await fsp.writeFile(
    path.join(dir, '.gitignore'),
    '# Managed by Agent Portal\nrepos/\nwork/\n',
    'utf8',
  );

  // Seed built-in skills
  await ensureBuiltInSkills(dir);

  // Initial commit (best effort)
  try {
    await runGit(['add', '-A'], dir);
    await runGit(['commit', '-m', 'chore: initialise project'], dir);
  } catch {
    // Non-fatal
  }
}

/** Check that the authenticated user is a member of the project. Returns the member row or null. */
function getMembership(projectId: string, userId: string): ProjectMember | null {
  return one<ProjectMember>(
    'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    userId,
  ) ?? null;
}

/** Require the caller to be a project owner (or admin). Sends 403/404 and returns false on failure. */
function requireOwner(req: PortalRequest, res: PortalResponse, projectId: string): boolean {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  const project = one<Project>('SELECT id FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = getMembership(projectId, req.user.id);
  if (!member || member.role !== 'owner') {
    sendJson(res, 403, { error: 'Project owner access required' });
    return false;
  }
  return true;
}

/** Require user to be at least a member of the project. */
function requireMember(req: PortalRequest, res: PortalResponse, projectId: string): Project | null {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const project = one<Project>('SELECT * FROM projects WHERE id = ? AND archived = 0', projectId);
  if (!project) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project;
  const member = getMembership(projectId, req.user.id);
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return project;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerProjectRoutes(): void {

  // GET /api/projects
  router.get('/api/projects', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    let projects: Project[];
    if (req.user.is_admin) {
      projects = all<Project>('SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC');
    } else {
      projects = all<Project>(
        `SELECT p.* FROM projects p
           JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
          WHERE p.archived = 0
          ORDER BY p.created_at DESC`,
        req.user.id,
      );
    }

    // Attach member counts
    const withCounts = projects.map((p) => {
      const cnt = one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?',
        p.id,
      );
      return { ...p, member_count: cnt?.n ?? 0 };
    });

    sendJson(res, 200, { projects: withCounts });
  });

  // POST /api/projects
  router.post('/api/projects', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const description = typeof body.description === 'string' ? body.description.trim() : '';

    // Generate unique slug
    const existingSlugs = all<{ slug: string }>('SELECT slug FROM projects').map((r) => r.slug);
    const slug = generateSlug(name, existingSlugs);

    const id = generateId();
    const ts = now();

    const project: Project = {
      id,
      slug,
      name,
      description,
      created_by: req.user.id,
      created_at: ts,
      archived: 0,
    };

    // Insert project row
    insert('projects', {
      id,
      slug,
      name,
      description,
      notes: '',
      created_by: req.user.id,
      created_at: ts,
      archived: 0,
      default_lead_agent: '',
      default_model: '',
      vault_generated: 1,
    });

    // Add creator as owner
    insert('project_members', {
      project_id: id,
      user_id: req.user.id,
      access: 'owner',
      role: 'owner',
    });

    // Create project directory (async, non-blocking)
    initProjectDir(slug, config.dataDir, project).catch((e: unknown) => {
      console.error(`[projects] Failed to init project dir for ${slug}:`, e);
    });

    sendJson(res, 201, { project });
  });

  // GET /api/projects/:id
  router.get('/api/projects/:id', (req: PortalRequest, res: PortalResponse): void => {
    const project = requireMember(req, res, req.params.id);
    if (!project) return;

    const members = all<{ user_id: string; name: string; email: string; role: string; access: string }>(
      `SELECT pm.user_id, u.name, u.email, pm.role, pm.access
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY pm.role DESC, u.name`,
      project.id,
    );

    sendJson(res, 200, { project, members });
  });

  // PUT /api/projects/:id
  router.put('/api/projects/:id', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireOwner(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.description !== undefined) patch.description = String(body.description ?? '').trim();

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const keys = Object.keys(patch);
    run(
      `UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string),
      req.params.id,
    );

    const project = one<Project>('SELECT * FROM projects WHERE id = ?', req.params.id);
    sendJson(res, 200, { project });
  });

  // DELETE /api/projects/:id
  router.delete('/api/projects/:id', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireOwner(req, res, req.params.id)) return;
    run('UPDATE projects SET archived = 1 WHERE id = ?', req.params.id);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:id/members
  router.get('/api/projects/:id/members', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireMember(req, res, req.params.id)) return;

    const members = all<{ user_id: string; name: string; email: string; role: string; access: string }>(
      `SELECT pm.user_id, u.name, u.email, pm.role, pm.access
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY pm.role DESC, u.name`,
      req.params.id,
    );

    sendJson(res, 200, { members });
  });

  // POST /api/projects/:id/members
  router.post('/api/projects/:id/members', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireOwner(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const userId = str(body.userId, 'userId');
    const role = str(body.role, 'role', { max: 32 });

    if (!['owner', 'editor', 'viewer'].includes(role)) {
      sendJson(res, 400, { error: 'role must be owner, editor, or viewer' });
      return;
    }

    const user = one<{ id: string }>('SELECT id FROM users WHERE id = ?', userId);
    if (!user) { sendJson(res, 404, { error: 'User not found' }); return; }

    const existing = getMembership(req.params.id, userId);
    if (existing) {
      sendJson(res, 409, { error: 'User is already a member of this project' });
      return;
    }

    insert('project_members', {
      project_id: req.params.id,
      user_id: userId,
      access: role,
      role,
    });

    emit(req.params.id, { type: 'member.added', userId, role });
    sendJson(res, 201, { ok: true });
  });

  // PUT /api/projects/:id/members/:userId
  router.put('/api/projects/:id/members/:userId', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireOwner(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const role = str(body.role, 'role', { max: 32 });

    if (!['owner', 'editor', 'viewer'].includes(role)) {
      sendJson(res, 400, { error: 'role must be owner, editor, or viewer' });
      return;
    }

    const existing = getMembership(req.params.id, req.params.userId);
    if (!existing) { sendJson(res, 404, { error: 'Member not found' }); return; }

    run(
      'UPDATE project_members SET role = ?, access = ? WHERE project_id = ? AND user_id = ?',
      role,
      role,
      req.params.id,
      req.params.userId,
    );

    emit(req.params.id, { type: 'member.updated', userId: req.params.userId, role });
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/projects/:id/members/:userId
  router.delete('/api/projects/:id/members/:userId', (req: PortalRequest, res: PortalResponse): void => {
    if (!requireOwner(req, res, req.params.id)) return;

    // Prevent owner from removing themselves if they are the last owner
    const ownerCount = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'",
      req.params.id,
    );
    if (
      req.params.userId === req.user!.id &&
      (ownerCount?.n ?? 0) <= 1
    ) {
      sendJson(res, 400, { error: 'Cannot remove the last owner' });
      return;
    }

    const result = run(
      'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
      req.params.id,
      req.params.userId,
    );
    if (result.changes === 0) { sendJson(res, 404, { error: 'Member not found' }); return; }

    emit(req.params.id, { type: 'member.removed', userId: req.params.userId });
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:id/events  (SSE)
  router.sse('/api/projects/:id/events', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const project = requireMember(req, res, req.params.id);
    if (!project) return;
    subscribe(req.params.id, res);
  });
}
