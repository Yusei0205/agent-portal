/**
 * Session context assembly — builds the agent's view of the project.
 *
 * buildSessionContext() gathers everything the agent needs before a run:
 * CLAUDE.md content, repository list, skill names, vault file list.
 *
 * Routes:
 *   GET /api/workflows/:id/context  — context items for the IDE context panel
 */

import fs from 'node:fs';
import path from 'node:path';
import { all, one } from './db.ts';
import type { Row } from './db.ts';
import { config } from './config.ts';
import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';

import { getMemberRow, getProjectRow, getRepoRow, getWorkflowRow } from './project-access.ts';
import { ensureBundledSkills } from './bundled-skills.ts';
// ── Types ─────────────────────────────────────────────────────────────────────

export interface Repo {
  id: string;
  name: string;
  url: string;
  default_branch: string | null;
}

export interface Skill {
  name: string;
  path: string;
}

export interface VaultFile {
  name: string;
  path: string;
}

export interface SessionContext {
  claudeMd: string;
  repos: Repo[];
  skills: Skill[];
  vaultFiles: VaultFile[];
}

// ── Context assembly ──────────────────────────────────────────────────────────

/**
 * Build the session context for a workflow.
 *
 * @param workflowRow  The p6_workflows row.
 * @param projectRow   The projects row.
 */
export async function buildSessionContext(
  workflowRow: Row,
  projectRow: Row,
): Promise<SessionContext> {
  const dataDir = config.dataDir;
  const slug = String(projectRow.slug ?? '');
  const projectDir = path.join(dataDir, 'projects', slug);

  // CLAUDE.md
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf8')
    : `# ${String(projectRow.name ?? 'Project')}\n`;

  // Repositories for this workflow (p6 repos table)
  const repoIds = parseJsonArray(String(workflowRow.repo_ids ?? '[]'));
  const repos: Repo[] = [];
  for (const rid of repoIds) {
    const r = await getRepoRow(rid);
    if (r) {
      repos.push({
        id: String(r.id),
        name: String(r.name),
        url: String(r.url),
        default_branch: r.default_branch ? String(r.default_branch) : null,
      });
    }
  }

  // Skills under .claude/skills/. Projects made before the bundled skills existed get them the first time a session starts.
  await ensureBundledSkills(projectDir);
  const skillsDir = path.join(projectDir, '.claude', 'skills');
  const skills: Skill[] = [];
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillPath = path.join(skillsDir, entry.name);
        skills.push({ name: entry.name, path: skillPath });
      }
    }
  }

  // Vault files for this project (project-scoped vault)
  const vaultFiles: VaultFile[] = [];
  const projectVaultDir = path.join(dataDir, 'vault', 'projects', String(projectRow.id ?? ''));
  if (fs.existsSync(projectVaultDir)) {
    collectFiles(projectVaultDir, vaultFiles);
  }

  return { claudeMd, repos, skills, vaultFiles };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function collectFiles(dir: string, out: VaultFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push({ name: entry.name, path: full });
    }
  }
}

// ── Context item type (for the IDE Context panel) ─────────────────────────────

export interface ContextItem {
  id: string;
  title: string;
  kind: string;
  body: string;
}

// ── Route registration ────────────────────────────────────────────────────────

/**
 * Access helper — mirrors the pattern in output-files.ts.
 * Returns the workflow row or null (response already sent).
 */
async function requireWorkflowAccess(
  req: PortalRequest,
  res: PortalResponse,
  workflowId: string,
): Promise<Row | null> {
  if (!req.user) {
    sendJson(res, 401, { error: 'Sign in to continue' });
    return null;
  }
  const wf = await getWorkflowRow(workflowId);
  if (!wf) {
    sendJson(res, 404, { error: 'Workflow not found' });
    return null;
  }
  if (req.user.is_admin) return wf;
  if (!wf.project_id) return wf;
  const member = await getMemberRow(wf.project_id as string, req.user.id);
  if (!member) {
    sendJson(res, 403, { error: 'Not a project member' });
    return null;
  }
  return wf;
}

export function registerSessionContextRoutes(): void {
  router.get(
    '/api/workflows/:id/context',
    async (req: PortalRequest, res: PortalResponse): Promise<void> => {
      const wf = await requireWorkflowAccess(req, res, req.params.id);
      if (!wf) return;

      const projectRow = wf.project_id
        ? (await getProjectRow(wf.project_id as string))
        : null;

      if (!projectRow) {
        sendJson(res, 200, { context: [] });
        return;
      }

      const ctx = await buildSessionContext(wf, projectRow);
      const items: ContextItem[] = [];

      if (ctx.claudeMd) {
        items.push({
          id: 'claude-md',
          title: 'CLAUDE.md',
          kind: 'document',
          body: ctx.claudeMd.slice(0, 300),
        });
      }

      for (const repo of ctx.repos) {
        items.push({
          id: `repo-${repo.id}`,
          title: repo.name,
          kind: 'repository',
          body: repo.url,
        });
      }

      for (const skill of ctx.skills) {
        items.push({
          id: `skill-${skill.name}`,
          title: skill.name,
          kind: 'skill',
          body: '',
        });
      }

      for (const vf of ctx.vaultFiles) {
        items.push({
          id: `vault-${vf.name}`,
          title: vf.name,
          kind: 'vault-file',
          body: '',
        });
      }

      sendJson(res, 200, { context: items });
    },
  );
}
