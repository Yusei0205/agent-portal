# Auto-fix Foundation and Auto-fix for User Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Failing CI, review findings and failed sessions become findings that agents fix and deliver as verified draft PRs, under a per-project autonomy policy with server-enforced guardrails.

**Architecture:** A new `autofix_findings` repository (SQLite and DynamoDB) holds findings. New modules under `server/autofix/` do intake (GitHub webhook, run-lifecycle hook), triage, the fix pipeline (baseline, session, server-run verification), and delivery (push, draft PR, CI feedback). Sessions are ordinary workflows started directly by the pipeline.

**Tech Stack:** TypeScript on Node >=22.13, `node:test` with tsx, `node:sqlite`, DynamoDB (Local in tests), React in `web/src`.

**Spec:** `docs/superpowers/specs/2026-11-17-autofix-foundation-design.md`. Read section 10 first: it corrects what the spec assumed already exists.

## Global Constraints

- Default `mode` is `off`. `auto_merge` is not built (the spec reserves the field only).
- GitHub only. CodeCommit repositories never produce or receive auto-fix work.
- Fix branches are `autofix/<kind>-<fingerprint8>`. PRs are drafts and carry the label `autofix`.
- Defaults: `classes` = lint, tests, types, build. `protected_paths` = `.github/workflows/**`, `infra/**`, `**/.env*`, `**/*.pem`, `package-lock.json`, `**/package-lock.json`. Limits: 3 open PRs, 2 attempts per fingerprint, $2 per finding, $10 per day, 60 minute cooldown, 10 files, 300 lines.
- Every new repository follows `docs/plans/2026-11-02-repository-pattern.md`: interface, `-sqlite`, `-dynamodb`, contract test over both, selection by `usesDynamoDb()`.
- Status changes are conditional transitions. Evidence is scrubbed before it is stored or posted.
- Only project admins change the policy. Members read findings.
- Tests: `node --disable-warning=ExperimentalWarning --import tsx --test <file>`. Typecheck: `npm run typecheck` must stay at 0 errors. Do not edit `test/TEST_CHECKLIST.md` by hand.
- Commit messages end with the two attribution lines from the session's system reminder.

## Review Focus

- The same failing run is delivered twice, or two events race. Expect one finding and one session.
- Bad or missing webhook signature, or a repository that is not in the project. Expect 401 or 404 and nothing stored.
- A fix PR's own CI keeps failing. Expect the attempt cap, then `needs_human`, with no endless loop.
- The agent edits a protected path or exceeds the diff cap. Expect nothing pushed.
- CI log evidence contains a token. Expect it scrubbed in the finding and in the PR body.
- The kill switch is flipped, or the project is `off`, while events arrive. Expect no run starts.

---

## Phase 1: findings and intake (nothing runs)

### Task 1: Findings repository

**Files:**
- Modify: `server/db.ts` (add `M46_AUTOFIX_FINDINGS` and append it to `MIGRATIONS`)
- Create: `server/repositories/autofix-findings.ts`, `autofix-findings-sqlite.ts`, `autofix-findings-dynamodb.ts`
- Test: `test/autofix-findings-repo.test.ts` (model it on `test/audit-repo.test.ts`)

**Interfaces:**
- Produces (in `autofix-findings.ts`):
  - `type FindingSource = 'ci_failed' | 'review_finding' | 'session_failed'`
  - `type FindingStatus = 'new'|'triaged'|'fixing'|'pr_open'|'resolved'|'dismissed'|'suppressed'|'needs_human'`
  - `interface AutofixFinding { id; project_id; source: FindingSource; kind: string; fingerprint: string; severity: 'low'|'medium'|'high'; evidence: string; status: FindingStatus; repo_id: string|null; branch: string|null; commit_sha: string|null; workflow_id: string|null; fix_branch: string|null; pr_number: number|null; pr_url: string|null; attempts: number; occurrences: number; cost_usd: number; cooldown_until: string|null; created_at: string; updated_at: string }`
  - `type UpsertFindingInput = Pick<AutofixFinding, 'project_id'|'source'|'kind'|'fingerprint'|'severity'|'evidence'|'repo_id'|'branch'|'commit_sha'>`
  - `interface AutofixFindingsRepository { upsertByFingerprint(i: UpsertFindingInput): Promise<{ finding: AutofixFinding; created: boolean }>; getById(id: string): Promise<AutofixFinding|null>; getByFingerprint(projectId: string, fp: string): Promise<AutofixFinding|null>; getByFixBranch(projectId: string, branch: string): Promise<AutofixFinding|null>; getByWorkflowId(workflowId: string): Promise<AutofixFinding|null>; list(projectId: string, o: { status?: FindingStatus; limit: number }): Promise<AutofixFinding[]>; transition(id: string, from: FindingStatus[], patch: Partial<Omit<AutofixFinding,'id'|'project_id'>> & { status: FindingStatus }): Promise<boolean>; countByStatus(projectId: string): Promise<Record<FindingStatus, number>>; sumCostSince(projectId: string, sinceIso: string): Promise<number> }`
  - `initAutofixFindingsRepository()`, `getAutofixFindingsRepository()`, `setAutofixFindingsRepository(r)`, `clearAutofixFindingsRepository()`

- [ ] **Step 1: Write the contract test** `runContract(label, makeRepo)` with these tests:
  - `upsert creates, second upsert with same fingerprint returns created=false and occurrences=2`
  - `upsert on the same fingerprint in another project creates a separate finding`
  - `transition applies only when current status is in from; returns false otherwise`
  - `two concurrent transitions from 'new' to 'triaged': exactly one returns true`
  - `getByFixBranch and getByWorkflowId find the finding after a transition sets them`
  - `list filters by status and orders newest first`
  - `countByStatus returns a zero for every status`
  - `sumCostSince sums cost_usd of findings updated since the timestamp`
  - Run the DynamoDB suite only when `DYNAMODB_ENDPOINT` is set, as the other repo tests do.
- [ ] **Step 2: Run it** `node ... --test test/autofix-findings-repo.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the interface file and the SQLite implementation.** The migration creates `autofix_findings` with every field above, unique index `(project_id, fingerprint)`, indexes on `(project_id, status)`, `workflow_id` and `fix_branch`. `transition` is one `UPDATE ... WHERE id = ? AND status IN (...)` and returns `changes > 0`.
- [ ] **Step 4: Implement the DynamoDB version** in `portal-projects`, following the key style of `inbox-dynamodb.ts`. Finding item: `PK=PROJECT#<projectId>`, `SK=AFIND#<id>`. Dedupe item: `SK=AFFP#<fingerprint>` holding the id, written with `attribute_not_exists` in the same `TransactWriteItems` as the finding. `transition` uses a condition expression on `status`. For `getByWorkflowId`, `getByFixBranch` and `sumCostSince`, write lookup items or filter within the project partition, whichever the existing repos do for similar lookups.
- [ ] **Step 5: Run the test.** Expected: PASS on SQLite (and on DynamoDB when `DYNAMODB_ENDPOINT` is set). Run `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(autofix): findings repository`.

### Task 2: Fingerprint and evidence scrubbing

**Files:**
- Create: `server/autofix/fingerprint.ts`, `server/autofix/scrub.ts`
- Test: `test/autofix-fingerprint.test.ts`

**Interfaces:**
- Produces: `branchFamily(branch: string): string`, `normalizeError(text: string): string`, `computeFingerprint(i: { repo: string; branch: string; kind: string; error: string }): string` (16 hex chars), `scrubEvidence(text: string, maxChars?: number): string` (default `maxChars` 8000, keeps the tail).

- [ ] **Step 1: Write the tests:**
  - `branchFamily('main') === 'main'`, `branchFamily('feature/login') === 'feature'`, `branchFamily('autofix/tests-ab12cd34') === 'autofix'`
  - `the same error with different timestamps, absolute paths, hex ids and line numbers has the same fingerprint`
  - `different kinds or repos give different fingerprints`
  - `scrubEvidence removes a ghp_ token, an AWS key id (AKIA...), an Authorization: Bearer value and a 40-hex secret assigned to a key named *_SECRET or *_TOKEN`
  - `scrubEvidence keeps the last maxChars characters`
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** `normalizeError` (strip ISO and clock timestamps, `0x`/long hex runs, absolute path prefixes, `:\d+(:\d+)?` line numbers, collapse whitespace) and `computeFingerprint` as `sha256(repo|branchFamily|kind|normalizeError(error))`. For `scrubEvidence`, find the secret scrubber the review feature uses (`grep -n -i "scrub\|redact" server/review.ts server/*.ts`); reuse and export it if it covers those patterns, otherwise write the patterns here and make review use this module.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): fingerprint and evidence scrubbing`.

### Task 3: Autonomy policy and kill switch

**Files:**
- Create: `server/autofix/policy.ts`, `server/autofix/routes.ts` (policy and pause routes only for now)
- Modify: `server/index.ts` (register `registerAutofixRoutes()` next to `registerLoopSpecRoutes()`)
- Test: `test/autofix-policy.test.ts`

**Interfaces:**
- Produces in `policy.ts`:
  - `interface AutofixPolicy { mode: 'off'|'propose'|'draft_pr'; classes: string[]; branches: { default_branch: boolean; portal_prs: boolean; extra: string[] }; protected_paths: string[]; limits: { max_open_prs: number; max_attempts: number; max_cost_per_finding_usd: number; max_cost_per_day_usd: number; cooldown_minutes: number; max_files: number; max_lines: number }; verify: { command: string; quick_commands: string[] } }`
  - `DEFAULT_POLICY: AutofixPolicy` (values from Global Constraints; `verify.command` is `''`)
  - `getAutofixPolicy(projectId: string): Promise<AutofixPolicy>`, `saveAutofixPolicy(projectId: string, patch: Partial<AutofixPolicy>): Promise<AutofixPolicy>` (validates: `mode` is one of the three, numbers are positive integers, `protected_paths` always keeps the workflow and policy defaults)
  - `isPaused(projectId: string): Promise<boolean>` (true when the global or the project flag is set), `setPaused(scope: 'global' | string, paused: boolean): Promise<void>`
- Routes: `GET`/`PUT /api/projects/:id/autofix/policy`, `POST /api/projects/:id/autofix/pause` with body `{ paused: boolean }`, `POST /api/autofix/pause` (admin only, global).

- [ ] **Step 1: Write the tests:** `getAutofixPolicy returns DEFAULT_POLICY with mode 'off' for an unconfigured project`; `saveAutofixPolicy merges a partial patch and persists`; `saveAutofixPolicy rejects mode 'auto_merge' and a negative limit`; `protected_paths cannot lose the default entries`; route tests with the server fixture: a non-admin member gets 403 on PUT and 200 on GET, admin gets 200; `isPaused is true after the global pause and after the project pause, false after both are cleared`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** storing the policy as JSON under the settings key `autofix.policy.<projectId>` and pause flags under `autofix.paused.global` and `autofix.paused.<projectId>`, using `getSetting` and `setSetting` from `server/settings.ts`. Admin check follows `requireProjectEditor` in `server/loop-specs.ts` but requires an admin or project owner. Every policy change and pause toggle appends an audit entry (`getAuditRepository().append`, actions `autofix.policy.update` and `autofix.pause`); add a test asserting both entries.
- [ ] **Step 4: Run the tests.** Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(autofix): policy store, kill switch and routes`.

### Task 4: GitHub webhook intake

**Files:**
- Create: `server/autofix/github-events.ts`, `server/autofix/intake.ts`, `server/autofix/webhook.ts`
- Modify: `server/autofix/routes.ts` (register the webhook and secret routes)
- Test: `test/autofix-github-events.test.ts`, `test/autofix-webhook.test.ts`, fixtures under `test/fixtures/github/` (recorded `workflow_run`, `check_suite` and `pull_request` payloads)

**Interfaces:**
- Consumes: Task 1 repository, Task 2 `computeFingerprint`/`scrubEvidence`, Task 3 `getAutofixPolicy`/`isPaused`.
- Produces:
  - `type GithubEventResult = { type: 'finding'; candidate: FindingCandidate } | { type: 'ci_result'; repoFullName: string; branch: string; conclusion: 'success'|'failure'; headSha: string } | { type: 'pr_closed'; repoFullName: string; branch: string; merged: boolean; prNumber: number } | { type: 'ignore' }`
  - `interface FindingCandidate { repoFullName: string; branch: string; headSha: string; source: FindingSource; kind: string; severity: 'low'|'medium'|'high'; errorText: string; runId?: number }`
  - `parseGithubEvent(event: string, payload: unknown): GithubEventResult`
  - `classifyKind(name: string): 'lint'|'types'|'build'|'tests'|'other'` (matches `/lint|eslint|prettier/i`, `/type|tsc/i`, `/build|compile/i`, `/test/i` in that order)
  - `verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean` (HMAC SHA-256, `timingSafeEqual`)
  - `recordFinding(projectId: string, c: FindingCandidate, evidence: string): Promise<{ finding: AutofixFinding; created: boolean }>` in `intake.ts`
  - `fetchCiEvidence(c: FindingCandidate, projectId: string): Promise<string>` (GitHub API jobs and log tail for `runId`, using the project's GitHub connection token as `review.ts` does; returns scrubbed text)
  - Routes: `router.rawPost('/api/autofix/webhook/github/:projectId', ...)`, `POST /api/projects/:id/autofix/webhook-secret` (admin; generates a secret, stores it with `setSecret('autofix.webhook.<projectId>', ...)`, returns it once).

- [ ] **Step 1: Write the parser tests** against the recorded fixtures: a failed `workflow_run` on `main` gives a `finding` with `kind` from the workflow name; the same on `autofix/tests-ab12cd34` gives `ci_result` with `conclusion: 'failure'`; a successful one gives `ci_result` success; a `pull_request` closed with `merged: true` gives `pr_closed`; `ping` and cancelled runs give `ignore`.
- [ ] **Step 2: Write the webhook tests** with the server fixture: `a valid signature creates one finding`; `the same delivery twice creates one finding with occurrences 2`; `a wrong signature returns 401 and stores nothing`; `a repository that is not in the project returns 404 and stores nothing`; `a project with mode 'off' stores the finding as 'suppressed'`; `a paused project stores it as 'new'` (stubbing `fetchCiEvidence`).
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement** the parser, signature check, intake and routes. The route resolves the project's repository from `repos` by matching `repository.full_name` against each repo's GitHub remote (read `server/repos.ts` for the field). It verifies the signature before anything else, returns 202 quickly and does evidence fetching and `recordFinding` after responding. Status rules in `recordFinding`: a new finding starts as `new`, or `suppressed` when the policy mode is `off`; an existing `resolved` finding that recurs goes back to `new`; one that is `dismissed` or `suppressed` with a future `cooldown_until` is left alone, only its counter increments.
- [ ] **Step 5: Run the tests.** Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(autofix): GitHub webhook intake`.

### Task 5: Findings API and read-only Auto-fix tab

**Files:**
- Modify: `server/autofix/routes.ts`, the Setup page and its tab list in `web/src/pages/setup/` (see how the Jira tab is registered)
- Create: `web/src/pages/setup/AutoFix.jsx`
- Test: `test/autofix-routes.test.ts`, a case in `test/ui/smoke.ts`

**Interfaces:**
- Consumes: Task 1 `list`/`countByStatus`/`getById`, Task 3 policy.
- Produces: `GET /api/projects/:id/autofix/findings?status=&limit=` returning `{ findings: AutofixFinding[], counts: Record<FindingStatus, number> }`; `GET /api/projects/:id/autofix/findings/:fid`.

- [ ] **Step 1: Write route tests:** members can list, non-members get 404, the status filter works, `limit` is capped at 100, the finding detail returns the evidence.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the routes** and `AutoFix.jsx` (counters, status filter, finding rows with kind, branch, occurrences, status, and a link to the session or PR when present; a notice that the project is `off`). Add the UI smoke case.
- [ ] **Step 4: Run** the route test and `npm run test:ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): findings API and Auto-fix tab`.

## Phase 2: triage, pipeline, propose mode

### Task 6: Triage and diff guardrails

**Files:**
- Create: `server/autofix/triage.ts`, `server/autofix/guardrails.ts`
- Test: `test/autofix-triage.test.ts`, `test/autofix-guardrails.test.ts`

**Interfaces:**
- Produces:
  - `interface TriageContext { paused: boolean; openPrCount: number; costTodayUsd: number; defaultBranch: string | null; portalPrBranches: string[]; now: Date }`
  - `type TriageDecision = { decision: 'triaged' } | { decision: 'deferred'; reason: string } | { decision: 'suppressed'; reason: string } | { decision: 'needs_human'; reason: string }`
  - `triage(f: AutofixFinding, p: AutofixPolicy, ctx: TriageContext): TriageDecision`, evaluated in this order: mode `off` is suppressed; paused is deferred; class not allowed is suppressed; branch ineligible is suppressed; `cooldown_until` in the future is suppressed; `attempts >= max_attempts` is needs_human; open PR cap reached is deferred; daily or per-finding cost cap reached is deferred.
  - `interface DiffFile { path: string; added: number; removed: number }`, `checkDiff(files: DiffFile[], p: AutofixPolicy, kind: string): { ok: boolean; large: boolean; violations: string[] }` (a protected path match makes `ok` false; more than `max_files` or `max_lines` sets `large` only; lockfile paths are allowed when `kind === 'deps'`; matching uses `path.matchesGlob`).

- [ ] **Step 1: Write the tests:** one test per triage rule in the order above, plus `a finding on the default branch with kind 'tests' in mode draft_pr is triaged`; for `checkDiff`: `a change to .github/workflows/ci.yml is not ok`, `package-lock.json is a violation for kind 'tests'`, `11 files sets large but stays ok`, `301 changed lines sets large`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement both modules** as pure functions with no I/O.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): triage and diff guardrails`.

### Task 7: Multiple run-lifecycle hooks and `session_failed` intake

**Files:**
- Modify: `server/agent/runner.ts` (hook list), `server/review-lifecycle.ts` (use `addRunLifecycleHook`), `server/index.ts`
- Create: `server/autofix/session-intake.ts`
- Test: `test/autofix-hooks.test.ts`; the existing review tests must still pass

**Interfaces:**
- Produces: `addRunLifecycleHook(fn: RunLifecycleHook): () => void` (returns an unsubscribe function); `setRunLifecycleHook` is kept and replaces only the hook it registered earlier. `registerSessionIntake()` in `session-intake.ts`: on `'failed'`, creates a `session_failed` finding for the workflow's project unless the workflow is an auto-fix session (`getByWorkflowId` returns a finding) or a review session.

- [ ] **Step 1: Write the tests:** `two hooks both fire for one event`; `one hook throwing does not stop the other`; `the unsubscribe function removes the hook`; `a failed ordinary session creates a session_failed finding`; `a failed auto-fix session does not`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the hook list in `runner.ts` (each hook guarded in its own try/catch, as `fireHook` does now), move `review-lifecycle.ts` to `addRunLifecycleHook`, and wire `registerSessionIntake()` at startup.
- [ ] **Step 4: Run** the new test plus `npm run test:affected -- --module reviews`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): multi-hook run lifecycle and session failure intake`.

### Task 8: Fix pipeline (baseline, session, verification) with propose mode

**Files:**
- Modify: `server/workflows/crud.ts` (extract `createAndStartWorkflow`), `server/db.ts` (`M47_AUTOFIX_SPECS`, seeds), `server/autofix/intake.ts` (call the pipeline after `recordFinding`)
- Create: `server/autofix/pipeline.ts`, `server/autofix/verify.ts`
- Test: `test/autofix-pipeline.test.ts`, `test/autofix-verify.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 6, 7; `checkoutRepoToWorkDir` and `createWorkDir` from `server/workflows/working-copies.ts`; `createInboxItem` from `server/inbox.ts`.
- Produces:
  - `createAndStartWorkflow(opts: { projectId: string; goal: string; engine?: string; repoIds: string[]; maxIterations: number; createdBy: string | null }): Promise<string>`, extracted from the POST handler in `crud.ts` with no behaviour change.
  - Seeded spec `builtin-autofix-ci` (migration `M47_AUTOFIX_SPECS`): `trigger_type = 'webhook'`, `trigger_config = {"finding_kind":"ci_failed"}`, goal template with `{{kind}}`, `{{branch}}`, `{{evidence}}`, `{{verify_command}}`, `max_iterations` 4, stop config `{"maxIterations":4,"budgetUsd":2}`.
  - `runCommand(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }>` and `runVerification(i: { workDir: string; command: string; quickCommands: string[] }): Promise<{ ok: boolean; output: string }>` in `verify.ts`.
  - `processFinding(findingId: string): Promise<void>` and `onFixSessionDone(workflowId: string): Promise<void>` in `pipeline.ts`.

- [ ] **Step 1: Write the tests:**
  - verify: `runCommand returns the exit code and combined output`, `a command that exceeds the timeout returns code 124`.
  - pipeline (Demo mode, stubbed repo checkout): `a triaged finding with a failing verify command starts one workflow and becomes 'fixing'`; `if the verify command already passes (not reproducible) the finding becomes needs_human, no workflow starts, and a 'blocked' inbox item with payload.kind 'autofix' exists`; `a deferred or suppressed triage result starts nothing`; `onFixSessionDone in propose mode with a passing verify and a clean diff stores the diff and creates a 'review-ready' inbox item with payload.kind 'autofix'`; `verification that still fails counts an attempt and returns the finding to 'new'`; `a diff touching a protected path pushes nothing and ends needs_human`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Extract `createAndStartWorkflow`** from the workflow POST handler and run `npm run test:affected -- --module sessions` to confirm no change.
- [ ] **Step 4: Implement `verify.ts`** with `spawn` through a shell, a hard timeout that kills the process group, and output capped and scrubbed.
- [ ] **Step 5: Implement `processFinding`:** load the finding, policy and context, run `triage`, transition conditionally, run the baseline in a fresh working copy (it must fail), fill the goal template, call `createAndStartWorkflow`, and store `workflow_id` and `status='fixing'` in one conditional transition from `triaged`. `onFixSessionDone` (called from a hook registered with `addRunLifecycleHook` on `'done'` and `'failed'`) finds the finding by workflow id, runs `runVerification`, builds `DiffFile[]` from `git diff --numstat` against the base, calls `checkDiff`, adds the run cost to `cost_usd`, and then either stores the diff and creates the Inbox item (propose mode) or hands off to Task 9.
- [ ] **Step 6: Run the tests.** Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 7: Commit** `feat(autofix): fix pipeline with server-run verification and propose mode`.

## Phase 3: draft PRs and the closed loop

### Task 9: Delivery (push and draft PR)

**Files:**
- Create: `server/autofix/delivery.ts`
- Modify: `server/autofix/pipeline.ts` (call `deliver` in `draft_pr` mode and on approval in propose mode)
- Test: `test/autofix-delivery.test.ts`

**Interfaces:**
- Consumes: Task 8 pipeline; `buildPrBody` inputs from the finding and the verification output.
- Produces: `fixBranchName(kind: string, fingerprint: string): string` (`autofix/<kind>-<first 8 of fingerprint>`); `buildPrBody(f: AutofixFinding, verifyOutput: string, judge: string | null): string` (evidence and verify output scrubbed, links the session, follows the repo's PR template headings when a template file exists in the working copy); `deliver(f: AutofixFinding, workDir: string): Promise<{ prNumber: number; prUrl: string }>` (commit, `git push` of the branch, GitHub `POST /pulls` with `draft: true`, then add the `autofix` label through the issues API, using the same token source as `review.ts`), and append an audit entry `autofix.pr.opened` with the finding id and PR number (assert it in the deliver test). `judge` is `null` in v1: the advisory judge does not exist in the code yet.

- [ ] **Step 1: Write the tests** with `fetch` and git stubbed: `fixBranchName('tests','abcdef0123456789') === 'autofix/tests-abcdef01'`; `buildPrBody contains the evidence, the verify output and no secret`; `deliver creates a draft PR with label autofix and returns its number and url`; `the finding moves fixing to pr_open with pr_number, pr_url and fix_branch set`; `a push failure leaves the finding in 'new' with an attempt counted and no PR`; `in propose mode nothing is pushed until the inbox item is approved`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `delivery.ts` and the two call sites. Approval of the propose-mode Inbox item calls `deliver`; wire this where the inbox resolve route handles `review-ready` items (see `server/inbox.ts`).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): push branch and open labelled draft PR`.

### Task 10: Closing the loop

**Files:**
- Modify: `server/autofix/webhook.ts`, `server/autofix/pipeline.ts`
- Test: `test/autofix-loop.test.ts`

**Interfaces:**
- Consumes: `ci_result` and `pr_closed` results from Task 4; `getByFixBranch` from Task 1.
- Produces: `applyCiResult(projectId: string, r: Extract<GithubEventResult, { type: 'ci_result' }>): Promise<void>` and `applyPrClosed(projectId: string, r: Extract<GithubEventResult, { type: 'pr_closed' }>): Promise<void>` in `pipeline.ts`.

- [ ] **Step 1: Write the tests:** `green CI on the fix branch moves pr_open to resolved`; `red CI counts an attempt and, below max_attempts, starts one retry session whose goal includes the previous diff`; `red CI at max_attempts moves the finding to needs_human and creates a 'blocked' inbox item`; `a merged PR resolves the finding`; `a PR closed without merging moves it to dismissed and sets cooldown_until to now plus cooldown_minutes`; `a late event for a finding that is no longer pr_open changes nothing`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** both functions with conditional transitions from `pr_open`, and route the new webhook result types to them.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): close the loop from CI and PR events`.

### Task 11: Policy UI, actions and Inbox labels

**Files:**
- Modify: `server/autofix/routes.ts`, `web/src/pages/setup/AutoFix.jsx`, `web/src/pages/Inbox.jsx`
- Test: `test/autofix-routes.test.ts` (extend), `test/ui/smoke.ts`

**Interfaces:**
- Produces: `POST /api/projects/:id/autofix/findings/:fid/dismiss` (to `dismissed`), `POST .../never-fix` (dismisses and removes the finding's `kind` from `policy.classes`), `POST .../retry` (admin, from `needs_human` or `new` back through `processFinding`).

- [ ] **Step 1: Write route tests:** dismiss, never-fix (check the policy afterwards) and retry each need admin; a member gets 403; dismissing an already resolved finding returns 409.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the routes; extend `AutoFix.jsx` with the policy form (mode, classes, limits, protected paths, verify command, webhook secret with the one-time reveal and the webhook URL), the project pause button, and per-finding actions; make `Inbox.jsx` show the labels "Auto-fix PR ready" and "Auto-fix needs a human" when `payload.kind === 'autofix'`.
- [ ] **Step 4: Run** the route test and `npm run test:ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): policy form, finding actions and Inbox labels`.

## Phase 4: more fixers and housekeeping

### Task 12: Review-finding and failed-session fixers

**Files:**
- Modify: `server/db.ts` (`M48_AUTOFIX_SPECS_2`), `server/review.ts` (emit candidates), `server/autofix/pipeline.ts` (goal templates per source)
- Test: `test/autofix-sources.test.ts`

**Interfaces:**
- Produces: seeded specs `builtin-autofix-review` (`finding_kind: 'review_finding'`) and `builtin-autofix-session` (`finding_kind: 'session_failed'`); `emitReviewFindings(reviewId: string): Promise<void>` creating a `review_finding` candidate for each posted finding at or above medium severity (kind from the review finding's `category`).

- [ ] **Step 1: Write the tests:** `a review with one high and one low finding creates one review_finding`; `the same finding on a rerun does not create a second one`; `a session_failed finding starts the session spec with the failure text in the goal`; `pipeline picks the spec by finding source`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the migration, the emit call (after review findings are stored, behind the project policy being on), and the per-source goal selection.
- [ ] **Step 4: Run** the new test and `npm run test:affected -- --module reviews`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autofix): review-finding and failed-session fixers`.

### Task 13: Docs and test map

**Files:**
- Modify: `README.md`, `docs/user-guide.md`, `test/test-map.json` (add an `autofix` module listing the sources and tests above), `docs/plans/2026-11-17-autofix-foundation.md` (tick boxes)

- [ ] **Step 1: Add the `autofix` module** to `test/test-map.json`, then run `npm run test:map:check` and `npm run test:checklist`. Expected: both succeed.
- [ ] **Step 2: Document** the feature in the README and user guide: policy fields, webhook setup (URL, secret, events `workflow_run` and `pull_request`), kill switch, what an auto-fix PR looks like, and the safe rollout order from the spec.
- [ ] **Step 3: Run the full suites:** `npm test`, `npm run typecheck`, `npm run test:ui`. Expected: all pass.
- [ ] **Step 4: Manual live check** against a throwaway GitHub repository: enable `propose`, break a test, confirm the finding, the Inbox item, then switch to `draft_pr` and confirm the draft PR, the label and the CI feedback.
- [ ] **Step 5: Commit** `docs: auto-fix guide and test map`.
