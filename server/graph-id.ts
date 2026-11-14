/**
 * Which code graph a repository's branch has.
 *
 * A repository can have a graph per branch. A graph is named by an id: the repository's id for a repository without a branch
 * (and for the graphs built before branches were told apart), or `<repoId>@<branch>` with `/` written as `~` (git does not
 * allow `~` in a branch name, so the name can be read back).
 */

/** The same rule the runner applies to repo.branch (see agent/runner-repos.ts). */
export function validBranch(branch: unknown): branch is string {
  return typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) && !branch.includes('..');
}

/** The id of the graph of one branch ('' or none: the repository's own, un-branched graph). */
export function graphIdFor(repoId: string, branch?: string | null): string {
  return branch ? `${repoId}@${branch.replace(/\//g, '~')}` : repoId;
}

export function parseGraphId(id: string): { repoId: string; branch: string } {
  const at = id.indexOf('@');
  if (at < 0) return { repoId: id, branch: '' };
  return { repoId: id.slice(0, at), branch: id.slice(at + 1).replace(/~/g, '/') };
}

/** A file or object name stem for a graph id that cannot collide: the repository, then the branch as base64url. */
export function graphStem(id: string): { repo: string; branch: string | null } {
  const p = parseGraphId(id);
  return { repo: p.repoId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120), branch: p.branch ? Buffer.from(p.branch, 'utf8').toString('base64url') : null };
}
