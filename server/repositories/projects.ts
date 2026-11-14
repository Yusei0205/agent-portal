/**
 * Repository interface for projects, project_members, teams, and team_members.
 *
 * Covers access patterns E1–E6 from the data design doc.
 *
 * Fast membership API (used on most authenticated requests):
 *   isMember(projectId, userId)       — single cheap lookup
 *   roleOf(projectId, userId)         — returns role string or null
 *   listMyProjects(userId)            — user's project list
 *
 * All methods are async so both SQLite and DynamoDB implementations satisfy
 * the same contract.
 */

import { SqliteProjectRepository } from './projects-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Errors ────────────────────────────────────────────────────────────────────

/** Thrown by createProject when the slug is already in use. */
export class SlugAlreadyTakenError extends Error {
  constructor() {
    super('A project with this slug already exists');
    this.name = 'SlugAlreadyTakenError';
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  notes: string;
  created_by: string | null;
  created_at: string;
  archived: number;
  default_lead_agent: string;
  default_model: string;
  monthly_budget_usd: number | null;
  team_id: string | null;
  vault_generated: number;
}

export interface ProjectMemberRecord {
  project_id: string;
  user_id: string;
  access: string;
  role: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  description: string;
  monthly_budget_usd: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberRecord {
  team_id: string;
  user_id: string;
  role: string;
}

export interface CreateProjectInput {
  id: string;
  slug: string;
  name: string;
  description: string;
  notes: string;
  created_by: string | null;
  created_at: string;
  archived: number;
  default_lead_agent: string;
  default_model: string;
  monthly_budget_usd?: number | null;
  team_id?: string | null;
  vault_generated: number;
}

export interface CreateTeamInput {
  id: string;
  name: string;
  description: string;
  monthly_budget_usd: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface ProjectRepository {
  // ── Projects ──────────────────────────────────────────────────────────────

  /**
   * List non-archived projects ordered by created_at DESC.
   * In DynamoDB this is served from the PROJECT_INDEX sentinel partition.
   */
  listProjects(): Promise<ProjectRecord[]>;

  /**
   * List all slugs in use (for duplicate-slug prevention on create).
   * SQLite: SELECT slug FROM projects.
   * DynamoDB: Query PROJECT_INDEX, collect slug attributes.
   */
  getAllSlugs(): Promise<string[]>;

  /** Get a project by its primary key. Returns null if not found or archived. */
  getProjectById(id: string): Promise<ProjectRecord | null>;

  /** Get a project by its slug. Returns null if not found. */
  getProjectBySlug(slug: string): Promise<ProjectRecord | null>;

  /**
   * Create a new project.
   * Atomically reserves the slug so concurrent creates with the same slug fail.
   * Throws SlugAlreadyTakenError when the slug is already in use.
   */
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;

  /**
   * Atomically create a new project and add the specified user as owner.
   * SQLite: single transaction. DynamoDB: single TransactWriteItems (4 items).
   * Throws SlugAlreadyTakenError when the slug is already in use.
   */
  createProjectWithOwner(input: CreateProjectInput, ownerId: string): Promise<ProjectRecord>;

  /**
   * Apply a partial update to project fields (name, description, etc.).
   * Returns the updated project or null when the project does not exist.
   */
  updateProject(
    id: string,
    patch: Record<string, string | number | null>,
  ): Promise<ProjectRecord | null>;

  /**
   * Archive (soft-delete) a project.
   * DynamoDB: sets archived=1 on the META item and removes it from PROJECT_INDEX.
   */
  archiveProject(id: string): Promise<void>;

  // ── Members ───────────────────────────────────────────────────────────────

  /** Get the membership record for one user in one project. Returns null when absent. */
  getMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null>;

  /** Add a user as a project member. No-op if they are already a member. */
  addMember(projectId: string, userId: string, role: string): Promise<void>;

  /** Update an existing member's role. No-op if the member does not exist. */
  updateMember(projectId: string, userId: string, role: string): Promise<void>;

  /**
   * Remove a member.
   * Returns true when the row was deleted, false when the member was not found.
   */
  removeMember(projectId: string, userId: string): Promise<boolean>;

  /**
   * List all members for a project.
   * Does NOT include user name/email — callers that need those should batch-get
   * users from the auth repository.
   */
  listMembers(projectId: string): Promise<ProjectMemberRecord[]>;

  /** Count project members. */
  countMembers(projectId: string): Promise<number>;

  /** Count project members with role='owner'. */
  countOwners(projectId: string): Promise<number>;

  // ── Fast membership API ───────────────────────────────────────────────────

  /**
   * Returns true when the user is a member of the project.
   * Never fails open — throws on I/O error.
   */
  isMember(projectId: string, userId: string): Promise<boolean>;

  /**
   * Returns the role of the user in the project, or null when not a member.
   * Never fails open — throws on I/O error.
   */
  roleOf(projectId: string, userId: string): Promise<string | null>;

  /**
   * List all non-archived projects the user is a member of, ordered by created_at DESC.
   * DynamoDB: Query GSI-UserProjects then BatchGet META items.
   */
  listMyProjects(userId: string): Promise<ProjectRecord[]>;

  // ── Teams ─────────────────────────────────────────────────────────────────

  /** List all teams ordered by created_at ASC. */
  listTeams(): Promise<TeamRecord[]>;

  /** Get a team by ID. Returns null when not found. */
  getTeamById(id: string): Promise<TeamRecord | null>;

  /** Create a team. */
  createTeam(input: CreateTeamInput): Promise<TeamRecord>;

  /** Apply a partial update to team fields. */
  updateTeam(id: string, patch: Record<string, string | number | null>): Promise<void>;

  /** Delete a team (cascades to team_members). */
  deleteTeam(id: string): Promise<void>;

  // ── Team members ──────────────────────────────────────────────────────────

  /** Add a user to a team. No-op if already a member. */
  addTeamMember(teamId: string, userId: string, role: string): Promise<void>;

  /** Update a team member's role. */
  updateTeamMember(teamId: string, userId: string, role: string): Promise<void>;

  /** Remove a user from a team. No-op if not a member. */
  removeTeamMember(teamId: string, userId: string): Promise<void>;

  /** List all members of a team. */
  listTeamMembers(teamId: string): Promise<TeamMemberRecord[]>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: ProjectRepository | null = null;

/** Initialise the singleton. Call once at server startup. Idempotent. */
export async function initProjectRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbProjectRepository } = await import('./projects-dynamodb.ts');
    _instance = new DynamoDbProjectRepository();
  } else {
    _instance = new SqliteProjectRepository();
  }
}

/** Return the singleton. Falls back to SQLite init if not yet initialised. */
export function getProjectRepository(): ProjectRepository {
  if (_instance) return _instance;
  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB project repository was not initialised. ' +
        'Call await initProjectRepository() at server startup.',
    );
  }
  _instance = new SqliteProjectRepository();
  return _instance;
}

export function setProjectRepository(repo: ProjectRepository): void { _instance = repo; }
export function clearProjectRepository(): void { _instance = null; }
