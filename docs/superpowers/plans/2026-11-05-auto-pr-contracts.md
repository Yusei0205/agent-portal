# Auto pull request: shared contracts (tasks 3, 7, 8, 9, 10 all code against this)

If a task finds a contract wrong, it stops and reports; it does not quietly change it.

## A. Run payload (portal to runner)

`finalizeCheck?: boolean` on a normal run payload. When true and the run cloned repositories, the runner, after
the checks block, runs `detectChanges` for each repository folder it cloned and emits one `repo-changes` event
per repository that has changes. It never commits or pushes in a normal run.

## B. Event: runner to portal, at the end of a run

```json
{ "type": "repo-changes", "repo": "<repository name = folder under repos/>", "base": "<base branch>",
  "commits": 2, "files": 5 }
```

`base` is the repository's `branch` from the payload when set, else the remote default
(`git symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/` prefix).

## C. Finalize request (portal to runner), a separate invocation on the same AgentCore session

```json
{ "mode": "finalize", "repo": "<name>", "base": "main", "branch": "portal/RLP-12-fix-login",
  "message": "RLP-12: Fix login redirect", "protectedBranches": ["main","master","develop","release/*"],
  "defaultBranch": "main", "identity": { "name": "Agent Portal", "email": "agent-portal@users.noreply.invalid" },
  "env": { "GIT_CONFIG_COUNT": "1", "...": "the repository's git settings, as in the repos spec of a run" },
  "snapshot": { "...": "the same snapshot access a normal run gets, so the workspace can be restored" } }
```

Response events (SSE like other modes), then the stream ends:

```json
{ "type": "repo-pushed", "repo": "<name>", "branch": "portal/RLP-12-fix-login", "sha": "<40 hex>" }
{ "type": "repo-pushed", "repo": "<name>", "branch": "portal/RLP-12-fix-login", "error": "<redacted text>" }
{ "type": "status", "text": "..." }
```

The runner re-checks the branch name against `protectedBranches` and `defaultBranch` with `isProtectedBranch`
from `runner-finalize.ts`, and restores the saved workspace first when `repos/` is missing.

## D. Session event: portal to session (what the card shows)

One event type `pull-request`, written to the session's run events, one per state change per repository:

```json
{ "type": "pull-request", "repo": "<name>", "repoId": "<id>", "state": "<state>",
  "branch": "portal/...", "base": "main", "number": 42, "url": "https://...",
  "reviewId": "<id>", "title": "RLP-12: Fix login redirect", "commits": 2, "files": 5,
  "inboxId": "<id>", "error": "<text>", "errorCode": "no-permission|unsupported|failed|no-workspace" }
```

`state` is one of: `asked` (waiting for a person, has `inboxId`), `declined`, `available` (setting off or
expired; the button is offered), `pushing`, `pushed` (has `branch`), `opened` (has `number`, `url`),
`review-started` (adds `reviewId`), `review-failed` (PR stays, has `error`), `failed` (has `error`, and
`errorCode`; keeps `branch` if the push worked). Only the fields relevant to the state are present. The latest
event per `repo` wins.

## E. Portal functions (task 7 creates them, task 8 and the button route call them)

```ts
// server/session-pr.ts
export interface RepoChange { repo: string; base: string; commits: number; files: number }
export interface SessionPrContext {
  workflowId: string; runId: string; projectId: string; userId: string | null;
  engine: 'claude-code' | 'kiro';
}
export async function handleRepoChanges(ctx: SessionPrContext, changes: RepoChange[]): Promise<void>;
export async function createPullRequestForSession(
  workflowId: string, repoId: string, opts?: { approvedBy?: string },
): Promise<void>;
export function finalizeRunPayloadFlag(projectId: string, hasTicket: boolean): Promise<boolean>; // value of finalizeCheck
```

`handleRepoChanges` never throws to its caller: errors become a `pull-request` event with `state: 'failed'`.

## F. HTTP

`POST /api/sessions/:workflowId/pull-request` body `{ "repoId": "<id>" }`, editor of the session's project.
Responses: 202 `{ ok: true }` (work continues in the background and shows as events), 409 when an opened PR
already exists for that repository and session, 404 unknown session or repository.

## G. Texts shown to people (use these exactly)

- No permission: `No permission to push to <repo>. A GitHub token needs repo write access; CodeCommit needs GitPush and CreatePullRequest.`
- Pushed but PR failed: `The branch <branch> was pushed, but the pull request could not be opened: <error>`
- Host not supported: `Pull requests on <provider> are not supported yet. The branch <branch> was pushed.`
- Workspace gone: `The session's saved files could not be restored, so nothing was pushed.`
- Inbox question (title): `Open a pull request for <repo>?`; body: `<files> files changed in <commits> commit(s) in <repo>. Approve to push a new branch and open a pull request.`
