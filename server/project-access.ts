/**
 * Project lookups that work on both SQLite and DynamoDB (via the projects repository).
 * Use these instead of raw `SELECT ... FROM projects / project_members` queries.
 */
import { getProjectRepository } from './repositories/projects.ts';
import type { ProjectMemberRecord } from './repositories/projects.ts';

/** The user's membership record for a project, or null if they are not a member. */
export async function getMembership(projectId: string, userId: string): Promise<ProjectMemberRecord | null> {
  return getProjectRepository().getMember(projectId, userId);
}

/** The project's slug (used to locate its folder on disk), or null if the project does not exist. */
export async function getProjectSlug(projectId: string): Promise<string | null> {
  const p = await getProjectRepository().getProjectById(projectId);
  return p ? p.slug : null;
}
