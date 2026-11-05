# Auto pull request: implementation plan

Spec: `docs/superpowers/specs/2026-11-05-auto-pull-request-design.md` (approved 2026-11-05)
Branch: `feat/auto-pr`
Rules for every task: write the failing test first, run it, make it pass, run the area's tests and
`npx tsc --noEmit -p .` (and `cd agent-runner && npx tsc --noEmit` when the runner changed), then commit with
the task's message. Tests run one file at a time with `node --import tsx --test <file>`; `npm run test:engine`
for the runner end to end. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Task 1: Check that a restored workspace still holds the changes (gate for everything else)

Finalize can run on a fresh machine, so the saved workspace must carry uncommitted changes and local commits.

- Read `server/agent/runner-snapshot.ts` and `agent-runner/src/` for how `repos/` is packed and restored.
- Add `test/runner-snapshot-finalize.test.ts`: create a temporary git repo under a fake `repos/`, make one
  uncommitted change and one local commit, pack it and unpack it to a new folder with the module's own
  functions, and assert `git status --porcelain` and `git rev-list --count origin/main..HEAD` match.
- If it fails (for example `.git` is excluded, or only changed files are packed), stop and report to the owner:
  the spec's "finalize after an idle gap" needs a fix first. If it passes, commit the test.

Commit: `test: a restored session workspace keeps uncommitted changes and local commits`

## Task 2: `server/agent/runner-finalize.ts` (shared module, pure git)

Files: create `server/agent/runner-finalize.ts`, `test/runner-finalize.test.ts`. The module imports only `node:*`.
It is copied into the runner build the same way `runner-checks.ts` is (see `agent-runner/build.mjs` and how
`../shared/runner-checks.js` is resolved; mirror that for `runner-finalize`).

Interfaces:

```ts
export interface RepoChanges { repo: string; base: string; commits: number; files: number }
export function slugify(text: string, max = 40): string                       // [a-z0-9-], no leading/trailing dash
export function branchNameFor(opts: { ticketKey?: string | null; title: string; taken?: string[] }): string
//   portal/<KEY>-<slug> or portal/<slug>; on a clash append -2, -3, ...
export function isProtectedBranch(name: string, patterns: string[], defaultBranch?: string | null): boolean
//   exact names and `*` patterns (`release/*`); the default branch is always protected
export async function detectChanges(repoDir: string, base: string): Promise<{ commits: number; files: number }>
//   `git status --porcelain` count + `git rev-list --count origin/<base>..HEAD`; files also counts committed files
//   via `git diff --name-only origin/<base>...HEAD`
export async function pushBranch(opts: {
  repoDir: string; base: string; branch: string; message: string; env: Record<string, string>;
  protectedPatterns: string[]; defaultBranch?: string | null; identity?: { name: string; email: string };
  excludePaths?: string[];                                                      // paths the guard protects
}): Promise<{ sha: string }>                                                    // throws with a redacted message
```

Rules in `pushBranch`: refuse a protected branch name or a name failing `^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$` or
containing `..`; `git checkout -b`; `git add -A -- . ':(exclude)<p>'` per excluded path; commit only when there is
something staged (otherwise reuse the existing commits); `git push origin <branch>` (never `--force`,
`--mirror`, or a refspec that targets another name); all through `execFile` with arguments and `env`.

Tests (real temporary repos and a local bare remote): `slugify` cases; `branchNameFor` with and without ticket and
with a clash; `isProtectedBranch` (exact, `release/*`, default branch, a name that only starts like a pattern);
`detectChanges` for none, uncommitted only, commits only, both; `pushBranch` pushes a new branch and the remote
has it; refuses `main`; refuses a name matching a pattern; excluded path is not committed; failing push (remote
removed) rejects with no URL credentials in the message.

Commit: `feat(runner): finalize helpers: detect changes, branch names, protected branches, push`

## Task 3: Runner payload and modes

Files: `agent-runner/src/validate.ts`, `agent-runner/src/index.ts`, `agent-runner/src/run.ts`,
`test/agent-runner-validation.test.ts`, `test/engine/agentcore-runner-engine.test.ts`.

1. `validate.ts`: allow `finalizeCheck: true` on a run (turn on the detect step) and a new mode `finalize` with
   fields `repo`, `base`, `branch`, `message`, `protectedBranches` (array of strings, max 50, each at most 200),
   `defaultBranch`, `identity {name,email}`. Validation tests for each field and for unknown fields.
2. `run.ts`: after the checks block (`runCheckSteps`), when `payload.finalizeCheck`, run `detectChanges` for each
   repository folder under `repos/` that the payload cloned; emit `{ type: 'repo-changes', repo, base, commits,
   files }` for each one with changes. Never push here. The base is the repository's `branch` from the payload,
   else the remote's default (`git symbolic-ref refs/remotes/origin/HEAD`).
3. `index.ts`: new request mode `finalize` (next to `inspect`): validates, restores the saved workspace if
   `repos/` is missing (same function the normal run uses), calls `pushBranch` with the repo's own `env` (the
   portal sends the repository's git settings again, as it does for `prepare`), streams `repo-pushed
   {repo, branch, sha}` or `repo-pushed {repo, branch, error}` and ends.
4. Engine test: a runner with a local bare remote, a stand-in model that edits a file; assert one `repo-changes`
   at the end of the run, none when the file is untouched, and `finalize` pushes the branch to the remote.

Commit: `feat(runner): report repository changes at run end; finalize mode pushes a new branch`

## Task 4: `server/pull-requests.ts` (GitHub, CodeCommit)

Files: create `server/pull-requests.ts`, `test/pull-requests.test.ts`.

```ts
export interface CreatePrInput { repo: Repository; base: string; head: string; title: string; body: string }
export interface CreatedPr { number: number; url: string; existing: boolean }
export async function createPullRequest(input: CreatePrInput): Promise<CreatedPr>   // throws PullRequestError
export class PullRequestError extends Error { code: 'no-permission' | 'unsupported' | 'failed'; }
```

- GitHub: token from the repository's Git connection (reuse the credential lookup that `getCloneEnv` uses; do not
  add a second one). `POST /repos/{o}/{r}/pulls`; on 422 "already exists" list `pulls?head={o}:{head}&state=open`
  and return it with `existing: true`; 401/403/404 map to `no-permission` with the text above.
- CodeCommit: `CreatePullRequestCommand` from `@aws-sdk/client-codecommit` with credentials resolved the same way
  clones resolve them (`getCloneEnv` order: project default AWS account, then the connection). Existing PR:
  `ListPullRequests` for the repository with the same source and destination, open. Access denied maps to
  `no-permission`.
- Others (Bitbucket, git): `PullRequestError('unsupported')`.
- Title cut at 120 characters, body at 60,000, body passed through the existing secret scrubber used for review posts.
- Expose a `_setClients()` test seam like `review.ts` does (`_providers`) so tests use a stand-in HTTP server and a
  mocked CodeCommit client.

Tests: GitHub create, already exists, 401, 403, 404; CodeCommit create, already exists, access denied;
unsupported host; secret in the body is scrubbed.

Commit: `feat: create pull requests on GitHub and CodeCommit`

## Task 5: Project settings `openPullRequests` and `protectedBranches`

Files: `server/project-settings-pr.ts` (new, small), its routes registered next to the project routes,
`web/src/pages/` project Setup (find the file with the Setup tabs by searching for "Agent setup"/"Setup" tab
registry), `test/project-pr-settings.test.ts`.

- Storage: `setSetting(getDb(), key, JSON.stringify(value))` with keys `project:<id>:openPullRequests` (boolean,
  default `true`) and `project:<id>:protectedBranches` (string array, default `["main","master","develop","release/*"]`),
  the same way `project-aws.ts` stores its default account.
- `GET/PUT /api/projects/:id/pull-request-settings`; GET for members, PUT for editors; validate: at most 50
  entries, each `^[A-Za-z0-9*][A-Za-z0-9._/*-]{0,199}$`, trimmed, de-duplicated.
- UI: on the project's Setup page, a section "Pull requests": a switch "Open a pull request when a session fixes
  code" and a list editor "Branches that are never pushed to" (the repository's default branch is always
  protected: say so under the list).
- Tests: defaults, update, validation errors, viewer cannot update.

Commit: `feat: project settings for automatic pull requests and protected branches`

## Task 6: Extract review creation

Files: `server/review.ts`, `test/review-create.test.ts` (new) plus the existing review tests.

- Move the body of `POST /api/projects/:id/reviews` (after the validation of `body`) into
  `export async function createReview(input: { projectId; userId; repoId; baseRef; headRef; prNumber?; jiraKey?;
  postMode?; minSeverity?; ... }): Promise<Review>`. The route calls it. No behavior change.
- Run the existing review tests before and after (`ls test | grep -i review`); both runs must match.
- New test: call `createReview` directly with a repository, PR number and Jira key; the review has them set.

Commit: `refactor(review): createReview() shared by the route and by automatic pull requests`

## Task 7: `server/session-pr.ts` (decide, ask, finalize, create, review)

Files: create `server/session-pr.ts`, `test/session-pr.test.ts`.

```ts
export async function handleRepoChanges(ctx: { workflowId; runId; projectId; userId; engineSession: ... }, changes: RepoChangesEvent[]): Promise<void>
export async function createPullRequestForSession(workflowId: string, repoId: string, opts?: { approvedBy?: string }): Promise<void>  // also used by the button route
```

Steps in `handleRepoChanges` for each changed repository:
1. Skip if a `pull-request` event with state `opened`/`review-started` already exists for the session, repository
   and branch (idempotent).
2. Read the settings (Task 5) and `workflow.jira_key`.
3. Ticket and setting on: go to step 5. No ticket: `createInboxItem({ type: 'push', ... })` with the question and
   the repository and counts; write `pull-request {state:'asked'}`; return. The Inbox answer route calls
   `createPullRequestForSession(..., {approvedBy})` on approve and writes `state:'declined'` on decline.
   Setting off: write `state:'available'` and return (the button covers it).
4. (Reserved: the Inbox answer path.)
5. Choose the branch name with `branchNameFor` (ticket key, ticket summary or goal first line) using the remote's
   existing branches from the branch-list helper; check `isProtectedBranch`; invoke the runner in `finalize` mode
   on the same AgentCore session (`agentCoreSessionId(workflowId, engine)`) through the existing invoke helper
   and read `repo-pushed`; write `pull-request {state:'pushed', branch}` or `{state:'failed', error}`.
6. `createPullRequest` (Task 4) with title and body from the spec; write `{state:'opened', number, url}`.
7. `createReview` (Task 6) with repo, base, head, PR number, Jira key, `postMode: 'draft'`; write
   `{state:'review-started', reviewId}`. A failure here writes `{state:'review-failed', error}`; the PR stays.
8. Re-check `isProtectedBranch` in the portal before step 6 (second enforcement).

Tests (stand-in runner like `test/agentcore-portal.test.ts`, stand-in provider): ticket session opens PR and
review; no-ticket session creates one Inbox item and nothing else; approve completes; decline writes `declined`;
setting off writes `available`; protected name refused; repeated `repo-changes` events create one PR; push
failure shows the no-permission text; PR failure after a push keeps the branch in the event.

Commit: `feat: sessions open a pull request and start a review after a fix`

## Task 8: Hook into the Claude AgentCore paths and the button route

Files: `server/agent/claude-agentcore.ts` (user-credential path), `server/agent/claude-agentcore-bedrock.ts`
(harness path), a new route in `server/sessions` area (locate with `grep -rn "registerSessionRoutes\|/api/sessions" server`),
`test/agentcore-portal.test.ts` or `test/claude-agentcore.test.ts`.

- Send `finalizeCheck: true` in the run payload when the run has repositories and `openPullRequests` is on or the
  session has a ticket (so the button state is known).
- Collect `repo-changes` events in the event loop of both paths; after the run's result is recorded, call
  `handleRepoChanges`. An error there is logged and written as a `pull-request` `failed` event; it never fails the run.
- `POST /api/sessions/:workflowId/pull-request {repoId}` (editor): calls `createPullRequestForSession`; refuses
  when the session already has an opened PR for that repository.
- Tests: both paths forward `repo-changes` to `handleRepoChanges`; a failure in it does not fail the run.

Commit: `feat: AgentCore Claude runs hand repository changes to the pull request step`

## Task 9: Session card

Files: `web/src/pages/sessions/SessionLive.jsx` (or a new `PullRequestCard.jsx` it imports),
`web/src/pages/sessions/SessionWorkspace.jsx` if the card belongs there; `test` for the pure state-to-text function.

- A card driven by the latest `pull-request` event per repository: asked (links to the Inbox), pushed, opened
  (link, "#N"), review started (link to the review), declined/available (button "Create pull request"), failed
  (reason and "Try again"). Texts exactly as in spec section 6.
- Put the state-to-text mapping in a small pure function in `web/src/lib/` so it can be unit tested.
- Check in a browser at desktop and phone widths, with a stand-in session that has one event of each state.

Commit: `feat(web): pull request card on the session`

## Task 10: Kiro runner

Files: `kiro-runner/src/` (find the end-of-run point first), the same shared `runner-finalize`, `server/agent/kiro-agentcore.ts`.

- First step: read where `kiro-runner` ends a run and where its modes are dispatched; write the findings in the
  commit message. Then the same three pieces as Claude: detect at run end, `finalize` mode, portal hook.
- Tests: the runner's existing test style plus a `kiro-agentcore` portal test for forwarding the event.

Commit: `feat: Kiro runs open pull requests the same way`

## Task 11: One live round, docs, cleanup

1. Deploy the runner images (the deploy workflow does this on a push to `main_v3`; with the owner's go-ahead,
   or by hand with `node infra/scripts/deploy-harness.mjs`).
2. With the owner, run one session linked to a Jira ticket on a real CodeCommit repository, and one on GitHub if a
   test repository exists. Check: branch pushed, PR created, draft review filled in, card states, and the
   no-permission text when the credential cannot push.
3. Docs: a section in `README.md` and `docs/user-guide.md` ("Pull requests from sessions"), and `docs/requirements-spec.md` rows.
4. Add the new test files to `test/test-map.json`; `npm run test:map:check` shows no new unmapped files.

Commit: `docs: pull requests from sessions`

## Order and size

Tasks 1 to 3 are the runner, 4 to 6 are independent portal pieces that can be done in any order, 7 to 9 depend on
all of them, 10 and 11 come last. Task 1 decides whether the rest stands; stop and report if it fails.
