/**
 * Builds the repository list sent to an AgentCore runner (see runner-repos.ts): for each repository attached to
 * the session, its HTTPS URL, default branch and the git authentication settings for its connection.
 */

import { getGitReposRepository } from '../repositories/git-repos.ts';
import { _getCloneEnv } from '../repos.ts';
import type { RunnerRepo } from './runner-repos.ts';

const GIT_ENV_KEY = /^(GIT_TERMINAL_PROMPT|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d{1,2}|GIT_CONFIG_VALUE_\d{1,2})$/;

/** The folder under repos/ a repository is cloned into (the prompts must name exactly this). */
export function runnerRepoFolder(repoName: string): string {
  return String(repoName ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 100) || 'repo';
}

export async function buildRunnerRepos(
  repoIds: string[],
  projectId: string | null,
  notify: (text: string) => void,
): Promise<RunnerRepo[]> {
  if (!repoIds.length || !projectId) return [];
  const out: RunnerRepo[] = [];
  const used = new Set<string>();

  for (const id of repoIds) {
    const repo = await getGitReposRepository().getById(id);
    if (!repo || String(repo.project_id) !== projectId) continue;

    const url = String(repo.url ?? '');
    if (!url.startsWith('https://')) {
      notify(`Repository "${repo.name}" uses a ${url.startsWith('git@') || url.startsWith('ssh:') ? 'ssh' : 'non-https'} address, which cloud runs cannot clone; the session started without it.`);
      continue;
    }

    let name = runnerRepoFolder(String(repo.name ?? ''));
    while (used.has(name)) name = `${name}_`;
    used.add(name);

    let env: Record<string, string> = {};
    try {
      const full = await _getCloneEnv(repo as never);
      env = Object.fromEntries(Object.entries(full).filter(([k, v]) => GIT_ENV_KEY.test(k) && typeof v === 'string'));
    } catch {
      notify(`Could not prepare access to repository "${repo.name}"; trying without sign-in.`);
    }

    out.push({
      name,
      url,
      ...(repo.default_branch ? { branch: String(repo.default_branch) } : {}),
      env,
    });
  }
  return out;
}
