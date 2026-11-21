/**
 * Tells a run that has repositories to use the repository's agent skills instead of reading everything.
 *
 * A repository can carry `agent/skills/INDEX.md` and one `agent/skills/<feature>/SKILL.md` per feature (built from the
 * Repositories tab, "Sync docs & skills"). The line added here works with or without them: when they do not exist the
 * agent just carries on as before.
 */

export const SKILLS_GUIDANCE = [
  'Repository skills: if a repository has agent/skills/INDEX.md, read that file first.',
  'It lists one skill per feature. Open only the skill (agent/skills/<feature>/SKILL.md) for the feature you are working on, then open just the files and functions it points to, instead of reading the whole repository.',
  'If a skill disagrees with the code, trust the code and say so in your final report.',
  'Code graph: if a repository has graphify-out/graph.json and the graphify command exists, run it from inside that repository before searching: graphify query "<question>" finds the relevant files and functions, graphify path "A" "B" shows how two things connect, graphify explain "X" describes one function or class and what it touches. Open only the files it points to. If the graph is missing or does not help, search as usual.',
].join(' ');

/** The prompt, with the skills guidance added when the run has repositories. */
export function withSkillsGuidance(prompt: string, hasRepos: boolean): string {
  if (!hasRepos) return prompt;
  return `${prompt}\n\n${SKILLS_GUIDANCE}`;
}
