/**
 * Repository interface for the P6 sessions hot path.
 *
 * Covers five tables: p6_workflows, p6_runs, p6_events, p6_inputs,
 * p6_workflow_events.
 *
 * Access patterns F1–F13 from docs/plans/2026-11-02-dynamodb-data-design.md.
 *
 * SQLite is the default backend.  DynamoDB is activated by USE_DYNAMODB=true.
 *
 * DynamoDB tables used:
 *   portal-runs   — workflows, runs, inputs, workflow-events
 *   portal-events — run events (isolated for high write throughput)
 *
 * Key design for portal-runs:
 *   WF#<workflowId>  | #META                         — workflow row
 *   WF#<workflowId>  | RUN#<isoCreatedAt>#<runId>     — run rows (sorted newest-first with ScanIndexForward=false)
 *   WF#<workflowId>  | WFEVT#<isoCreatedAt>#<id>      — workflow events
 *   RUN#<runId>      | INPUT#<inputId>                 — inputs
 *   RUN#<runId>      | #SEQ                            — atomic sequence counter for events
 *
 * Key design for portal-events:
 *   RUN#<runId>  | SEQ#<10-digit-zero-padded-seq>    — p6_events rows
 *
 * Oversized-payload strategy (documented here per repository-pattern.md requirement):
 *   Event payloads that exceed 380 000 bytes when JSON-serialised are truncated
 *   to 380 000 bytes and a marker string `\n[PAYLOAD TRUNCATED — original size:
 *   <N> bytes]` is appended.  The DynamoDB item stores the truncated payload as a
 *   string attribute.  This keeps every event within the 400 KB item limit without
 *   requiring S3 in phase S1.  An S3-overflow strategy (write full payload to S3,
 *   store S3 key as `payloadS3Key`) is the planned S2 improvement and is already
 *   described in the data-design doc section 4.8.
 */

import { SqliteSessionsRepository } from './sessions-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Record types ───────────────────────────────────────────────────────────────

export interface WorkflowRecord {
  id: string;
  project_id: string | null;
  title: string;
  goal: string;
  status: string;
  stop_reason: string;
  engine: string;
  trust_tools: number;
  lead_agent: string | null;
  workspace_id: string | null;
  output_files_enabled: number;
  repo_ids: string;
  /** Which MCP integrations this session gets: '[]' = the project's enabled ones, '{"ids":[...]}' = only those. */
  integrations?: string;
  iteration_count: number;
  max_iterations: number;
  last_turn_at: string | null;
  credential_id: string | null;
  model: string;
  engine_session_id: string | null;
  engine_session_engine: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
  work_dir: string | null;
  jira_key: string;
  jira_summary: string;
  jira_url: string;
  kind: string | null;
  run_timeout_minutes: number | null;
  /** State of an iterating (loop) session as JSON, '' for an ordinary session. See workflows/loop.ts. */
  loop_state?: string;
  /** Per-workflow spend cap per run (FR-GUARD-10); null uses Settings › Limits. */
  budget_usd?: number | null;
  // enrichment fields (populated by listWorkflowsByProject / enrichWorkflowRow)
  parent_title?: string | null;
  child_count?: number;
  resumable?: boolean;
  lastRunStatus?: string | null;
}

export interface RunRecord {
  id: string;
  workflow_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  /** Kiro credits used by the run. Kiro bills in credits, not dollars, so they are kept apart from cost_usd. */
  credits: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  created_at: string;
  stop_reason: string | null;
  time_limit_at: string | null;
  model: string | null;
  error: string | null;
}

export interface EventRecord {
  id: number;
  run_id: string;
  type: string;
  payload: string;
  created_at: string;
}

/** Returned by appendRunEvent — callers need the integer id for the event bus. */
export interface AppendedEvent {
  id: number;
  created_at: string;
}

export interface InputRecord {
  id: string;
  run_id: string;
  project_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  payload: string;
  input_hash: string | null;
  type: string;
  status: string;
  allow_all: number;
  response: string | null;
  answered_by: string | null;
  answered_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface WorkflowEventRecord {
  id: number;
  workflow_id: string;
  kind: string;
  body: string;
  data: string | null;
  created_at: string;
  consumed: number;
}

// ── Input types ────────────────────────────────────────────────────────────────

export interface CreateWorkflowInput {
  id: string;
  project_id: string | null;
  title?: string;
  goal: string;
  status: string;
  stop_reason?: string;
  engine: string;
  trust_tools: number;
  lead_agent: string | null;
  workspace_id: string | null;
  output_files_enabled: number;
  repo_ids: string;
  iteration_count: number;
  max_iterations: number;
  credential_id: string | null;
  model: string;
  jira_key?: string;
  jira_summary?: string;
  jira_url?: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  parent_id?: string | null;
  /** 'review' for code-review sessions; null for ordinary sessions. */
  kind?: string | null;
}

export interface CreateRunInput {
  id: string;
  workflow_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

export interface CreateInputInput {
  id: string;
  run_id: string;
  project_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  payload: string;
  input_hash: string | null;
  type: string;
  status: string;
  allow_all: number;
  expires_at: string | null;
  created_at: string;
}

export interface CreateWorkflowEventInput {
  workflow_id: string;
  kind: string;
  body: string;
  data: string | null;
  created_at: string;
}

// ── Transcript types ──────────────────────────────────────────────────────────

/**
 * One row in the merged transcript (run event or workflow event).
 * src='r': from p6_events (agent output).
 * src='w': from p6_workflow_events (human messages, commands, system notes).
 */
export type TranscriptRow = {
  src: 'r' | 'w';
  id: number;
  created_at: string;
  kind: string;
  body: string;  // raw payload string for run events; body text for workflow events
  run_id: string | null;
};

/**
 * Opaque cursor for transcript pagination.
 * Encodes the position of the last (oldest) row on the current page.
 */
export type TranscriptCursor = { ts: string; src: 'r' | 'w'; id: number };

// ── Options ────────────────────────────────────────────────────────────────────

export interface ListWorkflowsOpts {
  /** Max rows (default 50, max 200). */
  limit?: number;
  /** Byte offset for SQLite pagination. Ignored in DynamoDB mode. */
  offset?: number;
  /** Opaque cursor for DynamoDB pagination (ExclusiveStartKey JSON). */
  cursor?: string;
  /** Exact status filter. */
  status?: string;
  /** Exact engine filter. */
  engine?: string;
  /** LIKE match on goal (SQLite only; DynamoDB returns unfiltered). */
  search?: string;
}

export interface RunTotals {
  total_cost: number;
  /** Sum of Kiro credits. */
  total_credits: number;
  total_input: number;
  total_output: number;
}

// ── Run finalization stats hint ───────────────────────────────────────────────

/**
 * Hint passed to finalizeRun() so the implementation can write per-project
 * and per-agent stats rollups atomically with the run status transition.
 *
 * DynamoDB: bundled in the same TransactWriteItems as the run UpdateItem.
 * SQLite:   ignored — stats are computed from live queries.
 */
export interface RunFinalizeStats {
  /** UTC date (YYYY-MM-DD) for the rollup bucket, e.g. now().slice(0, 10). */
  dateUTC: string;
  /** Project ID for RUNSTATS and AGENTSTATS rollup keys. Null → 'UNSCOPED'. */
  projectId: string | null;
  /** Normalized agent name for AGENTSTATS key ('default' for null/empty). */
  agentName: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface SessionsRepository {
  // ── Workflows ─────────────────────────────────────────────────────────────

  /**
   * F2: Get workflow by primary key.
   * Returns null when not found.
   */
  getWorkflowById(id: string): Promise<WorkflowRecord | null>;

  /**
   * Get workflow by (projectId, workflowId) — enforces project-scoping.
   * Returns null when not found or project_id does not match.
   */
  getWorkflowByProjectId(projectId: string, workflowId: string): Promise<WorkflowRecord | null>;

  /**
   * F1: List workflows for a project, newest updated_at first.
   * Returns rows enriched with parent_title and child_count.
   * Returns { workflows, total, cursor? }.
   * cursor is set when there are more pages (DynamoDB mode); undefined in SQLite.
   * total: exact count in SQLite; null in DynamoDB (too expensive to compute).
   */
  listWorkflowsByProject(
    projectId: string,
    opts?: ListWorkflowsOpts,
  ): Promise<{ workflows: WorkflowRecord[]; total: number | null; cursor?: string }>;

  /**
   * F10: List all workflows with status='running'.
   * Used by the controls / idle-stop checker.
   * DynamoDB: queries GSI-WorkflowStatus across known projectIds (best-effort).
   */
  listRunningWorkflows(): Promise<WorkflowRecord[]>;

  /**
   * List workflows in done/pending state whose last_turn_at is before cutoff
   * and whose stop_reason is '' (not yet idle-stopped).
   * Used by the idle-stop timer.
   */
  listIdleWorkflows(cutoff: string): Promise<WorkflowRecord[]>;

  /**
   * List child workflows of a given parent workflow, newest created_at first.
   * F8 child count uses the child_count counter; this method returns full rows.
   */
  listChildWorkflows(parentId: string): Promise<WorkflowRecord[]>;

  /**
   * Create a workflow record.
   * DynamoDB: also initialises childCount=0 and writes to GSI-ProjectWorkflows index.
   */
  createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord>;

  /**
   * Conditional update on a workflow: only applies the patch when the current
   * status equals expectedStatus. Returns true when applied, false on lost race.
   *
   * SQLite: UPDATE ... WHERE status = ? and checks changes > 0.
   * DynamoDB: ConditionExpression #status = :expected.
   *
   * opts.hintParentId: caller-supplied parent_id (avoids an extra GetItem when
   * the caller already has the workflow loaded). Used by DynamoDB to manage the
   * GSI-ChildIdle sparse index (childIdleCandidate attribute).
   */
  updateWorkflowConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<WorkflowRecord>,
    opts?: { hintParentId?: string | null },
  ): Promise<boolean>;

  /**
   * Apply a partial patch to a workflow row.
   * All specified fields are written; unspecified fields are unchanged.
   */
  updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<void>;

  /**
   * Delete a workflow and its associated runs/events/inputs/workflow-events.
   * DynamoDB: cascades to child items under the WF# and RUN# partitions.
   */
  deleteWorkflow(id: string): Promise<void>;

  /**
   * Atomically increment iteration_count by 1 on a workflow.
   * Used when a run completes successfully.
   * DynamoDB: ADD iteration_count :one (no conditional needed — increments are idempotent).
   */
  incrementWorkflowIteration(id: string): Promise<void>;

  /**
   * F8: Atomically increment or decrement childCount by delta (+1 or -1).
   * Called when a child workflow is created or deleted.
   */
  incrementWorkflowChildCount(parentId: string, delta: 1 | -1): Promise<void>;

  // ── Runs ──────────────────────────────────────────────────────────────────

  /**
   * F6: Get run by its own primary key.
   * Returns null when not found.
   */
  getRunById(id: string): Promise<RunRecord | null>;

  /**
   * Get run by (workflowId, runId) — enforces workflow-scoping.
   * Returns null when not found or workflow_id does not match.
   */
  getRunByWorkflowAndId(workflowId: string, runId: string): Promise<RunRecord | null>;

  /**
   * F4: Get the latest run for a workflow (newest created_at).
   * Returns null when no runs exist.
   */
  getLatestRun(workflowId: string): Promise<RunRecord | null>;

  /**
   * Get the currently active run for a workflow (status in pending/running).
   * Returns null when no active run.
   */
  getActiveRun(workflowId: string): Promise<RunRecord | null>;

  /**
   * F3: List runs for a workflow, newest first.
   * limit defaults to 100.
   */
  listRunsByWorkflow(workflowId: string, limit?: number): Promise<RunRecord[]>;

  /**
   * Compute aggregate totals for all runs of a workflow.
   * Used by the status bar (SUM cost_usd, input_tokens, output_tokens).
   */
  getRunTotals(workflowId: string): Promise<RunTotals>;

  /** Create a run record. Returns the created row. */
  createRun(input: CreateRunInput): Promise<RunRecord>;

  /** Apply a partial patch to a run row. */
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;

  /**
   * Conditional update on a run: only applies the patch when the current
   * status equals expectedStatus. Returns true when applied, false on lost race.
   *
   * SQLite: UPDATE ... WHERE status = ? and checks changes > 0.
   * DynamoDB: ConditionExpression #status = :expected.
   */
  updateRunConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean>;

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Append a single run event. Returns { id, created_at } where id is the
   * integer sequence number (SQLite rowid or DynamoDB atomic counter value).
   * Concurrent appends to the same run are serialised by the counter; order
   * is strict and gap-free on both backends.
   *
   * DynamoDB: if the serialised payload exceeds 380 000 bytes, it is truncated
   * to 380 000 bytes with a `[PAYLOAD TRUNCATED — original size: N bytes]` marker
   * so the 400 KB item limit is never exceeded.
   */
  appendRunEvent(runId: string, type: string, payload: string, createdAt: string): Promise<AppendedEvent>;

  /**
   * F5: List events for a run, ascending by id, starting from fromId (exclusive).
   * limit defaults to 100.
   */
  listRunEventsFrom(runId: string, fromId: number, limit?: number): Promise<EventRecord[]>;

  /**
   * List ALL events for a run in ascending order (for SSE replay and recap).
   * limit defaults to 5000 (effectively unbounded).
   */
  listRunEvents(runId: string, limit?: number): Promise<EventRecord[]>;

  /**
   * Backward scroll: list events before beforeId (exclusive), descending.
   * Used by MCP server scrollback (pattern M2).
   * limit defaults to 100.
   */
  listRunEventsBefore(runId: string, beforeId: number, limit?: number): Promise<EventRecord[]>;

  /**
   * List events across all runs of a workflow, newest first, filtered by type.
   * Used by session-lifecycle.ts for browser state and subagent events.
   * Joins p6_events → p6_runs → workflow.
   * DynamoDB: queries each run's events partition.
   */
  listWorkflowRunEventsByType(
    workflowId: string,
    types: string[],
    limit?: number,
  ): Promise<EventRecord[]>;

  /**
   * List 'run-complete' events for all runs of a workflow except excludeRunId.
   * Optionally filtered to events after afterDate.
   * Used by recap.ts.
   */
  listRunCompletionEvents(
    workflowId: string,
    excludeRunId: string,
    afterDate?: string | null,
  ): Promise<Array<{ payload: string; created_at: string }>>;

  // ── Inputs ────────────────────────────────────────────────────────────────

  /** Create an input (approval) record. Returns the created row. */
  createInput(input: CreateInputInput): Promise<InputRecord>;

  /** Get input by id. Returns null when not found. */
  getInputById(id: string): Promise<InputRecord | null>;

  /**
   * Get input by (runId, inputId) — direct key lookup.
   * SQLite: SELECT WHERE run_id = ? AND id = ?
   * DynamoDB: GetItem PK=RUN#<runId>, SK=INPUT#<inputId>
   */
  getInputByRunAndId(runId: string, inputId: string): Promise<InputRecord | null>;

  /**
   * F13: Get input by (inputHash, runId).
   * Returns null when not found.
   */
  getInputByHash(inputHash: string, runId: string): Promise<InputRecord | null>;

  /**
   * F7: Get pending input for a run.
   * Returns the first pending input or null.
   */
  getPendingInput(runId: string): Promise<InputRecord | null>;

  /**
   * List all inputs for a run (used by kiro.ts to check for permission requests).
   */
  listInputsByRun(runId: string): Promise<InputRecord[]>;

  /**
   * Conditional update: only applies the patch when the current status equals
   * expectedStatus.  Returns true when the update was applied, false when the
   * condition did not hold (another writer won the race).
   *
   * SQLite: uses UPDATE ... WHERE status = ? and checks changes > 0.
   * DynamoDB: uses ConditionExpression: #status = :expected.
   */
  updateInputConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<InputRecord>,
  ): Promise<boolean>;

  /** Unconditional partial update on an input record. */
  updateInput(id: string, patch: Partial<InputRecord>): Promise<void>;

  // ── Workflow events ────────────────────────────────────────────────────────

  /** Append a workflow event (human message, command, system note, etc.). */
  appendWorkflowEvent(input: CreateWorkflowEventInput): Promise<void>;

  /**
   * F11: List unconsumed workflow events of kind IN ('human','command','child-result').
   * Used by runner.ts to build the prompt for a resumed run.
   * Returns ascending by id.
   */
  listUnconsumedWorkflowEvents(workflowId: string): Promise<WorkflowEventRecord[]>;

  /**
   * Mark workflow events as consumed up to and including maxId.
   * Only affects events with kind IN ('human','command','child-result').
   * Used by runner.ts after loading the prompt.
   */
  markWorkflowEventsConsumedUpTo(workflowId: string, maxId: number): Promise<void>;

  /**
   * Mark ALL unconsumed human/command events as consumed.
   * Used by the /clear command handler.
   */
  markAllWorkflowEventsConsumed(workflowId: string): Promise<void>;

  /**
   * List human-kind workflow events for recap.ts.
   * Filtered to events after afterDate (if given).
   * Filtered to events with id < maxExcludeId (exclusive, if given).
   * Filtered to events with created_at <= beforeOrAtDate (inclusive, if given).
   */
  listHumanWorkflowEvents(
    workflowId: string,
    afterDate?: string | null,
    maxExcludeId?: number | null,
    beforeOrAtDate?: string | null,
  ): Promise<Array<{ id: number; body: string; created_at: string }>>;

  /**
   * Get the MAX(created_at) of workflow events with a given kind and body.
   * Used by recap.ts to find the last /clear time.
   * Returns null when no matching event exists.
   */
  getLastWorkflowEventTime(workflowId: string, kind: string, body: string): Promise<string | null>;

  // ── Transcript ─────────────────────────────────────────────────────────────

  /**
   * Merged transcript of p6_events (run events) and p6_workflow_events for a
   * workflow, newest-first with cursor-based pagination.
   *
   * Sort order within a page: created_at DESC, src ASC ('r' before 'w'), id DESC.
   *
   * Cursor format is opaque to callers; pass nextCursor from the previous response
   * as cursor in the next request.  Cursor positions are based on the raw row
   * before coalescing, so pagination is unaffected by coalesceStreamedRows.
   *
   * Implementations must guarantee no gaps and no overlaps across pages.
   */
  listTranscript(
    workflowId: string,
    cursor: TranscriptCursor | null,
    limit: number,
  ): Promise<{ rows: TranscriptRow[]; nextCursor: TranscriptCursor | null }>;

  // ── Delegation ──────────────────────────────────────────────────────────────

  /**
   * Count running child workflows of a parent (status in running/pending).
   * Used by delegation limit checks.
   * SQLite: COUNT query.
   * DynamoDB: reads a counter item maintained by createChildWorkflowChecked /
   *           releaseChildDelegationSlot.
   */
  countRunningChildWorkflows(parentId: string): Promise<number>;

  /**
   * Count all running delegated sessions (children) created by a user.
   * Used by delegation per-user limit checks.
   * SQLite: COUNT query.
   * DynamoDB: reads a per-user counter item.
   */
  countRunningChildrenByUser(userId: string): Promise<number>;

  /**
   * Atomically check delegation limits and create a child workflow.
   * Throws HttpError 429 if maxRunningPerParent or maxRunningPerUser is exceeded.
   *
   * SQLite: uses tx() to check counts + insert atomically.
   * DynamoDB: uses TransactWriteItems — Put new workflow + conditional ADD on
   *           two counter items (PK=DLGPARENT#<parentId>/SK=#RUNNING and
   *           PK=DLGUSER#<userId>/SK=#RUNNING in the portal-runs table).
   *
   * A limit of 0 means unlimited (no condition check on that counter).
   */
  createChildWorkflowChecked(
    input: CreateWorkflowInput,
    opts: {
      parentId: string;
      userId: string;
      maxRunningPerParent: number;
      maxRunningPerUser: number;
    },
  ): Promise<WorkflowRecord>;

  /**
   * Decrement the delegation running-child counters when a child transitions
   * to a terminal state (done / failed / paused).
   *
   * The child item records whether it currently holds a slot (dlgSlotHeld=1).
   * Release is a single transaction that clears the flag on the child AND
   * decrements both counters — so each child releases at most once and the
   * operation is idempotent (second call is a no-op).
   *
   * SQLite: no-op — counts are computed live from the DB.
   * DynamoDB: TransactWriteItems — condition dlgSlotHeld=1 on child → set 0;
   *           ADD -1 to DLGPARENT#<parentId>/SK=#RUNNING and
   *           DLGUSER#<userId>/SK=#RUNNING.
   */
  releaseChildDelegationSlot(childId: string, parentId: string, userId: string): Promise<void>;

  /**
   * Increment the delegation running-child counters when a child is re-started
   * (resumed from terminal back to pending/running), subject to cap check.
   *
   * Acquire is a single transaction: condition dlgSlotHeld=0 on child → set 1;
   * ADD +1 to both counters (with conditional cap check when max > 0).
   * If the child already holds a slot (dlgSlotHeld=1) the call is idempotent.
   * Throws HttpError 429 if a cap would be exceeded.
   *
   * SQLite: no-op — counts are computed live, cap is re-checked by SQLite's
   *         createChildWorkflowChecked before each run starts.
   * DynamoDB: TransactWriteItems as described above.
   */
  acquireChildDelegationSlot(
    childId: string,
    parentId: string,
    userId: string,
    maxRunningPerParent: number,
    maxRunningPerUser: number,
  ): Promise<void>;

  /**
   * List terminal child workflows (status in done/failed/paused) whose
   * updated_at is older than the given cutoff AND whose stop_reason is NOT
   * 'child-idle' (i.e., they have not yet been idle-stopped by delegation).
   * Used by the delegation idle-stop checker.
   *
   * SQLite: direct query.
   * DynamoDB: queries GSI-ChildIdle (sparse index — PK=childIdleCandidate='CHILD_IDLE',
   *   SK=updated_at_child_idle < cutoff). Only child workflows that are terminal
   *   with stop_reason='' are in the index. Removing the item from the index
   *   (clearing childIdleCandidate) once child-idle-stopped prevents re-selection.
   */
  listTerminalChildWorkflows(cutoff: string): Promise<WorkflowRecord[]>;

  /**
   * List all workflows with status='pending'.
   * Used by the dashboard queued-session count (G3).
   * DynamoDB: queries GSI-StatusGlobal with gStatus='pending'.
   */
  listPendingWorkflows(): Promise<WorkflowRecord[]>;

  /**
   * Terminal run finalization: atomically transitions run status AND writes
   * per-project and per-agent stats rollup counters (RUNSTATS#*, AGENTSTATS#*).
   *
   * The statsHint supplies the project/agent context for rollup keys.  The
   * DynamoDB implementation derives cost/duration from the run item it already
   * fetches (to get workflow_id), so no extra GetItem is needed.
   *
   * DynamoDB: single TransactWriteItems — run UpdateItem (conditional) +
   *           RUNSTATS UpdateItem (ADD counters) +
   *           AGENTSTATS UpdateItem (ADD counters).
   * SQLite:   equivalent to updateRunConditional (stats computed from live SQL).
   *
   * Returns true when the transition applied (status matched), false on lost race.
   * Only call with a terminal patch.status ('done' | 'failed' | 'cancelled').
   */
  finalizeRun(
    id: string,
    expectedStatus: string,
    patch: Partial<RunRecord>,
    statsHint: RunFinalizeStats,
  ): Promise<boolean>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: SessionsRepository | null = null;

/** Initialise the singleton. Call once at server startup. Idempotent. */
export async function initSessionsRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbSessionsRepository } = await import('./sessions-dynamodb.ts');
    _instance = new DynamoDbSessionsRepository();
  } else {
    _instance = new SqliteSessionsRepository();
  }
}

/**
 * Return the singleton.
 * Falls back to SQLite init if not yet initialised (safe for tests and callers
 * that run before startServer).
 */
export function getSessionsRepository(): SessionsRepository {
  if (_instance) return _instance;
  if (usesDynamoDb()) {
    throw new Error(
      'DynamoDB sessions repository was not initialised. ' +
        'Call await initSessionsRepository() at server startup.',
    );
  }
  _instance = new SqliteSessionsRepository();
  return _instance;
}

export function setSessionsRepository(repo: SessionsRepository): void { _instance = repo; }
export function clearSessionsRepository(): void { _instance = null; }
