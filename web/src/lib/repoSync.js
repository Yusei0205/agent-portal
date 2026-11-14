/**
 * The task given to an agent to bring a repository's documentation and its agent skills up to date with the code.
 *
 * Skills live in the repository itself, in `agent/skills/`, a tool-neutral place that Claude, Kiro, Codex and others
 * can all read. One skill per feature lets an agent open just the feature it is working on instead of the whole repo.
 * `agent/skills/.sync.json` remembers the commit the skills were last built from, so a later sync only has to look at
 * what changed since then.
 */

export const SKILLS_DIR = 'agent/skills';

/** @param {{ repoName: string, branch: string, docs?: boolean }} o */
export function syncGoal({ repoName, branch, docs = true }) {
  const lines = [
    `Bring the agent skills${docs ? ' and the documentation' : ''} of the repository "${repoName}" up to date with the code on branch ${branch}.`,
    `First check out ${branch} (git fetch, then git checkout ${branch}) and work from its latest commit.`,
    '',
    `## Where things go`,
    `- Skills live in ${SKILLS_DIR}/ (a neutral folder: do not use .claude/, .kiro/ or .codex/).`,
    `- ${SKILLS_DIR}/INDEX.md: one short line per feature (name, what it does, link to its skill). An agent reads only this first.`,
    `- ${SKILLS_DIR}/<feature>/SKILL.md: one file per feature, starting with front matter (name, description, built_from_commit), then:`,
    `  what the feature does; its key files and functions with line ranges (so a reader can open just those lines); its API routes or entry points;`,
    `  how data flows through it; gotchas; which tests cover it and how to run them.`,
    `- ${SKILLS_DIR}/.sync.json: {"commit": "<the commit you built from>", "branch": "${branch}", "updated": "<ISO time>"}.`,
    '',
    `## How to decide what to do`,
    `1. If ${SKILLS_DIR}/.sync.json exists, this is an UPDATE: run git diff --name-only <commit in .sync.json>..HEAD. Rebuild only the skills whose files appear in that list,`,
    `   add skills for new features, delete skills for features that no longer exist, and fix INDEX.md. Do not rewrite skills nothing touched.`,
    `   (If that commit is not in the history, treat it as a full build.)`,
    `2. If it does not exist, this is a FULL BUILD: find the repository's features (use its folder structure, README, route and module lists, and any test map),`,
    `   keep to roughly 5 to 25 features, and write one skill each.`,
    `3. Every file path, function name and line range you write must be checked against the code. Do not guess. Prefer function names to line numbers when they would go stale.`,
    '',
    `## Make every tool find the skills`,
    `Make sure AGENTS.md in the repository root has a short section "Agent skills" that says: read ${SKILLS_DIR}/INDEX.md first, then open only the skill for the feature you need.`,
    `Create AGENTS.md if it is missing. If CLAUDE.md exists, add one line to it that points to AGENTS.md. Do not duplicate the skills' content in either file.`,
  ];
  if (docs) {
    lines.push(
      '',
      `## Documentation`,
      `Update the existing documentation (README and docs/) only where the changed code makes it wrong or incomplete, using the same diff. Do not restyle pages nothing touched.`,
      `Keep the documentation and the skills consistent with each other.`,
    );
  }
  lines.push(
    '',
    `## Finish`,
    `Commit the changes with a clear message on a new branch named docs/skills-sync from ${branch}, and open a pull request into ${branch}. Do not push to ${branch} directly.`,
    `End with a short report: the commit you built from, the skills added, changed and removed, and anything you could not verify.`,
  );
  return lines.join('\n');
}
