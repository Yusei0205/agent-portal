---
title: Agent Coordination Notes
version: 1
---

## Agent Coordination Notes

This skill enables in-run and cross-run coordination between agents by writing structured notes to a shared location.

### On start

1. Create the `.agent-notes/` directory in your work folder if it does not already exist.
2. Read all files at `docs/md/.agent-notes-previous/` — these are notes carried forward from the previous run of this workflow and contain findings, blockers, and recommendations from prior sessions.
3. Read all files at `.agent-notes/*.md` — these are notes written by other agents earlier in this run. Review them before beginning your own work so you can avoid duplicating effort, act on blockers, and build on findings already recorded.

### As you work

Write findings progressively to `.agent-notes/<your-agent-name>.md` (for example `.agent-notes/security-reviewer.md`). Update the file after each significant step rather than waiting until the end.

Use this structure:

```markdown
# Agent Notes: <Agent Name>
Run: <ISO 8601 date>

## Findings
<What you discovered, with file paths and line numbers where relevant.>

## Blockers
<Issues that prevent progress or that another agent must resolve first.>

## Recommendations
<Suggested next actions, trade-offs, or things the lead should know.>
```

### Periodically

Before each major step, re-read the other agents' notes files at `.agent-notes/*.md`. Other agents may have written findings that affect your work or resolved blockers you were waiting on.

### Format rules

- Start every notes file with `# Agent Notes: <Agent Name>
Run: <date>` then the sections above.
- Keep entries concise and concrete — file paths, function names, line numbers, exact error messages.
- Do not include secrets, credentials, or personal data in your notes.
- Sections with no content may be omitted, but always include at least `## Findings`.
