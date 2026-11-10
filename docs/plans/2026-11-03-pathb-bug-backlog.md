# P10 Repository Layer — Bug Backlog

Date: 2026-11-03
Author: backend-agent (pathb-serverless)

This file tracks known limitations and deferred work from the S2 P10 repository conversion.
Items are listed in priority order. Simple items should be fixed; hard items are explicitly deferred.

---

## Deferred: sync functions that could not be made async

### 1. `review-lifecycle.ts` — `handleReviewLifecycle` still uses direct SQLite

**Why deferred**: `setRunLifecycleHook` in `server/agent/runner.ts` accepts only a synchronous callback `(wfId, runId, event) => void`. Making the callback async requires changing the runner's hook signature, which touches shared infrastructure outside this agent's scope.

**Tables affected**: `p10_reviews` (read by `workflow_id`, write `status`, `started_at`, etc.)

**Fix**: Change `setRunLifecycleHook` to accept an async callback, then convert `handleReviewLifecycle` to async and use `getReviewsRepository()`.

---

### 2. `review.ts` — `processReviewOutput` still uses direct SQLite

**Why deferred**: `processReviewOutput` is called synchronously from `handleReviewLifecycle` (which is itself sync). Making it async would require (a) making `handleReviewLifecycle` async first, or (b) moving the call to a separate async step.

**Tables affected**: `p10_reviews` (read), `p10_findings` (read + insert)

**Fix**: After fixing item 1, convert `processReviewOutput` to async and use `getReviewsRepository().listFindings()` and `getReviewsRepository().createFinding()`.

---

### 3. `review.ts` — complex GET /api/projects/:id/reviews query still uses direct SQLite

**Why deferred**: The list endpoint has complex dynamic WHERE conditions (`runBy`, `account`, `status`, `type`, `repoId`, `dateFrom`, `dateTo`, `search`) plus a JOIN with `repositories` for `repo_name` and a subquery for `finding_count`. This pattern can't be cleanly expressed in the current `listByProject(projectId, opts)` interface.

**Fix**: Add `listByProjectFiltered(projectId, filters)` method to `ReviewsRepository` that handles the full filter set. For DynamoDB: load all, filter in-app (acceptable for modest volumes). For SQLite: pass filters to SQL.

---

### 4. `review.ts` — `checkAutoPostShouldSkip` queries `repositories` directly

**Why deferred**: The function needs `repo.url` and `repo.provider` to do a live PR head check. It currently uses `one<{url, provider}>('SELECT url, provider FROM repositories WHERE id = ?')`. This is a cross-module query; the git repos repository was not accessible when that function was originally written.

**Fix**: Import `getGitReposRepository()` and replace the `one(...)` call.

---

### 5. `review.ts` — POST /reviews creates `p6_workflows` with direct SQLite `insert`

**Why deferred**: Creating workflows is not part of the reviews repository contract. The `p6_workflows` table belongs to the sessions/workflows module.

**Fix**: This is intentional; `insert('p6_workflows', ...)` is the correct cross-module boundary for now.

---

### 6. `scan.ts` — `runEstimation` and `runScan` background functions use direct SQLite

**Why deferred**: Both functions are complex 100+ line background processes with multiple interleaved reads and writes to `p10_scans`, `p10_scan_files`, and `p10_reviews`. They also create `p10_reviews` inline. Converting them atomically risks introducing regressions in the scan pipeline.

**Tables affected**: `p10_scans`, `p10_scan_files`, `p10_reviews`, `p10_findings` (via `processReviewOutput`)

**Fix**: Convert incrementally, one function at a time, with full test coverage. Start with `runEstimation` (simpler), then `runScan`.

---

### 7. `scan.ts` — complex GET /api/projects/:id/scans query uses direct SQLite

**Why deferred**: Same reason as review list — dynamic WHERE conditions including `runBy`, `status`, `repoId`, `dateFrom`, `dateTo`, `search`, plus an ORDER BY and pagination.

**Fix**: Add `listByProjectFiltered(projectId, filters)` to `ScansRepository`.

---

### 8. `repos.ts` — `getRepo(id)` synchronous export still uses direct SQLite

**Why deferred**: `getRepo` is exported and imported by `server/diagrams.ts` which is not owned by this agent. Making it async would require updating `diagrams.ts`.

**Fix**: After diagrams.ts is converted, change `getRepo` to `async getRepo(id)` and use `getGitReposRepository().getById(id)`.

---

### 9. `reviews-dynamodb.ts` — `checkAlreadyPosted` always returns false

**Why deferred**: The SQLite implementation uses a JOIN between `p10_reviews` and `p10_findings` to check if a prior review for the same (repo, PR, sha) has any posted findings. DynamoDB has no efficient way to do this without a dedicated GSI (`GSI-P10ByRepoPR`).

**Fix**: Add `GSI-P10ByRepoPR` with PK=`REVREPO#<repoId>#<prNumber>`, SK=`<sourceSha>#<reviewId>`, sparse on items where `repo_id` and `pr_number` are set. Then implement the lookup in `checkAlreadyPosted`.

---

### 10. `git-connections.ts` — `resolveCodeCommitAwsCreds` still queries `aws_accounts` directly

**Why deferred**: `aws_accounts` is a separate module table not covered by the git-connections repository interface.

**Fix**: Create an `AwsAccountsRepository` when the aws-accounts module is converted. Then import and use it in `resolveCodeCommitAwsCreds`.

---

### 11. `review.ts` — POST /reviews, /post, /merge, /rerun route handlers still use some direct SQLite

The complex route handlers for merge, rerun, post, and export still use `one<Review>`, `all<Finding>`, `run(...)` for various operations. The core CRUD handlers (GET, DELETE, GET findings, PUT finding, POST create) are fully converted.

**Remaining direct calls in:**
- POST /merge: `one<Review>`, `all<Finding>`, `one<{url,provider}>` for repo
- POST /rerun: `one<Review>`, `insert('p10_reviews', ...)`, `one<Review>`
- GET list: full dynamic query
- POST /post: `repo` lookup via `one<{url,provider}>(repositories)`

**Fix**: Complete the conversion of each remaining handler. Use `getReviewsRepository()` for reviews/findings and `getGitReposRepository()` for repo lookups.

---

## Deferred: S2 pathb-serverless AI attachments / Create-module / Learn / Testing

### 12. `ai-attachments.ts` — `validateAttachmentIds` and `getAttachmentsView` still use direct SQLite

**Why deferred**: Both functions are synchronous and called from `diagramView()`, `presView()`, `docView()` helpers which are themselves called synchronously from route handlers. Making them async requires making those view helpers async (cascading 3 files, 20+ call sites).

**Tables affected**: `ai_attachments` (SELECT by id, SELECT by id + project_id)

**Fix (S3)**: Make `diagramView`, `presView`, `docView` async, add `await` at all call sites in diagrams.ts, presentations.ts, generated-docs.ts. Then replace `one('SELECT * FROM ai_attachments ...')` calls with `await getAiAttachmentRepository().getById(id)`.

---

### 13. `ai-attachments.ts` — `cleanupOrphanedAttachments` still uses direct SQLite

**Why deferred**: Called from `server/index.ts` synchronously (no `await`). Making it async would require `index.ts` to either fire-and-forget or await it, which touches shared infrastructure.

**Tables affected**: `ai_attachments` (SELECT orphans, DELETE)

**Fix (S3)**: Add `await cleanupOrphanedAttachments()` to `server/index.ts` scheduled cleanup, and convert the function to async using the repository.

---

### 14. `learn.ts` — all route handlers still use direct SQLite

**Why deferred**: `learn.ts` has 30+ route handlers with sync SQLite calls to `learn_docs`, `quizzes`, `quiz_attempts`, `paths`, `doc_reads`. The `requireProjectAccess` and `isEditorOf` helpers in learn.ts use direct SQLite for project/member lookups. Converting the full file would require making all route handlers async (most are already) and updating ~50 call sites.

**Tables affected**: `learn_docs`, `quizzes`, `quiz_attempts`, `paths`, `doc_reads`

**Fix (S3)**: Convert each section methodically. Start with `doc_reads` (simplest). Then learn_docs, quizzes, paths. Use `getLearnRepository()` throughout.

---

### 15. `diagrams.ts`, `presentations.ts`, `generated-docs.ts`, `doc-templates.ts` — still use direct SQLite for most routes

**Why deferred**: These files use direct SQLite for INSERT, UPDATE, DELETE, and all SELECT operations on their owned tables (`diagrams`, `diagram_versions`, `presentations`, `generated_docs`, `generated_doc_versions`, `doc_templates`). Repository implementations exist but source file conversion was deferred.

**What was converted**: `linkAttachmentsToParent`, `deleteAttachmentsForParent` now use the repository.

**Tables affected**: `diagrams`, `diagram_versions`, `presentations`, `generated_docs`, `generated_doc_versions`, `doc_templates`

**Fix (S3)**: For each file, replace `one('SELECT * FROM ...', ...)`, `insert(table, ...)`, `update(table, ...)`, `dbRun('DELETE ...')` with the corresponding repository method call.

---

### 16. `testing/` module files — all still use direct SQLite

**Why deferred**: The `testing-data` repository was created with full interfaces and SQLite/DynamoDB implementations. Converting 8+ source files in server/testing/ (projects.ts, scripts.ts, vault.ts, runner.ts, generate.ts, case-sets.ts, trace.ts) would require ~200 line changes with complex async cascades (e.g., isCancelled(), setProgress(), getCategoryOrder() called deep inside async generation loops).

**Tables affected**: `test_projects`, `test_groups`, `test_scripts`, `test_vault_items`, `test_vault_files`, `test_runs`, `test_run_steps`, `test_case_sets`, `test_cases`, `test_generations`, `trace_steps`

**Fix (S3)**: Convert one file at a time. Start with `testing/projects.ts` (simplest CRUD), then `testing/vault.ts`, then `testing/scripts.ts`, then `testing/runner.ts` and `generate.ts`, finally `case-sets.ts` and `trace.ts`.

---

### 17. `trace_steps` DynamoDB — `updateTraceStep` not implemented

**Why deferred**: trace_steps use PK=`TRACE_CS#<caseSetId>` or `TRACE_GN#<genId>` with SK=`<seq>`. The `updateTraceStep(id, fields)` call receives only the step `id`, not the caseSetId/seq needed to build the PK. A GSI on trace step id would be needed.

**Fix (S3)**: Add `GSI-TraceById` (PK=traceStepId) to the portal-testing table. Or change the function signature to `updateTraceStep(id, caseSetOrGenId, seq, fields)`.

---

### 18. `test_cases` DynamoDB — `updateCase` and `deleteCase` not implemented

**Why deferred**: test_cases use PK=`TC#<caseSetId>`, SK=`ORD#<ord>#<id>`. The `updateCase(id, fields)` call only has the case id, not the caseSetId+ord needed for the PK.

**Fix (S3)**: Same as #17 — add a GSI-CaseById or change the function signature.

---

### 19. Large text truncation — diagrams, generated-docs, presentations

**Why deferred**: DynamoDB items have a 400 KB limit. Diagram XML (drawio field), generated-doc markdown, and presentation preview_json can exceed this. Per the plan, truncation with a marker should be applied:
```typescript
const MAX_PAYLOAD_BYTES = 380_000;
const marker = `\n[TRUNCATED — original size: ${payload.length} bytes]`;
```

**Tables affected**: `diagram_versions.drawio`, `generated_doc_versions.md_path` (content), `presentations.preview_json`

**Fix (S3)**: Apply the `truncatePayload()` helper (from docs/plans/2026-11-02-repository-pattern.md section 5) in the DynamoDB `createVersion` and `update` methods.

---

### 20. `doc_reads` DynamoDB — `isRead` uses exact PK/SK lookup; works only for exact user-id match

**Why deferred**: DynamoDB `isRead` uses PK=`DREAD#<docId>`, SK=`<userId>`. This is correct for the primary read path. No issues expected.

**Note**: This is fine as-is.

---

### 21. `learn_docs` — `audience` column not added in migration M10

**Why deferred**: The M10 migration description says "Adds audience column to learn_docs" but the ALTER TABLE statement is missing from the migration SQL. The `audience` field in LearnDocRecord is not stored in SQLite learn_docs.

**Fix**: Add `ALTER TABLE learn_docs ADD COLUMN audience TEXT;` to a new migration M46 or similar, and update learn-sqlite.ts createDoc to include the column.


---

## S2 P11 — credentials, aws-accounts, integrations, themes, user-config, agentcore-login repositories

### 22. `credentials.ts` — `autoRefreshIdcIfNeeded` still reads before passing to `attemptTokenRefresh`

**Why deferred**: `autoRefreshIdcIfNeeded` fetches the credential row to check `extra.refreshTokenEnc`, then calls `attemptTokenRefresh(cred)`. In DynamoDB mode the repo getById call is an extra round-trip. Simple enough to leave as-is; no correctness issue.

### 23. `agentcore-login`: DynamoDB cross-Lambda poll not exposed via `pollAgentCoreLogin`

**Why deferred**: `pollAgentCoreLogin(credId)` is synchronous for backward compatibility with existing tests. In DynamoDB mode it reads from the in-memory map (which is empty on a different Lambda instance). True cross-Lambda polling requires the caller to use `getAgentcoreLoginRepository().get(credId)` directly. This is fine for now since kiro-agentcore only runs in single-instance mode in current deployments.

**Fix**: Add an async `pollAgentCoreLoginAsync(credId)` that reads from the repository. Update `credentials.ts` device-poll route to use the async version when DynamoDB is active.

### 24. `aws-accounts-dynamodb.ts` — `getById` uses two-step lookup (AWSACCTID + main item)

**Why deferred**: The `getById(id)` without projectId requires a lookup pointer item. This is a write-time overhead (two PutItemCommand calls on create). Works correctly but adds one extra read on the getById path.

**Fix (low priority)**: Add a GSI on `id` attribute instead of the manual lookup pointer.

### 25. `user-config.ts` — `materialiseForRun` still uses `one<Row>('SELECT created_by FROM p6_workflows...')`

**Why deferred**: The p6_workflows table belongs to the sessions module. Accessing it requires either importing the sessions repository or keeping direct SQL. Left as a direct SQL call since it's a cross-module query.

**Fix**: Import `getSessionsRepository()` and use `getSessionsRepository().getWorkflowById(workflowId)` to get `created_by`.

---

## Earlier items (restored — overwritten by a parallel edit)

### 22. Knowledge search (DynamoDB, knowledge-dynamodb.ts)
- Lazy cleanup in `searchDocs` calls `removeDocIndex(docId)` on one stale posting, which also deletes the doc's current postings.
- Concurrent `indexDoc` can leave orphan postings that `deleteDoc` never removes; use GSI-DocId.
- Tokenizer drops everything outside `[a-z0-9]` (accented, Cyrillic, CJK unsearchable).
- Terms with >100 postings return incomplete, unordered results.
- Stale-posting cleanup is fire-and-forget (Lambda may freeze it).

### 23. Dashboard / insights (DynamoDB)
- EDGESTATS rollup written best-effort outside a transaction.
- Approximations: p50/p95 null, toolCalls/toolErrors 0, provider null, admin cost-by-user ignores project filter.

### 24. Sessions (DynamoDB)
- Transcript route reads up to 10,000 events per page.
- Event payloads over 380 KB truncated (S3 overflow planned).
- emitRunEvent publishes id=0 after a persistent write failure.

### 25. Credentials / Kiro (batch B, reported)
- `pollAgentCoreLogin` keeps a sync compat shim; true cross-Lambda polling needs the async path.
- `materialiseForRun` in user-config.ts still reads p6_workflows directly.
- aws-accounts getById is a 2-step lookup.
- autoRefreshIdcIfNeeded does an extra repository round-trip.

### 26. Test tooling
- `test:affected` skips modules whose code hash already passed, even with DYNAMODB_ENDPOINT set. Run DynamoDB contract files directly.
