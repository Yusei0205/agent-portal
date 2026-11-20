# Pipeline monitor: deploy status per project, with failure alerts

Date: 2026-11-20. Status: draft for review.

## Intent

Project admins want to see, for each project, whether its deployment pipelines succeeded, and to be told when a deploy fails, without
watching GitHub. Success means: an admin can open a project and see the state of its latest deploys at a glance, and a failed deploy
reaches them (Inbox today, a Slack or Microsoft Teams channel once they have one) within a minute of the run ending.

## Goals

- A **Pipelines** tab in each project (Project > Setup page, next to Auto-fix) listing, per GitHub repository of the project, the latest
  run of each workflow on each branch: status (queued, in progress, succeeded, failed, cancelled), workflow name, branch, commit (short
  sha), who triggered it, when it started and how long it took, and a link to the run on GitHub. A short history (the last runs of each
  workflow) opens under each row.
- **Deploy workflows** are the ones that matter for alerts. Default: a workflow whose name contains "deploy" (case-insensitive). The
  project can replace that rule with an explicit list of workflow names. Only runs on the repository's **default branch** alert by default;
  the project can add more branch names.
- **Alert on a failed deploy run** (conclusion failure or timed_out): one Inbox item for the project (type `blocked`, payload
  `kind: 'pipeline'`, so it also shows in the dashboard's "Needs attention"), and, when the project has a chat webhook URL, one message to
  that channel. One alert per failing run (not per webhook delivery). Admins and project owners see project Inbox items as today.
- **Recovery**: when a later run of the same workflow on the same branch succeeds, the open Inbox alert of that workflow/branch is resolved
  automatically and, when a chat URL is set, a short "recovered" message is sent.
- **Chat channel**: a project setting holding one incoming-webhook URL, either Slack (`https://hooks.slack.com/...`) or Microsoft Teams
  (Teams Workflows / Power Automate webhook URL on `*.logic.azure.com` or `*.webhook.office.com`), with a "Send test message" button. Empty
  by default; until it is set, alerts go to the Inbox only. Only project owners and portal admins can set or change it; the URL is a secret.

## Non-goals

- No polling of GitHub and no "refresh from GitHub" button (approach 1 was chosen); a repository without the webhook shows a hint instead
  of data.
- No email, no SMS, no per-person notification preferences.
- No CodeCommit or other hosts (GitHub only, like Auto-fix).
- No portal-wide pipelines page across projects (per project only); no charts or success-rate statistics.
- No re-running or cancelling workflows from the portal.
- No log viewing in the portal (the run link goes to GitHub).

## Anti-goals (would make it a failure even if it works)

- Alert noise: a webhook redelivery, a re-run attempt, or several jobs of one run must not produce several alerts.
- Leaking: the chat URL or GitHub token must never appear in the UI after saving, in logs, or in chat messages; chat messages carry no
  log text (only repository, workflow, branch, short sha, actor, run link).
- Becoming an open relay: the portal must only POST to Slack/Teams webhook hosts, never to an arbitrary URL (SSRF).
- Breaking Auto-fix: the shared webhook route must keep every Auto-fix behaviour and test unchanged.

## Constraints

- **Data source: the existing per-project GitHub webhook** (`POST /api/hooks/autofix/:projectId`, signed with the project's secret, set up
  per repository; see the user guide section 14). It already verifies the signature and maps the repository to the project. The monitor
  records every `workflow_run` delivery (actions `requested`, `in_progress`, `completed`) for a repository of the project, independent of
  whether Auto-fix is on, before the Auto-fix handling. The webhook must include the "Workflow runs" event (it already does for Auto-fix).
  A project that has not set up the webhook has no data: the tab says so and links to the setup steps (shared with Auto-fix).
- Answer the webhook quickly (202) and do the storing and alerting in the background, as the Auto-fix path does; errors are logged, never
  thrown.
- Storage follows the repository pattern (SQLite and DynamoDB, `docs/plans/2026-11-02-repository-pattern.md`) and is created by an
  idempotent step on every database open, like `ensureAutofixSchema` (never a positional migration).
- A run is identified by GitHub's run id; re-run attempts (`run_attempt`) update the same row. Writes are conditional so concurrent or
  duplicate deliveries are idempotent, and "alerted" is set once per run id.
- Retention: keep the last 50 runs per repository and workflow; older rows are deleted when a new run is stored.
- UI: the user works on a phone: the tab must work at 360-412 px (rows stack, no horizontal page scroll); no coloured left stripes (status
  is shown as a tinted pill, as on the Auto-fix tab); theme tokens only.

## Approaches

1. **GitHub webhook (chosen).** Reuse the signed per-project webhook; instant, free between runs, fits the serverless deployment; each
   repository needs the webhook added once.
2. Poll GitHub every 5 minutes with the stored token. Rejected: alerts up to 5 minutes late, API usage grows with projects, needs a
   scheduled job running all the time.
3. Webhook plus an on-demand "Refresh from GitHub" button. Deferred: only worth adding if missed runs turn out to matter.

## Decisions taken in the conversation

- Alerts go to the project Inbox now, and to a Slack or Teams channel once the team has one (the channel is optional and off by default).
- Approach 1.

## Builder's calls (stated here so they can be checked)

- The tab lives in the project Setup page as "Pipelines" (alongside Auto-fix), because that is where the webhook is set up.
- Inbox alert type: the existing `blocked` type with `payload.kind = 'pipeline'` (the Inbox types are fixed by a database CHECK
  constraint), labelled "Deploy failed" in the Inbox.
- Chat message content: "Deploy failed: <workflow> on <repo>@<branch> (<short sha>) by <actor>. <run link>" and "Deploy recovered: ...".
  Slack gets `{ "text": ... }`; Teams gets a minimal Adaptive Card message.
- A failure on a branch that is not alerting, or of a workflow that is not a deploy workflow, is shown on the tab but not alerted.
- Live updates on the open tab use the existing project event stream (an event when a run is stored); no polling in the browser.
- Audit entries for changing the chat URL, the deploy-workflow rule and the alert branches.
- **Rows shown:** by default the tab lists the default branch and the alerting branches; other branches (feature, pull request,
  `autofix/...`) are behind "Show all branches". Storage keeps, per repository and workflow, the latest run of every branch it has seen plus
  the last 50 runs overall; the 50-run cap never deletes the latest run of a branch (so recovery matching and rows never silently vanish).
- **Ordering and recovery:** "later" means a higher GitHub `run_number` for the same workflow (not delivery order), so an older run that
  completes late cannot resolve or reopen an alert. A re-run attempt updates the same row: if it succeeds, that counts as recovery; if a later
  attempt fails again, it alerts again (alerts are keyed by run id and attempt).
- **One open alert per workflow and branch:** while an alert for a workflow/branch is open, further failing runs refresh that alert (latest
  run, a failure count) instead of adding new Inbox items; the first success with a higher run number resolves it.
- **Finding the alert:** a small alert-state record per repository, workflow and branch holds the open Inbox item id; recovery resolves that
  id. If a person already resolved it by hand, the automatic resolve does nothing.
- **Who sees what:** the Pipelines tab and its alerts are visible to every project member, like the Auto-fix findings and the Inbox today
  (the code shows project Inbox items to members). Only project owners and portal admins change the settings.
- **Chat delivery:** the Inbox alert and the chat message are tracked separately. The Inbox item is always created; the chat send is tried
  up to 3 times with a short backoff in the background; if it still fails, the failure is recorded and shown next to the setting ("last
  message failed at ..."), and nothing else is retried, so a GitHub redelivery never duplicates either.
- **Where settings live:** the deploy-workflow rule and the extra alert branches are a project setting (JSON under the settings store, like
  the Auto-fix policy); the chat URL is stored in the secret store and only its host and last 4 characters are ever shown back.
