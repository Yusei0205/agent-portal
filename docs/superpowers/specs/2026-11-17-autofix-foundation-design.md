# Auto-fix foundation and auto-fix for user projects (sub-projects A + B)

Date: 2026-11-17
Status: draft for review
Branch: `claude/agent-portal-cdqxa9`

## 1. Context and goal

The portal should find problems on its own, fix them through agents, and keep a human in control of
what ships. The wider programme has five sub-projects, each with its own spec, plan and build:

| # | Sub-project | Scope |
|---|---|---|
| A | Foundation | Findings store, new triggers, autonomy policy, guardrails |
| B | Auto-fix for user projects | CI-failure, review-finding and failed-session fixers |
| C | Self-healing UX | Auto-retry and resume, error recovery, smart defaults, client telemetry |
| D | Self-improving portal | The portal runs loops on its own repo |
| E | Auto-enhance for user projects | Scheduled improvement suggestions |

Recommended order: A, B, C, D, E. **This spec covers A and B only.** C, D and E plug into the same
findings model later through new `source` values.

Success: fewer manual interventions for failing CI, review findings and failed sessions, with no
change reaching a repository without a human merging it.

Decisions already made with the owner:
- Default autonomy is **draft PR**: agents push a branch and open a draft PR, a human merges.
  Auto-merge is not built; the policy field is reserved only.
- **GitHub only.** CodeCommit repositories are excluded from auto-fix.
- Auto-fix is **off until a project enables it**.

## 2. Approach

Extend the existing loop-spec engine (new trigger type, findings repository, autonomy policy). This
reuses the verification pipeline, stop rules, budgets, Inbox, push-to-PR and the branch conventions
of "Keep docs current". Rejected: a separate auto-fix service (duplicates budgeting, approvals,
sessions and the DynamoDB repositories) and a GitHub-Actions-only design (covers only GitHub CI).
GitHub webhooks are used as one intake channel inside the chosen approach.

## 3. Findings and triggers

**Finding** (new repository behind the repository pattern, SQLite and DynamoDB, with contract tests
for both):

- Fields: id, project, source, kind, fingerprint, severity, evidence (scrubbed), status, linked
  session, linked PR, attempt count, occurrence count, timestamps.
- `source`: `ci_failed`, `review_finding`, `session_failed` (later: `client_error`, `feedback`).
- `status`: `new`, `triaged`, `fixing`, `pr_open`, `resolved`, `dismissed`, `suppressed`,
  `needs_human`.
- `fingerprint`: hash of repository, branch family and normalized error. Repeats increment the
  occurrence count and never start a second run.
- Status changes are conditional transitions (same pattern as the DynamoDB sessions hardening), so
  duplicate or delayed events are idempotent.

**Intake** uses the existing webhook routes. GitHub `workflow_run` and `check_suite` failures
create `ci_failed` findings. Webhook signatures are verified. The session lifecycle emits
`session_failed`. Review results emit `review_finding`.

**Trigger.** A new `finding` trigger type: "run when a finding of kind X appears". Seeded specs:
**Fix failing CI**, **Fix review findings**, **Fix failing session**. Each has a goal template,
verification pipeline and a draft-PR action.

## 4. Autonomy policy and guardrails

Per-project setting `autofix` (Setup, new "Auto-fix" tab), with an optional portal-wide default in
Settings. Only project admins can change it.

- `mode`: `off` (default), `propose`, `draft_pr`. `auto_merge` is reserved and not implemented.
- `classes`: allow-list of finding kinds (lint, tests, types, build). Dependency upgrades and
  anything else start off.
- `branches`: eligible branches. Default: the default branch and open PR branches the portal
  created.
- `protected_paths`: globs agents may never edit. Defaults: `.github/workflows/**`, `infra/**`,
  secret and env files, lockfiles (unless the class is deps), the auto-fix config itself.
- `limits`: max open auto-fix PRs per project, max attempts per fingerprint (default 2), max cost
  per finding and per day, cooldown after a failed attempt.

Guardrails, enforced by the server and not by prompts:

1. **Kill switch**, global and per project. When paused no new runs start; findings stay `new`.
2. **Dedupe and loop protection.** A fix PR whose CI fails again counts as an attempt on the same
   fingerprint. At the attempt cap the finding becomes `needs_human` and goes to the Inbox.
3. **Verification before push** (section 5). If the failure cannot be reproduced or made green,
   nothing is pushed.
4. **Diff limits**: default about 10 files and 300 lines. Over the cap means a draft PR flagged
   "large", or propose-only.
5. **Protected paths** are checked on the final diff; a violation aborts the push.
6. **Provenance.** Branch `autofix/<kind>-<fingerprint8>`, PR label `autofix`, PR links the finding
   and session and includes evidence and verification output. Everything is written to the audit
   log.
7. **Secret scrubbing** of evidence stored in findings and posted in PRs, as the review feature does.
8. **Permissions.** Members can see findings; admins change the policy.

Surfacing: Inbox items "Auto-fix PR ready" and "Auto-fix needs a human"; Auto-fix tab with the
policy and a filterable finding list; a project counter of open, resolved and dismissed findings.

## 5. Fix pipeline

1. **Intake and triage.** Deterministic, no agent. Checks mode, class allow-list, branch
   eligibility, limits and pause switches. Result: `triaged`, `suppressed` or `needs_human`.
2. **Fix session.** A loop-spec run from the matching seeded spec, in an isolated working copy on
   `autofix/<kind>-<fingerprint8>`, cut from the failing commit or the PR head. The goal carries
   scrubbed evidence: failing job, log tail, commit SHA, changed files. It runs on AgentCore (with
   the harness's approvals, rules, guard and limits) or locally as a normal session; the pipeline
   is identical.
3. **Verification**, run by the server and not trusted from the agent:
   - reproduce first: the failing check (derived from the CI job command where readable, or a
     per-repo `verify` command in Setup) must fail before the fix; if not reproducible the
     finding ends `needs_human` and nothing is pushed;
   - then green: the same check passes, plus a quick suite (lint and typecheck by default);
   - then guardrails: diff size, protected paths, secret scan;
   - the advisory judge's verdict is attached to the PR and is never a gate.
4. **Delivery.** `draft_pr`: push the branch and open a draft PR using the repo's PR template.
   `propose`: store the diff on the finding and put "Review ready: approve to push" in the Inbox.
   Status becomes `pr_open`.
5. **Closing the loop.** CI on the fix branch: green sets `resolved`; red counts an attempt and,
   under the cap, starts one retry session that sees the previous diff and the new failure. A merge
   or close sets the final state; closed-unmerged becomes `dismissed` and the fingerprint is
   suppressed for a cooldown. A human can dismiss a finding or mark a kind "never fix".
6. **Failure paths.** Agent error or limit: finding returns to `new` with a failed attempt and the
   cooldown applies. Duplicate or delayed webhooks are idempotent via the fingerprint and
   conditional transitions.

## 6. Testing

- Repository contract tests for findings on SQLite and DynamoDB Local: conditional transitions,
  fingerprint upsert, counters.
- Unit tests: triage policy matrix, fingerprint normalization, diff-limit and protected-path
  checks, attempt and cooldown state machine.
- Webhook tests with recorded GitHub payloads: `workflow_run` failure, duplicate delivery,
  signature mismatch, an auto-fix PR's own CI failing.
- Pipeline tests using Demo mode's simulated agent and a fixture repo with a failing check, GitHub
  API stubbed: finding to verified diff to draft PR, plus negative paths (cannot reproduce,
  protected path touched, over diff cap, attempt cap reached).
- UI smoke for the Auto-fix tab and Inbox items in the existing `test:ui` harness.
- Before enabling on a real project: a live manual check against a throwaway GitHub repository.

## 7. Rollout phases (each shippable on its own)

1. Findings repository, webhook intake, fingerprinting, read-only Auto-fix tab. Nothing runs.
2. Triage, policy, limits, kill switches, `propose` mode into the Inbox. Agents run, a human
   approves every push.
3. `draft_pr` mode, CI feedback, retries, resolve and dismiss handling. Enable on this repo first.
4. Review-findings and failed-session fixers as additional seeded specs.

## 8. Out of scope

- Auto-merge (field reserved only).
- Dependency-upgrade fixing, flaky-test detection and quarantine, non-GitHub hosts.
- Client error telemetry and UI work (C), self-improving portal (D), auto-enhance (E).
- Changes to the harness or the AgentCore runners, which are used as they stand.

## 9. Risks

- CI failures that depend on secrets or external services cannot be reproduced locally; that path
  ends `needs_human` by design.
- Cost is bounded by per-finding and per-day caps.
- Fix PRs trigger more CI runs; bounded by the open-PR cap and the attempt cap.
- Webhook-driven runs make the portal's public webhook endpoints more important; signature
  verification is mandatory and tested.

## 10. Corrections after reading the code (2026-11-17)

Reading the code while writing the plan showed that some parts the spec calls "existing" are not in
the code yet. Loop specs are stored and can be run by hand, but nothing dispatches the `github`,
`cron`, `interval` or `jira` triggers. There is no webhook route, no server-run verification
pipeline and no branch-push or PR-creation step for sessions. The README describes more than the
code does. A and B therefore build these pieces themselves, as part of the auto-fix modules:

- **Webhook intake** is new: a raw-body route (`router.rawPost`) that checks the GitHub HMAC signature.
- **Dispatch** is direct. The pipeline starts the seeded session itself; there is no general trigger
  dispatcher. The seeded specs use `trigger_type = 'webhook'` with
  `trigger_config = {"finding_kind": ...}`. A new `finding` trigger type would need a rebuild of the
  `p10_loop_specs` table (a SQLite CHECK constraint), and nothing needs it yet.
- **Verification and delivery** are new server modules (`verify.ts`, `delivery.ts`).
- **Table name.** `findings` and `p10_findings` already hold code-review findings, so the new table
  is `autofix_findings`.
- **Inbox types** are limited by a CHECK constraint, so auto-fix items reuse `review-ready` ("PR
  ready") and `blocked` ("needs a human") with `payload.kind = 'autofix'`.
- **Run hook.** `setRunLifecycleHook` holds one function, which `review-lifecycle.ts` already uses,
  so it becomes a list of hooks.
- **Reproduce command.** v1 uses the per-project `verify.command` only. Deriving the command from the
  failing CI job is deferred.
- **Numeric defaults** the spec left open: 3 open PRs, 2 attempts, $2 per finding, $10 per day, 60
  minute cooldown, 10 files, 300 lines.
