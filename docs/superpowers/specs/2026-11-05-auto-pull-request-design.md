# Open a pull request automatically when a session fixes code

Date: 2026-11-05
Branch: `feat/auto-pr` (from `feat/review-branch-dropdown`)
Status: approved by the owner on 2026-11-05 (with the protected-branches setting added)

## 1. Goal

After a session has changed a project repository, the portal pushes the work to a new branch, opens a pull
request for it, and starts a code review of that pull request with the branch, PR number and Jira key already
filled in.

Success looks like this:
- A session linked to a Jira ticket fixes code. When its run ends, a PR named after the ticket exists on the
  host, a draft review is waiting in the Reviews page, and the session shows a "Pull request #N" card.
- A session with no ticket that changed code asks a person (in the Inbox and the session) before anything is
  pushed or opened.
- A session that changed nothing does nothing: no branch, no PR, no review.

Not in scope: merging, posting review comments (reviews stay in draft mode), Bitbucket (a clear "not supported
yet" message), the local engine (sessions on a developer's own machine), Jira comments or status changes.

Said by you: GitHub and CodeCommit first; open the PR only when a fix was made to the project repo; with no
Jira ticket, let the user approve. Assumed by me: the defaults in section 8.

## 2. What exists today (checked in the code)

| Piece | State |
|---|---|
| Creating a PR on any host | Missing. Only read, comment, merge and review calls exist (`server/review.ts`). |
| `pending_push` column and the `push` Inbox type | In the schema, not used by any code. |
| Session to ticket | `workflow.jira_key`; `runner.ts` already fetches the ticket and emits a Jira meta event (key, URL, summary). |
| Cloud agent's checkout | Cloned inside the AgentCore microVM under `repos/<name>`, git settings carry the credential as an environment header (`runner-repos.ts`). |
| End-of-run hook in the runner | `agent-runner/src/run.ts` runs the loop's check steps after the agent finishes (`runner-checks.ts`, shared with the portal through `server/agent/runner-*.ts`). |
| Approval from the microVM | The runner can ask the portal for an answer (`approval-request`, fingerprint, expiry, one answer wins). |
| Reviews | `POST /api/projects/:id/reviews` takes repo, base, head, PR number, Jira key, post mode. |
| `@aws-sdk/client-codecommit` | Already a dependency. |

## 3. Behavior

1. A run ends and the runner has a project repository checked out.
2. **Detect.** For each repository under `repos/`, the runner compares with `origin/<base>`:
   uncommitted changes, or commits ahead. Nothing found: stop, emit nothing.
3. **Decide.**
   - Session has a Jira key and the project setting is on: continue automatically.
   - No Jira key: the runner sends an `approval-request` ("Open a pull request for N files changed in
     `<repo>`?"). It appears in the Inbox and on the session through the normal approval flow. Declined or
     expired: nothing is pushed, the changes stay in the session's saved workspace, and the session card offers
     **Create pull request** to retry later.
   - Project setting off: no automatic step; the card still offers the button.
4. **Push** (in the runner, not through the agent's shell):
   - New branch `portal/<KEY>-<slug>`, or `portal/<slug>` without a ticket. `<slug>` is from the ticket summary
     or the session goal: lowercase, `[a-z0-9-]`, at most 40 characters. A name that already exists on the
     remote gets `-2`, `-3`, and so on.
   - `git add -A` (files the protected-path guard blocks agents from editing are left out), one commit, a plain
     push. Never a force push, and never to a protected branch: the repository's default branch plus the
     project's **protected branches** list (section 4; default `main`, `master`, `develop`, `release/*`).
     The new branch's own name is checked against that list too, so `portal/...` can be protected as well.
5. **Create the PR** (in the portal): title `<KEY>: <ticket summary>`, or the first line of the session goal
   (at most 72 characters). Body: ticket link, session link, the agent's final message (cut and scrubbed of
   secret values), and a line saying it was opened by Agent Portal. If a PR for that head and base already
   exists, it is reused.
6. **Start the review** with repo, base, head, PR number, Jira key and post mode `draft`.
7. **Show it.** A `pull-request` event on the session (state: asked, pushed, opened, review started, failed,
   declined) drives a card with the PR link, the review link and the failure reason when there is one.

## 4. Components

| Unit | Where | What it does | Depends on |
|---|---|---|---|
| `runner-finalize.ts` | `server/agent/` (shared with `agent-runner`, like `runner-checks.ts`) | `detectChanges(repoDir, base)` and `pushBranch(repoDir, branch, env)`. Pure git, no portal imports. | git, `execFile` with arguments (no shell) |
| Finalize step | `agent-runner/src/run.ts`, after the checks | Calls detect, asks approval when needed, pushes, emits `repo-changes {repo, base, branch, commits, files, sha, pushed, error}`. Also a `finalize` mode so the button can run it on a restored workspace. | `runner-finalize.ts`, the approval relay |
| `pull-requests.ts` | `server/` | `createPullRequest({repo, base, head, title, body})` returning `{number, url, existing}`. GitHub through the REST API with the Git connection's token. CodeCommit through `CreatePullRequest` with the project's AWS account or the connection's keys (same resolution order as clones). Other hosts: a clear "not supported" error. | `getCloneEnv` credential sources, `@aws-sdk/client-codecommit` |
| `session-pr.ts` | `server/` | Reads `repo-changes` events at run end, applies the rules in section 3, calls `createPullRequest`, starts the review, writes `pull-request` events. Idempotent per session, repo and branch. | `pull-requests.ts`, review creation |
| Review creation | `server/review.ts` | Extract the body of the `POST /reviews` create step into a function the route and `session-pr.ts` both call. No behavior change to the route. | |
| Project settings | project configuration (Setup) | `openPullRequests`: on (default) or off. `protectedBranches`: a list of names or `*` patterns that the portal never pushes to (default `main`, `master`, `develop`, `release/*`; the repository's default branch is always protected on top of it). Sent to the runner with the run; the portal checks it again before creating the PR. | |
| Session card | `web/src/pages/sessions/` | Shows the `pull-request` state, links, and the Create pull request button. | |

Kiro: the Kiro runner (`kiro-runner`) gets the same finalize step from the shared module. The plan builds
Claude first and Kiro second; it is one feature, not two.

No new database table. The state lives in session events (replayed on reload), and duplicates are prevented by
looking the PR up on the host before creating one.

## 5. Data flow

```
run ends in the microVM
  runner: detect changes ──none──▶ end
     │ changes
     ├─ ticket + setting on ─────────────┐
     └─ no ticket: approval-request ─▶ portal Inbox ─▶ answer
                                          declined/expired ─▶ card: "Create pull request"
                                                              │ approved
  runner: branch, commit, push ◀──────────┘
  runner ──repo-changes event──▶ portal session-pr.ts
  portal: createPullRequest (GitHub / CodeCommit)  ──▶ pull-request event (opened)
  portal: create review (draft, filled in)          ──▶ pull-request event (review started)
```

## 6. Errors and limits

- **No push permission** (read-only token or IAM): the runner reports the redacted git error. The card says
  "No permission to push to `<repo>`. A GitHub token needs repo write access; CodeCommit needs GitPush and
  CreatePullRequest." Nothing is retried automatically; the button retries.
- **Push worked, PR creation failed:** the card keeps the branch name and the button creates only the PR.
- **PR already exists:** reused, no error.
- **Host not supported** (Bitbucket, other git): the branch is still pushed and the card says no PR was opened.
- **Several repositories changed:** one branch, PR and review per repository.
- **Lambda's 15-minute limit:** waiting for a person's approval uses the existing approval expiry. Past it, the
  request counts as declined and the button covers it.
- **Review start fails:** the PR stays; the card shows the reason and a link to start the review by hand.
- No secrets in branch names, titles, bodies, events or error text; hosts' URLs are shown without credentials.

## 7. Security

- Branch names pass the existing runner check (`^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$`, no `..`) and the
  project's protected-branches list. The list is enforced twice, in the runner before the push and in the portal
  before the PR, and only an editor of the project can change it.
- Ticket text, goal and agent output are untrusted: they go to the host only as JSON fields and to git only as
  `execFile` arguments, never through a shell.
- The finalize step uses the repository's own clone credentials; the microVM never holds a portal credential,
  and the PR is created from the portal side.
- The runner sets the commit identity from the repository's identity setting, else a neutral
  "Agent Portal" identity, so commits are not attributed to a person who did not write them.

## 8. Defaults I chose (change any of these in review)

1. The project setting `openPullRequests` is **on** by default (confirmed). With it on, a ticket session
   pushes a branch without asking.
2. One commit per repository, message `<KEY>: <summary>` (or the goal's first line).
3. Reviews started this way use post mode `draft` and the project's default minimum severity.
4. The PR body includes the session link only when the portal's public URL is configured.

## 9. Testing

- `runner-finalize`: real temporary git repositories and a local bare remote: no changes, uncommitted changes,
  commits ahead, name collision, refusal of default and protected branches, push failure text redacted.
- `pull-requests`: GitHub with a stand-in HTTP server (create, already exists, 401, 403); CodeCommit with a
  mocked client (create, already exists, access denied); unsupported host.
- `session-pr`: stand-in runner events through the portal, as in `agentcore-portal.test.ts`: ticket run opens PR
  and review; no-ticket run waits for approval, then opens (approve) or stops (decline, expiry); no-change run
  does nothing; repeated end-of-run events create one PR.
- Runner end to end (`npm run test:engine`): the finalize step with the real engine, a local remote, and a
  stand-in model that edits a file.
- Web: the card in each state.
- Live, one round (confirmed by the owner, needs AWS and a real repository): a ticket session on a CodeCommit
  repository, and the same on GitHub if a test repository is available. The run checks the push, the PR, the
  draft review and the card, and the permission-error text when the push is refused.
- Protected branches: pushing to a listed name or pattern is refused in the runner and again in the portal.

## 10. Risks to confirm

- The agent's checkout may be read-only for pushing today (token scope, IAM). The first live run tells us; the
  error message above is the fallback.
- The Kiro runner's end-of-run point has not been inspected yet; the plan's first Kiro task is to confirm it.
