/**
 * Bundled Superpowers skill content.
 * Each export is the Markdown content for a SKILL.md file.
 */

export const SUPERPOWERS_BOOTSTRAP = `# Superpowers Bootstrap
Before every response: scan all skills, identify which are relevant, load and apply them.
`;

export const SUPERPOWERS_BRAINSTORMING = `# Brainstorming
Generate diverse ideas before narrowing. Challenge assumptions. Use analogies from other domains.
`;

export const SUPERPOWERS_WRITING_PLANS = `# Writing Plans
Before complex tasks: write a numbered plan with clear steps. State assumptions explicitly.
`;

export const SUPERPOWERS_EXECUTING_PLANS = `# Executing Plans
Follow the plan step by step. Mark each step done. Stop and re-plan if blocked.
`;

export const SUPERPOWERS_SUBAGENT_DRIVEN_DEVELOPMENT = `# Subagent-Driven Development
Delegate independent subtasks to subagents. Aggregate results. Review before finalising.
`;

export const SUPERPOWERS_TDD = `# TDD
Write failing tests first. Implement minimum code to pass. Refactor. Never skip the failing step.
`;

export const SUPERPOWERS_SYSTEMATIC_DEBUGGING = `# Systematic Debugging
Read the error fully. Form a hypothesis. Test it. Don't guess — verify.
`;

export const SUPERPOWERS_CODE_REVIEW = `# Code Review
Check: correctness, security, performance, readability, tests. Be specific and actionable.
`;

export const SUPERPOWERS_FINISH_BRANCH = `# Finish Branch
Before pushing: run tests, check linting, update docs, write a clear commit message, review diff.
`;

export interface SkillEntry {
  name: string;
  content: string;
}

export const SUPERPOWERS_SKILLS: SkillEntry[] = [
  { name: 'superpowers-bootstrap', content: SUPERPOWERS_BOOTSTRAP },
  { name: 'superpowers-brainstorming', content: SUPERPOWERS_BRAINSTORMING },
  { name: 'superpowers-writing-plans', content: SUPERPOWERS_WRITING_PLANS },
  { name: 'superpowers-executing-plans', content: SUPERPOWERS_EXECUTING_PLANS },
  { name: 'superpowers-subagent-driven-development', content: SUPERPOWERS_SUBAGENT_DRIVEN_DEVELOPMENT },
  { name: 'superpowers-tdd', content: SUPERPOWERS_TDD },
  { name: 'superpowers-systematic-debugging', content: SUPERPOWERS_SYSTEMATIC_DEBUGGING },
  { name: 'superpowers-code-review', content: SUPERPOWERS_CODE_REVIEW },
  { name: 'superpowers-finish-branch', content: SUPERPOWERS_FINISH_BRANCH },
];
