/**
 * What a Create run reads: the repositories and project documents a person chose.
 *
 * Repositories go to the runner the way a session's repositories do (the workflow's repo_ids); project
 * documents are staged as Markdown under docs/md/ in the run's work folder, from where they travel to the
 * runner with the other staged files (attachments/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from './util.ts';
import { config } from './config.ts';
import { restoreFile } from './durable-files.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { getKnowledgeRepository } from './repositories/knowledge.ts';
import type { DocPromptRepo } from './generated-doc-text.ts';

export interface DocSources {
  repoIds?: string[];
  docIds?: string[];
  diagramIds?: string[];
}

const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The chosen repositories, checked to belong to the project, as the prompt names them. */
export async function repoContext(projectId: string, repoIds: string[] | undefined, max: number): Promise<{ repoIds: string[]; promptRepos: DocPromptRepo[] }> {
  const ids = [...new Set((repoIds ?? []).map(String))];
  if (ids.length > max) throw badRequest(`Pick at most ${max} repositories`);
  const promptRepos: DocPromptRepo[] = [];
  for (const id of ids) {
    const r = (await getGitReposRepository().getById(id)) as unknown as { name: string; project_id?: string; default_branch?: string } | null;
    if (!r || (r.project_id && r.project_id !== projectId)) throw badRequest('A chosen repository is not in this project');
    promptRepos.push({ name: r.name, slug: slugOf(r.name), branch: r.default_branch ?? 'main' });
  }
  return { repoIds: ids, promptRepos };
}

/** Copy the chosen project documents (their Markdown) into `workDir/docs/md/`. Returns how many were staged. */
export async function stageKnowledgeDocs(projectId: string, projectSlug: string, docIds: string[] | undefined, workDir: string): Promise<number> {
  const ids = [...new Set((docIds ?? []).map(String))];
  if (!ids.length) return 0;
  const dest = path.join(workDir, 'docs', 'md');
  await fs.promises.mkdir(dest, { recursive: true });
  let staged = 0;
  for (const id of ids) {
    const doc = await getKnowledgeRepository().getDocById(id);
    if (!doc || doc.project_id !== projectId) throw badRequest('A chosen project document is not in this project');
    if (doc.status !== 'ready') continue;
    const src = path.join(config.dataDir, 'projects', projectSlug, 'docs', 'md', `${doc.id}.md`);
    if (!(await restoreFile(src))) continue;
    // Named after the original file so the agent (and its citations) read something meaningful.
    const base = path.basename(doc.original_name || doc.name || doc.id).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.[A-Za-z0-9]{1,5}$/, '');
    await fs.promises.copyFile(src, path.join(dest, `${base || doc.id}-${doc.id.slice(0, 6)}.md`));
    staged++;
  }
  return staged;
}
