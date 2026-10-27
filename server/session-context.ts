/**
 * Session context assembly — builds the agent's view of the project.
 *
 * buildSessionContext() gathers everything the agent needs before a run:
 * CLAUDE.md content, repository list, skill names, vault file list.
 */

import fs from 'node:fs';
import path from 'node:path';
import { all, one } from './db.ts';
import type { Row } from './db.ts';
import { config } from './config.ts';

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
export function buildSessionContext(
  workflowRow: Row,
  projectRow: Row,
): SessionContext {
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
    const r = one<Row>('SELECT * FROM repositories WHERE id = ?', rid);
    if (r) {
      repos.push({
        id: String(r.id),
        name: String(r.name),
        url: String(r.url),
        default_branch: r.default_branch ? String(r.default_branch) : null,
      });
    }
  }

  // Skills under .claude/skills/
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
