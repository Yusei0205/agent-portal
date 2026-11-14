---
inclusion: always
---

# Git and file safety

Several agent sessions may work on this repo. On 2026-10-31 a `git stash` + reset during a test run wiped 81 uncommitted files, and a PowerShell restore wrote them back double-encoded. These rules prevent a repeat.

## One working copy per agent session

- Each agent session works in its own git worktree, never in another session's folder.
- Before starting, check you are not in the main working copy of another active session. If unsure, ask the user.
- Create a worktree for a new session (ask the user for approval first):
  ```sh
  git worktree add ../agent-portal-<task> -b <branch-name>
  ```
- Subagents delegated by one session share that session's worktree. That is fine because the lead coordinates them.
- Never edit files in another worktree.

## Commands that need the user's explicit permission

Ask the user and wait for a yes before running any of these. Say what it will change and why.

- `git stash` (any form), `git reset`, `git checkout -- <path>`, `git restore`, `git clean`
- `git rebase`, `git commit --amend`, `git push --force`, branch deletion
- Deleting or overwriting files you did not create in this task

To find out whether a test failure already existed before your change, do NOT stash. Instead:
- check the run record (`npm run test:affected -- --dry-run`, `test/known-failures.json`), or
- run the test in a separate worktree at `HEAD`, or
- report it as "possibly pre-existing" and let the user decide.

## Writing files

- Write and edit source files only with the file edit/write tools.
- Never write source files with PowerShell `Set-Content`, `Out-File`, `Add-Content`, or `>` / `>>` redirection. On Windows PowerShell 5.1 these add a UTF-8 BOM and double-encode non-ASCII characters (`─` becomes `ΓöÇ`).
- Shell redirection is fine for temporary files outside the repo (for example `$env:TEMP`).

## Before you finish

- Run `git status` and confirm only the files you meant to change are modified.
- Do not commit unless the user asks.
