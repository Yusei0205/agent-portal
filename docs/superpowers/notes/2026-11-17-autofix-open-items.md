# Auto-fix foundation: open items after the implementation review

Date: 2026-11-17. Source: the review ledger of the auto-fix build. Items marked "queued for the final fix wave" are being fixed separately; everything else is parked for planning.

## Security

- **Pre-existing, portal-wide (not caused by auto-fix).** The ordinary session push path can leak the push token to an agent-set `remote.origin.pushurl` pointing at a local repository (the auth header in `GIT_CONFIG_VALUE_n` survives the local transport and a receive-pack hook sees it). Other git calls run with the full environment and token inside the agent's repository: `server/agent/runner-repos.ts` (`refreshExisting`), `runner-files.ts`, `runner-inspect.ts`, `runner.ts`. Fix idea: push and fetch from a private repository to the URL in the request, as the auto-fix path does.
- Structural: the agent and the runner share a user and a microVM, so a left-behind agent process can read the token from `/proc/<pid>/environ` (`server/agent/runner-finalize*.ts`). Mitigation today: a person approves every push unless `AUTOFIX_ALLOW_UNATTENDED_PUSH=1`. Real fix: separate user or push from outside the microVM.
- Approval bypass: an Inbox approval of an auto-fix item after the finding left `fixing` makes `autofixPrPlan` null and performs an ordinary push without the deny-path, base and post-push checks (`server/session-pr.ts` around 386-394, `server/autofix/delivery.ts` around 95-101). Queued for the final fix wave.
- Credentialed `symbolic-ref` in the session repo at `server/agent/runner-finalize-run.ts:241`. Queued for the final fix wave.
- Regression for ordinary sessions: the end-of-run change report is built in a private repo for all sessions (LFS-style filters, autocrlf, shallow repos). Keep the legacy report for ordinary sessions. Queued for the final fix wave.
- `server/autofix/scrub.ts:57`: the 40-hex pattern leaks the tail of 64-hex secrets (use `{40,}`). Queued for the final fix wave.
- `pr_url` rendered as an href without an http(s) check (`web/src/pages/hub/AutoFix.jsx`).
- Stored `run_as` is not re-validated on enable when unchanged (`server/autofix/policy.ts:38`); `fireLoopSpec` re-checks at fire time.
- Policy limits have no upper bound (`policy.ts` around 125-130); classes are not validated against the known set; `k in DEFAULT_POLICY.limits` accepts prototype keys (use `Object.hasOwn`).
- A rename-away of a protected file is not detected (`DiffFile` carries only the new path).
- `yarn.lock` and `pnpm-lock` are not in the default protected set; nested `.github/workflows` and `infra/` are not protected (root-anchored globs).
- Evidence cap is applied before scrubbing, which can expand text (`server/autofix/review-source.ts`). Queued for the final fix wave.
- `changedPathsPayload` (`server/session-pr.ts:231`) must strip control characters and skip non-string paths. Queued for the final fix wave.

## Correctness

- Every 409 counts as busy, including a `startRun` failure in `fireLoopSpec` (`server/loop-triggers.ts` around 263-269): leaves a paused workflow and burns the hourly quota. Count an attempt when the reason is not "still running". Queued for the final fix wave.
- DynamoDB repository: `isCancelled` treats `TransactionConflict` as false (`server/repositories/autofix-findings-dynamodb.ts` around 165, 350); needs retry and a concurrent test. `PATCHABLE_FIELDS` includes `fingerprint` and `created_at`; `list()` has no tiebreaker. The DynamoDB suite was never run here (needs DynamoDB Local). Queued for the final fix wave.
- Fingerprint (`server/autofix/fingerprint.ts`): the `|` delimiter is ambiguous for the subject component (queued for the final fix wave); the path normalizer collapses to the first segment and basename (line 33); it strips all `:\d+` including ports (34) and 8+ digit runs (32); add a negative collision test.
- Lost runs and driver-level failures fire no `failed` hook (`server/workflows/lost-runs.ts:67`, `driver.ts:170,196-207`), so the finding stays `fixing`. A loop that ends green with no repo change also stays `fixing`. A finding can stick in `triaged` after a crash. No timed sweep for cooldown-held findings.
- `needs_human` findings keep `pr_branch`, so a PR closed or merged later is ignored. `pr_head_sha` null disables the stale check. Retry has no cooldown. A base that moved a protected path wastes a retry session.
- Review source: dismissal after completion does not stop the finding; rerun dedupe depends on identical LLM wording; review findings have no category column (kind is always `review`).
- Dev databases seeded before the seed change keep the old `maxPerHour` default; DynamoDB mode never seeds built-in specs (a warning is logged); `SCHEMA_VERSION` comment is stale.
- Never-fix dismisses before the policy write (non-atomic) (`server/autofix/routes.ts:241-250`).

## UX

- `web/src/pages/Inbox.jsx:1006` uses `key={x}` with possibly duplicate paths: use the index. Queued for the final fix wave.
- `.af-actions` flex on a `<td>` (`web/src/styles/autofix.css`): wrap in a div. Queued for the final fix wave.
- `AutoFix.jsx:1461`: a failed policy GET silently hides the panels (show an error); `:1567` `key=JSON.stringify(policy)` remounts the form and drops unsaved edits. Stale data on filter change and no retry on error.
- Phone width: the table is not tuned below about 600px; the open detail row can sit off-screen at 390px.
- The Inbox question shows counts and changed paths only, not the diff; the changed paths are not stored on the finding.
- Inbox counts versus base wording (minor).

## Tests and coverage

- DynamoDB suites (`test/autofix-findings-repo.test.ts` with `DYNAMODB_ENDPOINT`) have not been run; new columns are untested there.
- Missing tests: `pr_open` protection against evidence overwrite; a member of project A requesting project B; a non-admin owner PUT of the policy (added in a fix round, re-check); the `autofix/` push guard is covered, the approval-bypass case is not.
- Hook unit tests share module-level hooks with the live test server (`test/autofix-hooks.test.ts`).
- Browser tests: the full `npm run test:ui` could not run in the build environment (Chromium revision missing); only `SMOKE_ONLY=setup,inbox` subsets ran.

## Manual live check (not run: no throwaway GitHub repository was available)

1. Create a throwaway GitHub repository with a CI workflow that runs the project's tests; connect it to a portal project.
2. Setup > Auto-fix: set the verify command, choose classes, mode `propose`, engine and run-as user; save.
3. Add the webhook (`<portal>/api/hooks/autofix/<projectId>`, `application/json`, the secret from Rotate secret, events Workflow runs and Pull requests). Check the delivery shows 202.
4. Push a branch that breaks a test; wait for CI to fail on the default branch (or an eligible branch).
5. Confirm a finding appears on the Auto-fix tab (New, then Fixing).
6. Confirm the Inbox item "Auto-fix PR ready" with the changed paths; approve it.
7. Confirm the draft PR exists on `autofix/<kind>-<id>` with the `autofix` label.
8. Make CI go red on the fix branch and confirm one retry session on the same branch, then green resolving the finding; close a PR unmerged and confirm Dismissed and the cooldown.
9. Switch to `draft_pr`: with `AUTOFIX_ALLOW_UNATTENDED_PUSH` unset, confirm a person is still asked; test the kill switch (Pause) stops new sessions.
