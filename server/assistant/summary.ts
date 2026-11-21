/**
 * Live project summary for the cat assistant: counts and the latest pipeline runs only. No session titles, prompts,
 * transcripts or file names. Each source is read on its own, so one failing source leaves its field at 0 / empty.
 */

import { getProjectRepository } from '../repositories/projects.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getInboxRepository } from '../repositories/inbox.ts';
import { getPipelineRunsRepository } from '../repositories/pipeline-runs.ts';
import type { ProjectSummary } from './prompt.ts';

const MAX_PIPELINES = 5;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

async function countByStatus(projectId: string, status: string): Promise<number> {
  const r = await getSessionsRepository().listWorkflowsByProject(projectId, { status, limit: 200 });
  return r.total ?? r.workflows.length;
}

export async function buildSummary(projectId: string): Promise<ProjectSummary | null> {
  const project = await getProjectRepository().getProjectById(projectId);
  if (!project) return null;
  const [running, failed, blocked, inbox, pipelines] = await Promise.all([
    safe(() => countByStatus(projectId, 'running'), 0),
    safe(() => countByStatus(projectId, 'failed'), 0),
    safe(() => countByStatus(projectId, 'blocked'), 0),
    safe(() => getInboxRepository().countUnresolvedByProjects([projectId]), 0),
    safe(async () => {
      const runs = await getPipelineRunsRepository().latestPerBranch(projectId);
      return runs
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
        .slice(0, MAX_PIPELINES)
        .map((r) => ({ repo: r.repo_full_name, workflow: r.workflow_name, branch: r.branch, status: r.status as string }));
    }, [] as ProjectSummary['pipelines']),
  ]);
  return { name: project.name, running, failed, blocked, inbox, pipelines };
}
