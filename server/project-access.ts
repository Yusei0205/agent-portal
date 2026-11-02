/**
 * Project lookups that work on both SQLite and DynamoDB (via the projects repository).
 * Use these instead of raw `SELECT ... FROM projects / project_members` queries.
 */
import { getProjectRepository } from './repositories/projects.ts';
import type { ProjectMemberRecord } from './repositories/projects.ts';
import type { Row } from './db.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';

/** The user's membership record for a project, or null if they are not a member. */
export async function getMembership(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
  return getProjectRepository().getMember(projectId, userId);
}

/** The project's slug (used to locate its folder on disk), or null if the project does not exist. */
export async function getProjectSlug(projectId: string): Promise<string | null> {
  const p = await getProjectRepository().getProjectById(projectId);
  return p ? p.slug : null;
}

/** The project as a plain row (same shape the old SQLite queries returned), or undefined if missing/archived. */
export async function getProjectRow(projectId: string): Promise<Row | undefined> {
  const p = await getProjectRepository().getProjectById(projectId);
  return p ? (p as unknown as Row) : undefined;
}

/** The user's membership as a plain row, or undefined when they are not a member. */
export async function getMemberRow(projectId: string, userId: string): Promise<Row | undefined> {
  const m = await getProjectRepository().getMember(projectId, userId);
  return m ? (m as unknown as Row) : undefined;
}

/** A session (workflow) as a plain row, or undefined if it does not exist. */
export async function getWorkflowRow(workflowId: string): Promise<Row | undefined> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  return w ? (w as unknown as Row) : undefined;
}

/** The newest run of a session as a plain row, or undefined. */
export async function getLatestRunRow(workflowId: string): Promise<Row | undefined> {
  const r = await getSessionsRepository().getLatestRun(workflowId);
  return r ? (r as unknown as Row) : undefined;
}

/** A repository connection record as a plain row, or undefined. */
export async function getRepoRow(repoId: string): Promise<Row | undefined> {
  const r = await getGitReposRepository().getById(repoId);
  return r ? (r as unknown as Row) : undefined;
}

/** A repository connection record (typed), or undefined. */
export async function getRepoInfo(repoId: string) {
  return (await getGitReposRepository().getById(repoId)) ?? undefined;
}
