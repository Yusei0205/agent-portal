/**
 * SQLite implementation of ProjectRepository.
 *
 * Wraps synchronous node:sqlite helpers in Promise.resolve().
 * All SQL for projects, project_members, teams, and team_members lives here.
 */

import { one, all, run as dbRun, insert, tx } from '../db.ts';
import type { Row } from '../db.ts';
import type {
  ProjectRepository,
  ProjectRecord,
  ProjectMemberRecord,
  TeamRecord,
  TeamMemberRecord,
  CreateProjectInput,
  CreateTeamInput,
} from './projects.ts';
import { SlugAlreadyTakenError } from './projects.ts';

// ── Row converters ────────────────────────────────────────────────────────────

function toProject(row: Row): ProjectRecord {
  return {
    id:                String(row.id),
    slug:              String(row.slug),
    name:              String(row.name),
    description:       String(row.description ?? ''),
    notes:             String(row.notes ?? ''),
    created_by:        row.created_by != null ? String(row.created_by) : null,
    created_at:        String(row.created_at),
    archived:          Number(row.archived ?? 0),
    default_lead_agent: String(row.default_lead_agent ?? ''),
    default_model:     String(row.default_model ?? ''),
    monthly_budget_usd: row.monthly_budget_usd != null ? Number(row.monthly_budget_usd) : null,
    team_id:           row.team_id != null ? String(row.team_id) : null,
    vault_generated:   Number(row.vault_generated ?? 1),
  };
}

function toMember(row: Row): ProjectMemberRecord {
  return {
    project_id: String(row.project_id),
    user_id:    String(row.user_id),
    access:     String(row.access ?? ''),
    role:       String(row.role ?? ''),
  };
}

function toTeam(row: Row): TeamRecord {
  return {
    id:                String(row.id),
    name:              String(row.name),
    description:       String(row.description ?? ''),
    monthly_budget_usd: row.monthly_budget_usd != null ? Number(row.monthly_budget_usd) : null,
    created_by:        row.created_by != null ? String(row.created_by) : null,
    created_at:        String(row.created_at),
    updated_at:        String(row.updated_at),
  };
}

function toTeamMember(row: Row): TeamMemberRecord {
  return {
    team_id: String(row.team_id),
    user_id: String(row.user_id),
    role:    String(row.role ?? 'member'),
  };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteProjectRepository implements ProjectRepository {
  // ── Projects ───────────────────────────────────────────────────────────────

  async listProjects(): Promise<ProjectRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC',
    );
    return rows.map(toProject);
  }

  async getAllSlugs(): Promise<string[]> {
    const rows = all<{ slug: string }>('SELECT slug FROM projects');
    return rows.map((r) => r.slug);
  }

  async getProjectById(id: string): Promise<ProjectRecord | null> {
    const row = one<Row>('SELECT * FROM projects WHERE id = ?', id);
    return row ? toProject(row) : null;
  }

  async getProjectBySlug(slug: string): Promise<ProjectRecord | null> {
    const row = one<Row>('SELECT * FROM projects WHERE slug = ?', slug);
    return row ? toProject(row) : null;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    try {
      insert('projects', {
        id:                input.id,
        slug:              input.slug,
        name:              input.name,
        description:       input.description,
        notes:             input.notes,
        created_by:        input.created_by,
        created_at:        input.created_at,
        archived:          input.archived,
        default_lead_agent: input.default_lead_agent,
        default_model:     input.default_model,
        monthly_budget_usd: input.monthly_budget_usd ?? null,
        team_id:           input.team_id ?? null,
        vault_generated:   input.vault_generated,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE constraint failed: projects.slug')) {
        throw new SlugAlreadyTakenError();
      }
      throw e;
    }
    const row = one<Row>('SELECT * FROM projects WHERE id = ?', input.id);
    return toProject(row!);
  }

  async createProjectWithOwner(input: CreateProjectInput, ownerId: string): Promise<ProjectRecord> {
    return Promise.resolve(
      tx(() => {
        try {
          insert('projects', {
            id:                input.id,
            slug:              input.slug,
            name:              input.name,
            description:       input.description,
            notes:             input.notes,
            created_by:        input.created_by,
            created_at:        input.created_at,
            archived:          input.archived,
            default_lead_agent: input.default_lead_agent,
            default_model:     input.default_model,
            monthly_budget_usd: input.monthly_budget_usd ?? null,
            team_id:           input.team_id ?? null,
            vault_generated:   input.vault_generated,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('UNIQUE constraint failed: projects.slug')) {
            throw new SlugAlreadyTakenError();
          }
          throw e;
        }
        const existing = one<Row>(
          'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
          input.id,
          ownerId,
        );
        if (!existing) {
          insert('project_members', {
            project_id: input.id,
            user_id:    ownerId,
            access:     'owner',
            role:       'owner',
          });
        }
        const row = one<Row>('SELECT * FROM projects WHERE id = ?', input.id);
        return toProject(row!);
      }),
    );
  }

  async updateProject(
    id: string,
    patch: Record<string, string | number | null>,
  ): Promise<ProjectRecord | null> {
    if (Object.keys(patch).length === 0) {
      return this.getProjectById(id);
    }
    const keys = Object.keys(patch);
    dbRun(
      `UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string),
      id,
    );
    return this.getProjectById(id);
  }

  async archiveProject(id: string): Promise<void> {
    dbRun('UPDATE projects SET archived = 1 WHERE id = ?', id);
  }

  // ── Members ────────────────────────────────────────────────────────────────

  async getMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
    const row = one<Row>(
      'SELECT * FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId,
    );
    return row ? toMember(row) : null;
  }

  async addMember(projectId: string, userId: string, role: string): Promise<void> {
    const existing = one<Row>(
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId,
    );
    if (existing) return;
    insert('project_members', {
      project_id: projectId,
      user_id:    userId,
      access:     role,
      role,
    });
  }

  async updateMember(projectId: string, userId: string, role: string): Promise<void> {
    dbRun(
      'UPDATE project_members SET role = ?, access = ? WHERE project_id = ? AND user_id = ?',
      role,
      role,
      projectId,
      userId,
    );
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const result = dbRun(
      'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId,
    );
    return result.changes > 0;
  }

  async listMembers(projectId: string): Promise<ProjectMemberRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM project_members WHERE project_id = ?',
      projectId,
    );
    return rows.map(toMember);
  }

  async countMembers(projectId: string): Promise<number> {
    const row = one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?',
      projectId,
    );
    return Number(row?.n ?? 0);
  }

  async countOwners(projectId: string): Promise<number> {
    const row = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'owner'",
      projectId,
    );
    return Number(row?.n ?? 0);
  }

  // ── Fast membership API ────────────────────────────────────────────────────

  async isMember(projectId: string, userId: string): Promise<boolean> {
    const row = one<Row>(
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId,
    );
    return row != null;
  }

  async roleOf(projectId: string, userId: string): Promise<string | null> {
    const row = one<{ role: string }>(
      'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId,
    );
    return row ? row.role : null;
  }

  async listMyProjects(userId: string): Promise<ProjectRecord[]> {
    const rows = all<Row>(
      `SELECT p.* FROM projects p
         JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
        WHERE p.archived = 0
        ORDER BY p.created_at DESC`,
      userId,
    );
    return rows.map(toProject);
  }

  // ── Teams ──────────────────────────────────────────────────────────────────

  async listTeams(): Promise<TeamRecord[]> {
    const rows = all<Row>('SELECT * FROM teams ORDER BY created_at ASC');
    return rows.map(toTeam);
  }

  async getTeamById(id: string): Promise<TeamRecord | null> {
    const row = one<Row>('SELECT * FROM teams WHERE id = ?', id);
    return row ? toTeam(row) : null;
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    insert('teams', {
      id:                input.id,
      name:              input.name,
      description:       input.description,
      monthly_budget_usd: input.monthly_budget_usd,
      created_by:        input.created_by,
      created_at:        input.created_at,
      updated_at:        input.updated_at,
    });
    const row = one<Row>('SELECT * FROM teams WHERE id = ?', input.id);
    return toTeam(row!);
  }

  async updateTeam(id: string, patch: Record<string, string | number | null>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const keys = Object.keys(patch);
    dbRun(
      `UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => patch[k] as string),
      id,
    );
  }

  async deleteTeam(id: string): Promise<void> {
    dbRun('DELETE FROM teams WHERE id = ?', id);
  }

  // ── Team members ───────────────────────────────────────────────────────────

  async addTeamMember(teamId: string, userId: string, role: string): Promise<void> {
    const existing = one<Row>(
      'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?',
      teamId,
      userId,
    );
    if (existing) return;
    insert('team_members', { team_id: teamId, user_id: userId, role });
  }

  async updateTeamMember(teamId: string, userId: string, role: string): Promise<void> {
    dbRun(
      'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?',
      role,
      teamId,
      userId,
    );
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    dbRun(
      'DELETE FROM team_members WHERE team_id = ? AND user_id = ?',
      teamId,
      userId,
    );
  }

  async listTeamMembers(teamId: string): Promise<TeamMemberRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM team_members WHERE team_id = ?',
      teamId,
    );
    return rows.map(toTeamMember);
  }
}
