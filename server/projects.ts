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
import { generateId, now, str } from './util.ts';
import { config } from './config.ts';
import { subscribe, emit } from './events.ts';
import { SUPERPOWERS_SKILLS } from './superpowers-skills.ts';
import { ensureBundledSkills } from './bundled-skills.ts';
import { getProjectRepository, SlugAlreadyTakenError } from './repositories/projects.ts';
import { getAuthRepository } from './repositories/auth.ts';

import { requireStepUp } from './step-up.ts';
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

/** Seed the 9 built-in Superpowers skills (and the bundled frontend-design, caveman and security-guidance skills) into the project directory. */
export async function ensureBuiltInSkills(projectDir: string): Promise<void> {
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  await fsp.mkdir(skillsDir, { recursive: true });
  await ensureBundledSkills(projectDir);

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
/**
 * Project folders being set up in the background: a new project is returned before its folder is ready. Anything that reads or
 * removes the folder right after (a test, a clean-up) waits with projectDirsReady().
 */
const settingUp = new Set<Promise<void>>();

function inBackground(setup: Promise<void>): Promise<void> {
  settingUp.add(setup);
  const done = (): void => { settingUp.delete(setup); };
  setup.then(done, done);
  return setup;
}

/** Resolves when no project folder is being set up (a failed set-up counts as finished). */
export async function projectDirsReady(): Promise<void> {
  while (settingUp.size) await Promise.allSettled([...settingUp]);
}

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

// ── Async access helpers ──────────────────────────────────────────────────────

/** Require the caller to be a project owner (or admin). Sends 403/404 and returns false on failure. */
async function requireOwner(req: PortalRequest, res: PortalResponse, projectId: string): Promise<boolean> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return false;
  }
  const repo = getProjectRepository();
  const project = await repo.getProjectById(projectId);
  if (!project || project.archived) {
    sendJson(res, 404, { error: 'Project not found' });
    return false;
  }
  if (req.user.is_admin) return true;
  const member = await repo.getMember(projectId, req.user.id);
  if (!member || member.role !== 'owner') {
    sendJson(res, 403, { error: 'Project owner access required' });
    return false;
  }
  return true;
}

/** Require user to be at least a member of the project. Returns the project or null. */
async function requireMember(req: PortalRequest, res: PortalResponse, projectId: string): Promise<Project | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const repo = getProjectRepository();
  const project = await repo.getProjectById(projectId);
  if (!project || project.archived) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  if (req.user.is_admin) return project as Project;
  const member = await repo.getMember(projectId, req.user.id);
  if (!member) {
    sendJson(res, 404, { error: 'Project not found' });
    return null;
  }
  return project as Project;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerProjectRoutes(): void {

  // GET /api/projects
  router.get('/api/projects', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const repo = getProjectRepository();
    let projects;
    if (req.user.is_admin) {
      projects = await repo.listProjects();
    } else {
      projects = await repo.listMyProjects(req.user.id);
    }

    // Attach member counts
    const withCounts = await Promise.all(
      projects.map(async (p) => {
        const cnt = await repo.countMembers(p.id);
        return { ...p, member_count: cnt };
      }),
    );

    sendJson(res, 200, { projects: withCounts });
  });

  // POST /api/projects
  router.post('/api/projects', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const body = req.body as Record<string, unknown>;
    const name = str(body.name, 'name', { max: 120 }).trim();
    const description = typeof body.description === 'string' ? body.description.trim() : '';

    const repo = getProjectRepository();

    const id = generateId();
    const ts = now();

    // Retry on slug collision (race between getAllSlugs and createProjectWithOwner).
    // Each iteration refreshes the slug list so generateSlug can pick a free suffix.
    const MAX_RETRIES = 5;
    let project;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const existingSlugs = await repo.getAllSlugs();
      const slug = generateSlug(name, existingSlugs);
      try {
        project = await repo.createProjectWithOwner({
          id,
          slug,
          name,
          description,
          notes:              '',
          created_by:         req.user.id,
          created_at:         ts,
          archived:           0,
          default_lead_agent: '',
          default_model:      '',
          vault_generated:    1,
        }, req.user.id);
        break;
      } catch (e: unknown) {
        if (e instanceof SlugAlreadyTakenError && attempt < MAX_RETRIES) {
          continue;
        }
        if (e instanceof SlugAlreadyTakenError) {
          sendJson(res, 409, { error: 'Could not generate a unique slug for this project name. Please try again.' });
          return;
        }
        throw e;
      }
    }

    // Create project directory (async, non-blocking)
    inBackground(initProjectDir(project!.slug, config.dataDir, project! as Project)).catch((e: unknown) => {
      console.error(`[projects] Failed to init project dir for ${project!.slug}:`, e);
    });

    sendJson(res, 201, { project });
  });

  // GET /api/projects/:id
  router.get('/api/projects/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    const project = await requireMember(req, res, req.params.id);
    if (!project) return;

    const repo = getProjectRepository();
    const authRepo = getAuthRepository();

    const members = await repo.listMembers(project.id);

    // Batch-get user names/emails from auth repository
    const userIds = members.map((m) => m.user_id);
    const users = await authRepo.getUsersByIds(userIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = members
      .map((m) => {
        const u = userMap.get(m.user_id);
        return {
          user_id: m.user_id,
          name:    u?.name ?? '',
          email:   u?.email ?? '',
          role:    m.role,
          access:  m.access,
        };
      })
      .sort((a, b) => {
        if (a.role === b.role) return a.name.localeCompare(b.name);
        // owner first
        if (a.role === 'owner') return -1;
        if (b.role === 'owner') return 1;
        return a.role.localeCompare(b.role);
      });

    sendJson(res, 200, { project, members: enriched });
  });

  // PUT /api/projects/:id
  router.put('/api/projects/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireOwner(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const patch: Record<string, string | number | null> = {};
    if (body.name !== undefined) patch.name = str(body.name, 'name', { max: 120 }).trim();
    if (body.description !== undefined) patch.description = String(body.description ?? '').trim();

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'Nothing to update' });
      return;
    }

    const project = await getProjectRepository().updateProject(req.params.id, patch);
    sendJson(res, 200, { project });
  });

  // DELETE /api/projects/:id
  router.delete('/api/projects/:id', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireOwner(req, res, req.params.id)) return;
    if (!await requireStepUp(req, res)) return;
    await getProjectRepository().archiveProject(req.params.id);
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:id/members
  router.get('/api/projects/:id/members', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireMember(req, res, req.params.id)) return;

    const repo = getProjectRepository();
    const authRepo = getAuthRepository();

    const members = await repo.listMembers(req.params.id);
    const userIds = members.map((m) => m.user_id);
    const users = await authRepo.getUsersByIds(userIds);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = members
      .map((m) => {
        const u = userMap.get(m.user_id);
        return {
          user_id: m.user_id,
          name:    u?.name ?? '',
          email:   u?.email ?? '',
          role:    m.role,
          access:  m.access,
        };
      })
      .sort((a, b) => {
        if (a.role === b.role) return a.name.localeCompare(b.name);
        if (a.role === 'owner') return -1;
        if (b.role === 'owner') return 1;
        return a.role.localeCompare(b.role);
      });

    sendJson(res, 200, { members: enriched });
  });

  // POST /api/projects/:id/members
  router.post('/api/projects/:id/members', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireOwner(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const userId = str(body.userId, 'userId');
    const role = str(body.role, 'role', { max: 32 });

    if (!['owner', 'editor', 'viewer'].includes(role)) {
      sendJson(res, 400, { error: 'role must be owner, editor, or viewer' });
      return;
    }

    const user = await getAuthRepository().getUserById(userId);
    if (!user) { sendJson(res, 404, { error: 'User not found' }); return; }

    const repo = getProjectRepository();
    const existing = await repo.getMember(req.params.id, userId);
    if (existing) {
      sendJson(res, 409, { error: 'User is already a member of this project' });
      return;
    }

    await repo.addMember(req.params.id, userId, role);

    emit(req.params.id, { type: 'member.added', userId, role });
    sendJson(res, 201, { ok: true });
  });

  // PUT /api/projects/:id/members/:userId
  router.put('/api/projects/:id/members/:userId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireOwner(req, res, req.params.id)) return;

    const body = req.body as Record<string, unknown>;
    const role = str(body.role, 'role', { max: 32 });

    if (!['owner', 'editor', 'viewer'].includes(role)) {
      sendJson(res, 400, { error: 'role must be owner, editor, or viewer' });
      return;
    }

    const repo = getProjectRepository();
    const existing = await repo.getMember(req.params.id, req.params.userId);
    if (!existing) { sendJson(res, 404, { error: 'Member not found' }); return; }

    await repo.updateMember(req.params.id, req.params.userId, role);

    emit(req.params.id, { type: 'member.updated', userId: req.params.userId, role });
    sendJson(res, 200, { ok: true });
  });

  // DELETE /api/projects/:id/members/:userId
  router.delete('/api/projects/:id/members/:userId', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!await requireOwner(req, res, req.params.id)) return;

    const repo = getProjectRepository();

    // Prevent owner from removing themselves if they are the last owner
    const ownerCount = await repo.countOwners(req.params.id);
    if (
      req.params.userId === req.user!.id &&
      ownerCount <= 1
    ) {
      sendJson(res, 400, { error: 'Cannot remove the last owner' });
      return;
    }

    const removed = await repo.removeMember(req.params.id, req.params.userId);
    if (!removed) { sendJson(res, 404, { error: 'Member not found' }); return; }

    emit(req.params.id, { type: 'member.removed', userId: req.params.userId });
    sendJson(res, 200, { ok: true });
  });

  // GET /api/projects/:id/events  (SSE)
  router.sse('/api/projects/:id/events', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }
    const project = await requireMember(req, res, req.params.id);
    if (!project) return;
    subscribe(req.params.id, res);
  });
}
