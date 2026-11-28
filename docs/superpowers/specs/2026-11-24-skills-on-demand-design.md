# Agent skills loaded on demand (Claude)

Date: 2026-11-24. Status: approved by the owner ("Yes", after the best-practice summary), built.

## Intent

Claude agents in portal runs had every listed skill copied into their prompt (portal runs load no settings from disk, so Claude
cannot discover skills itself). The backend engineer carried Python, Java and Node.js at once (about 23,000 characters). Kiro and
Codex already load skills on demand. Follow progressive disclosure: rules always loaded, everything else listed and loaded when
needed.

## Design

- Agent files: `skills:` are preloaded (rules for every task); `on-demand-skills:` are listed in the prompt as an index (name and
  description, server/agent/skill-library.ts `skillIndexSection`). The agent pack preloads `task-delegation`, `maintainable-code`,
  `requirements-clarification` and `agent-notes` (`ALWAYS_LOADED_SKILLS`) and lists the rest.
- `read_skill` (`mcp__portal-skills__read_skill`): an in-process MCP tool serving the run's skill library (every skill in
  `~/.claude/skills` of the run home and the project's `.claude/skills`, later wins; at most 80 skills, 40,000 characters each,
  600,000 in all). The tool policy allows it without asking, also in plan mode (it only returns text the portal supplied). An agent
  limited to some tools gets it added to its list.
- Local runs (server/agent/claude-code.ts) and cloud runs (agent-runner: payload `skillLibrary`) offer it only when an agent lists
  on-demand skills. The portal sends `skillLibrary` only then, so an older runner image (which rejects unknown fields) keeps working
  until it is redeployed.
- Kiro and Codex are unchanged (their engines already load skills on demand). Claude Code outside the portal ignores
  `on-demand-skills:` and finds the skills in `~/.claude/skills` itself.

## Effect

Starting prompt sizes with the pack: backend engineer about 13,000 characters (was about 23,000), frontend 12,300, infra 12,700,
lead 14,700, security 7,300, slides 6,600, tech writer 9,000.
