/**
 * SQLite implementation of SessionsRepository.
 *
 * Wraps the synchronous node:sqlite helpers in Promise.resolve() so the
 * interface contract is identical to the DynamoDB implementation.
 * All SQL for p6_workflows, p6_runs, p6_events, p6_inputs, p6_workflow_events
 * lives here.  The existing SQL is preserved exactly so behaviour is unchanged.
 */

import { one, all, run as dbRun, insert, getDb, tx } from '../db.ts';
import type { DbParam } from '../db.ts';
import type { Row } from '../db.ts';
import { HttpError } from '../util.ts';
import type {
  SessionsRepository,
  WorkflowRecord,
  RunRecord,
  EventRecord,
  AppendedEvent,
  InputRecord,
  WorkflowEventRecord,
  CreateWorkflowInput,
  CreateRunInput,
  CreateInputInput,
  CreateWorkflowEventInput,
  ListWorkflowsOpts,
  RunTotals,
  TranscriptRow,
  TranscriptCursor,
} from './sessions.ts';
// Suppress unused import warning — TranscriptRow and TranscriptCursor are used
// as return types in listTranscript.
void (0 as unknown as TranscriptRow);
void (0 as unknown as TranscriptCursor);

// ── Row converters ─────────────────────────────────────────────────────────────

function toWorkflow(row: Row): WorkflowRecord {
  return {
    id: String(row.id),
    project_id: row.project_id != null ? String(row.project_id) : null,
    title: String(row.title ?? ''),
    goal: String(row.goal ?? ''),
    status: String(row.status ?? ''),
    stop_reason: String(row.stop_reason ?? ''),
    engine: String(row.engine ?? ''),
    trust_tools: Number(row.trust_tools ?? 0),
    lead_agent: row.lead_agent != null ? String(row.lead_agent) : null,
    workspace_id: row.workspace_id != null ? String(row.workspace_id) : null,
    output_files_enabled: Number(row.output_files_enabled ?? 0),
    repo_ids: String(row.repo_ids ?? '[]'),
    integrations: String(row.integrations ?? '[]'),
    iteration_count: Number(row.iteration_count ?? 0),
    max_iterations: Number(row.max_iterations ?? 10),
    last_turn_at: row.last_turn_at != null ? String(row.last_turn_at) : null,
    credential_id: row.credential_id != null ? String(row.credential_id) : null,
    model: String(row.model ?? ''),
    engine_session_id: row.engine_session_id != null ? String(row.engine_session_id) : null,
    engine_session_engine: row.engine_session_engine != null ? String(row.engine_session_engine) : null,
    created_by: row.created_by != null ? String(row.created_by) : null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
    parent_id: row.parent_id != null ? String(row.parent_id) : null,
    work_dir: row.work_dir != null ? String(row.work_dir) : null,
    jira_key: String(row.jira_key ?? ''),
    jira_summary: String(row.jira_summary ?? ''),
    jira_url: String(row.jira_url ?? ''),
    kind: row.kind != null ? String(row.kind) : null,
    run_timeout_minutes: row.run_timeout_minutes != null ? Number(row.run_timeout_minutes) : null,
    loop_state: String(row.loop_state ?? ''),
    budget_usd: row.budget_usd != null ? Number(row.budget_usd) : null,
    // enrichment
    parent_title: row.parent_title !== undefined ? (row.parent_title != null ? String(row.parent_title) : null) : undefined,
    child_count: row.child_count !== undefined ? Number(row.child_count) : undefined,
    resumable: row.resumable !== undefined ? Boolean(row.resumable) : undefined,
    lastRunStatus: row.lastRunStatus !== undefined ? (row.lastRunStatus != null ? String(row.lastRunStatus) : null) : undefined,
  };
}

function toRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    workflow_id: String(row.workflow_id),
    status: String(row.status ?? ''),
    started_at: row.started_at != null ? String(row.started_at) : null,
    finished_at: row.finished_at != null ? String(row.finished_at) : null,
    cost_usd: Number(row.cost_usd ?? 0),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cache_write_tokens: Number(row.cache_write_tokens ?? 0),
    cache_read_tokens: Number(row.cache_read_tokens ?? 0),
    created_at: String(row.created_at ?? ''),
    stop_reason: row.stop_reason != null ? String(row.stop_reason) : null,
    time_limit_at: row.time_limit_at != null ? String(row.time_limit_at) : null,
    model: row.model != null ? String(row.model) : null,
    error: row.error != null ? String(row.error) : null,
  };
}

function toEvent(row: Row): EventRecord {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    type: String(row.type ?? ''),
    payload: String(row.payload ?? ''),
    created_at: String(row.created_at ?? ''),
  };
}

function toInput(row: Row): InputRecord {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    project_id: row.project_id != null ? String(row.project_id) : null,
    tool_name: row.tool_name != null ? String(row.tool_name) : null,
    tool_input: row.tool_input != null ? String(row.tool_input) : null,
    payload: String(row.payload ?? ''),
    input_hash: row.input_hash != null ? String(row.input_hash) : null,
    type: String(row.type ?? 'approval'),
    status: String(row.status ?? 'pending'),
    allow_all: Number(row.allow_all ?? 0),
    response: row.response != null ? String(row.response) : null,
    answered_by: row.answered_by != null ? String(row.answered_by) : null,
    answered_at: row.answered_at != null ? String(row.answered_at) : null,
    expires_at: row.expires_at != null ? String(row.expires_at) : null,
    created_at: String(row.created_at ?? ''),
  };
}

function toWorkflowEvent(row: Row): WorkflowEventRecord {
  return {
    id: Number(row.id),
    workflow_id: String(row.workflow_id),
    kind: String(row.kind ?? ''),
    body: String(row.body ?? ''),
    data: row.data != null ? String(row.data) : null,
    created_at: String(row.created_at ?? ''),
    consumed: Number(row.consumed ?? 0),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildPatchSet(patch: Record<string, unknown>): {
  setSql: string;
  values: DbParam[];
} {
  const parts: string[] = [];
  const values: DbParam[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      parts.push(`${k} = ?`);
      values.push(v as DbParam);
    }
  }
  return { setSql: parts.join(', '), values };
}

// ── Implementation ─────────────────────────────────────────────────────────────

export class SqliteSessionsRepository implements SessionsRepository {
  // ── Workflows ───────────────────────────────────────────────────────────────

  async getWorkflowById(id: string): Promise<WorkflowRecord | null> {
    const row = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', id);
    return row ? toWorkflow(row) : null;
  }

  async getWorkflowByProjectId(projectId: string, workflowId: string): Promise<WorkflowRecord | null> {
    const row = one<Row>(
      'SELECT * FROM p6_workflows WHERE id = ? AND project_id = ?',
      workflowId,
      projectId,
    );
    return row ? toWorkflow(row) : null;
  }

  async listWorkflowsByProject(
    projectId: string,
    opts: ListWorkflowsOpts = {},
  ): Promise<{ workflows: WorkflowRecord[]; total: number; cursor?: string }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const conditions: string[] = ['w.project_id = ?'];
    const params: (string | number)[] = [projectId];

    if (opts.status) { conditions.push('w.status = ?'); params.push(opts.status); }
    if (opts.engine) { conditions.push('w.engine = ?'); params.push(opts.engine); }
    if (opts.search) { conditions.push('w.goal LIKE ?'); params.push(`%${opts.search}%`); }

    const where = conditions.join(' AND ');

    const total =
      (one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM p6_workflows w WHERE ${where}`,
        ...params,
      )?.n) ?? 0;

    const rows = all<Row>(
      `SELECT w.*,
          CASE WHEN w.parent_id IS NOT NULL THEN
            SUBSTR(COALESCE(NULLIF(p.title, ''), p.goal), 1, 60)
          ELSE NULL END AS parent_title,
          (SELECT COUNT(*) FROM p6_workflows c WHERE c.parent_id = w.id) AS child_count
        FROM p6_workflows w
        LEFT JOIN p6_workflows p ON p.id = w.parent_id
        WHERE ${where}
        ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    return { workflows: rows.map(toWorkflow), total };
  }

  async listRunningWorkflows(): Promise<WorkflowRecord[]> {
    const rows = all<Row>("SELECT * FROM p6_workflows WHERE status = 'running'");
    return rows.map(toWorkflow);
  }

  async listIdleWorkflows(cutoff: string): Promise<WorkflowRecord[]> {
    const rows = all<Row>(
      `SELECT * FROM p6_workflows
        WHERE status IN ('done', 'pending')
          AND last_turn_at IS NOT NULL
          AND last_turn_at < ?
          AND stop_reason = ''`,
      cutoff,
    );
    return rows.map(toWorkflow);
  }

  async listChildWorkflows(parentId: string): Promise<WorkflowRecord[]> {
    const rows = all<Row>(
      'SELECT id, title, goal, status, created_at, updated_at FROM p6_workflows WHERE parent_id = ? ORDER BY created_at ASC',
      parentId,
    );
    return rows.map(toWorkflow);
  }

  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    insert('p6_workflows', {
      id: input.id,
      project_id: input.project_id,
      title: input.title ?? '',
      goal: input.goal,
      status: input.status,
      stop_reason: input.stop_reason ?? '',
      engine: input.engine,
      trust_tools: input.trust_tools,
      lead_agent: input.lead_agent,
      workspace_id: input.workspace_id,
      output_files_enabled: input.output_files_enabled,
      repo_ids: input.repo_ids,
      iteration_count: input.iteration_count,
      max_iterations: input.max_iterations,
      credential_id: input.credential_id,
      model: input.model,
      jira_key: input.jira_key ?? '',
      jira_summary: input.jira_summary ?? '',
      jira_url: input.jira_url ?? '',
      created_by: input.created_by,
      created_at: input.created_at,
      updated_at: input.updated_at,
      parent_id: input.parent_id ?? null,
      kind: input.kind ?? null,
    });
    // If this is a child workflow, notify the repository of the child-count change.
    // In SQLite mode this is a no-op (child_count is computed via COUNT(*) subquery),
    // but it mirrors the DynamoDB implementation so the repository owns the bookkeeping
    // on both backends — no separate call is needed at the route layer.
    if (input.parent_id) {
      await this.incrementWorkflowChildCount(input.parent_id, 1);
    }
    const row = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', input.id)!;
    return toWorkflow(row);
  }

  async updateWorkflowConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<WorkflowRecord>,
    _opts?: { hintParentId?: string | null },
  ): Promise<boolean> {
    const allowed: (keyof WorkflowRecord)[] = [
      'title', 'goal', 'status', 'stop_reason', 'engine', 'trust_tools',
      'lead_agent', 'workspace_id', 'output_files_enabled', 'repo_ids', 'integrations',
      'iteration_count', 'max_iterations', 'last_turn_at', 'credential_id',
      'model', 'engine_session_id', 'engine_session_engine', 'updated_at',
      'parent_id', 'work_dir', 'jira_key', 'jira_summary', 'jira_url',
      'kind', 'run_timeout_minutes', 'loop_state', 'budget_usd',
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return false;
    const { setSql, values } = buildPatchSet(clean);
    const result = dbRun(
      `UPDATE p6_workflows SET ${setSql} WHERE id = ? AND status = ?`,
      ...values,
      id,
      expectedStatus,
    );
    return (result as { changes: number }).changes > 0;
  }

  async updateWorkflow(id: string, patch: Partial<WorkflowRecord>): Promise<void> {
    const allowed: (keyof WorkflowRecord)[] = [
      'title', 'goal', 'status', 'stop_reason', 'engine', 'trust_tools',
      'lead_agent', 'workspace_id', 'output_files_enabled', 'repo_ids', 'integrations',
      'iteration_count', 'max_iterations', 'last_turn_at', 'credential_id',
      'model', 'engine_session_id', 'engine_session_engine', 'updated_at',
      'parent_id', 'work_dir', 'jira_key', 'jira_summary', 'jira_url',
      'kind', 'run_timeout_minutes', 'loop_state', 'budget_usd',
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return;
    const { setSql, values } = buildPatchSet(clean);
    dbRun(`UPDATE p6_workflows SET ${setSql} WHERE id = ?`, ...values, id);
  }

  async deleteWorkflow(id: string): Promise<void> {
    // Load parent_id before deleting so the repository can own the child-count
    // bookkeeping symmetrically with the DynamoDB implementation.
    const wf = one<Row>('SELECT parent_id FROM p6_workflows WHERE id = ?', id);
    const parentId = wf?.parent_id != null ? String(wf.parent_id) : null;
    dbRun('DELETE FROM p6_workflows WHERE id = ?', id);
    // In SQLite mode child_count is computed via a COUNT(*) subquery and this is
    // a no-op. Kept here so the bookkeeping contract is symmetric across backends.
    if (parentId) {
      await this.incrementWorkflowChildCount(parentId, -1);
    }
  }

  async incrementWorkflowIteration(id: string): Promise<void> {
    dbRun(
      'UPDATE p6_workflows SET iteration_count = iteration_count + 1 WHERE id = ?',
      id,
    );
  }

  async incrementWorkflowChildCount(parentId: string, delta: 1 | -1): Promise<void> {
    dbRun(
      'UPDATE p6_workflows SET iteration_count = iteration_count + ? WHERE id = ?',
      // Note: p6_workflows doesn't have a child_count column in SQLite — child_count
      // is computed via COUNT(*) subquery. This method is a no-op in SQLite mode
      // because listWorkflowsByProject already computes the count from the DB.
      // The DynamoDB implementation maintains it as an atomic counter attribute.
      0,
      parentId,
    );
  }

  // ── Runs ────────────────────────────────────────────────────────────────────

  async getRunById(id: string): Promise<RunRecord | null> {
    const row = one<Row>('SELECT * FROM p6_runs WHERE id = ?', id);
    return row ? toRun(row) : null;
  }

  async getRunByWorkflowAndId(workflowId: string, runId: string): Promise<RunRecord | null> {
    const row = one<Row>('SELECT * FROM p6_runs WHERE id = ? AND workflow_id = ?', runId, workflowId);
    return row ? toRun(row) : null;
  }

  async getLatestRun(workflowId: string): Promise<RunRecord | null> {
    const row = one<Row>(
      'SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1',
      workflowId,
    );
    return row ? toRun(row) : null;
  }

  async getActiveRun(workflowId: string): Promise<RunRecord | null> {
    const row = one<Row>(
      "SELECT * FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1",
      workflowId,
    );
    return row ? toRun(row) : null;
  }

  async listRunsByWorkflow(workflowId: string, limit = 100): Promise<RunRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM p6_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?',
      workflowId,
      limit,
    );
    return rows.map(toRun);
  }

  async getRunTotals(workflowId: string): Promise<RunTotals> {
    const row = one<{ total_cost: number; total_input: number; total_output: number }>(
      `SELECT
         COALESCE(SUM(cost_usd), 0)     AS total_cost,
         COALESCE(SUM(input_tokens), 0) AS total_input,
         COALESCE(SUM(output_tokens), 0) AS total_output
       FROM p6_runs WHERE workflow_id = ?`,
      workflowId,
    );
    return {
      total_cost: Number(row?.total_cost ?? 0),
      total_input: Number(row?.total_input ?? 0),
      total_output: Number(row?.total_output ?? 0),
    };
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    insert('p6_runs', {
      id: input.id,
      workflow_id: input.workflow_id,
      status: input.status,
      started_at: input.started_at,
      finished_at: input.finished_at,
      cost_usd: input.cost_usd,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM p6_runs WHERE id = ?', input.id)!;
    return toRun(row);
  }

  async updateRun(id: string, patch: Partial<RunRecord>): Promise<void> {
    const allowed: (keyof RunRecord)[] = [
      'status', 'started_at', 'finished_at', 'cost_usd', 'input_tokens',
      'output_tokens', 'cache_write_tokens', 'cache_read_tokens',
      'stop_reason', 'time_limit_at', 'model', 'error',
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return;
    const { setSql, values } = buildPatchSet(clean);
    dbRun(`UPDATE p6_runs SET ${setSql} WHERE id = ?`, ...values, id);
  }

  async updateRunConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<RunRecord>,
  ): Promise<boolean> {
    const allowed: (keyof RunRecord)[] = [
      'status', 'started_at', 'finished_at', 'cost_usd', 'input_tokens',
      'output_tokens', 'cache_write_tokens', 'cache_read_tokens',
      'stop_reason', 'time_limit_at', 'model', 'error',
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return false;
    const { setSql, values } = buildPatchSet(clean);
    const result = dbRun(
      `UPDATE p6_runs SET ${setSql} WHERE id = ? AND status = ?`,
      ...values,
      id,
      expectedStatus,
    );
    return (result as { changes: number }).changes > 0;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  async appendRunEvent(runId: string, type: string, payload: string, createdAt: string): Promise<AppendedEvent> {
    insert('p6_events', { run_id: runId, type, payload, created_at: createdAt });
    const idRow = one<{ id: number }>('SELECT last_insert_rowid() AS id');
    return { id: Number(idRow?.id ?? 0), created_at: createdAt };
  }

  async listRunEventsFrom(runId: string, fromId: number, limit = 100): Promise<EventRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM p6_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      runId,
      fromId,
      limit,
    );
    return rows.map(toEvent);
  }

  async listRunEvents(runId: string, limit = 5000): Promise<EventRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM p6_events WHERE run_id = ? ORDER BY id ASC LIMIT ?',
      runId,
      limit,
    );
    return rows.map(toEvent);
  }

  async listRunEventsBefore(runId: string, beforeId: number, limit = 100): Promise<EventRecord[]> {
    const rows = all<Row>(
      'SELECT * FROM p6_events WHERE run_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
      runId,
      beforeId,
      limit,
    );
    return rows.map(toEvent);
  }

  async listWorkflowRunEventsByType(
    workflowId: string,
    types: string[],
    limit = 200,
  ): Promise<EventRecord[]> {
    if (types.length === 0) return [];
    const placeholders = types.map(() => '?').join(', ');
    const rows = all<Row>(
      `SELECT e.id, e.run_id, e.type, e.payload, e.created_at
         FROM p6_events e
         JOIN p6_runs r ON r.id = e.run_id
        WHERE r.workflow_id = ?
          AND e.type IN (${placeholders})
        ORDER BY e.id DESC
        LIMIT ?`,
      workflowId,
      ...types,
      limit,
    );
    return rows.map(toEvent);
  }

  async listRunCompletionEvents(
    workflowId: string,
    excludeRunId: string,
    afterDate?: string | null,
  ): Promise<Array<{ payload: string; created_at: string }>> {
    const args: (string | number)[] = [workflowId, excludeRunId];
    if (afterDate) args.push(afterDate);
    return all<{ payload: string; created_at: string }>(
      `SELECT e.payload, e.created_at
         FROM p6_events e
         JOIN p6_runs r ON e.run_id = r.id
        WHERE r.workflow_id = ? AND r.id != ? AND e.type = 'run-complete'
          ${afterDate ? 'AND e.created_at > ?' : ''}
        ORDER BY e.created_at ASC`,
      ...args,
    );
  }

  // ── Inputs ──────────────────────────────────────────────────────────────────

  async createInput(input: CreateInputInput): Promise<InputRecord> {
    insert('p6_inputs', {
      id: input.id,
      run_id: input.run_id,
      project_id: input.project_id,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      payload: input.payload,
      input_hash: input.input_hash,
      type: input.type,
      status: input.status,
      allow_all: input.allow_all,
      expires_at: input.expires_at,
      created_at: input.created_at,
    });
    const row = one<Row>('SELECT * FROM p6_inputs WHERE id = ?', input.id)!;
    return toInput(row);
  }

  async getInputById(id: string): Promise<InputRecord | null> {
    const row = one<Row>('SELECT * FROM p6_inputs WHERE id = ?', id);
    return row ? toInput(row) : null;
  }

  async getInputByRunAndId(runId: string, inputId: string): Promise<InputRecord | null> {
    const row = one<Row>('SELECT * FROM p6_inputs WHERE id = ? AND run_id = ?', inputId, runId);
    return row ? toInput(row) : null;
  }

  async getInputByHash(inputHash: string, runId: string): Promise<InputRecord | null> {
    const row = one<Row>(
      'SELECT * FROM p6_inputs WHERE input_hash = ? AND run_id = ?',
      inputHash,
      runId,
    );
    return row ? toInput(row) : null;
  }

  async getPendingInput(runId: string): Promise<InputRecord | null> {
    const row = one<Row>(
      "SELECT * FROM p6_inputs WHERE run_id = ? AND status = 'pending'",
      runId,
    );
    return row ? toInput(row) : null;
  }

  async listInputsByRun(runId: string): Promise<InputRecord[]> {
    const rows = all<Row>('SELECT * FROM p6_inputs WHERE run_id = ?', runId);
    return rows.map(toInput);
  }

  async updateInputConditional(
    id: string,
    expectedStatus: string,
    patch: Partial<InputRecord>,
  ): Promise<boolean> {
    const allowed: (keyof InputRecord)[] = [
      'status', 'response', 'allow_all', 'answered_by', 'answered_at',
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return false;
    const { setSql, values } = buildPatchSet(clean);
    const result = dbRun(
      `UPDATE p6_inputs SET ${setSql} WHERE id = ? AND status = ?`,
      ...values,
      id,
      expectedStatus,
    );
    return (result as { changes: number }).changes > 0;
  }

  async updateInput(id: string, patch: Partial<InputRecord>): Promise<void> {
    const allowed: (keyof InputRecord)[] = [
      'status', 'response', 'allow_all', 'answered_by', 'answered_at',
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) clean[k] = patch[k];
    }
    if (Object.keys(clean).length === 0) return;
    const { setSql, values } = buildPatchSet(clean);
    dbRun(`UPDATE p6_inputs SET ${setSql} WHERE id = ?`, ...values, id);
  }

  // ── Workflow events ──────────────────────────────────────────────────────────

  async appendWorkflowEvent(input: CreateWorkflowEventInput): Promise<void> {
    insert('p6_workflow_events', {
      workflow_id: input.workflow_id,
      kind: input.kind,
      body: input.body,
      data: input.data ?? '{}',
      created_at: input.created_at,
    });
  }

  async listUnconsumedWorkflowEvents(workflowId: string): Promise<WorkflowEventRecord[]> {
    const rows = all<Row>(
      `SELECT id, kind, body, workflow_id, data, created_at, consumed
         FROM p6_workflow_events
        WHERE workflow_id = ? AND consumed = 0 AND kind IN ('human', 'command', 'child-result')
        ORDER BY id ASC`,
      workflowId,
    );
    return rows.map(toWorkflowEvent);
  }

  async markWorkflowEventsConsumedUpTo(workflowId: string, maxId: number): Promise<void> {
    dbRun(
      `UPDATE p6_workflow_events SET consumed = 1
        WHERE workflow_id = ? AND id <= ? AND kind IN ('human', 'command', 'child-result') AND consumed = 0`,
      workflowId,
      maxId,
    );
  }

  async markAllWorkflowEventsConsumed(workflowId: string): Promise<void> {
    dbRun(
      `UPDATE p6_workflow_events SET consumed = 1
        WHERE workflow_id = ? AND consumed = 0 AND kind IN ('human', 'command')`,
      workflowId,
    );
  }

  async listHumanWorkflowEvents(
    workflowId: string,
    afterDate?: string | null,
    maxExcludeId?: number | null,
    beforeOrAtDate?: string | null,
  ): Promise<Array<{ id: number; body: string; created_at: string }>> {
    const args: (string | number)[] = [workflowId];
    const clauses: string[] = ["workflow_id = ? AND kind = 'human'"];
    if (afterDate) { clauses.push('created_at > ?'); args.push(afterDate); }
    if (maxExcludeId != null) { clauses.push('id < ?'); args.push(maxExcludeId); }
    if (beforeOrAtDate != null) { clauses.push('created_at <= ?'); args.push(beforeOrAtDate); }
    return all<{ id: number; body: string; created_at: string }>(
      `SELECT id, body, created_at FROM p6_workflow_events WHERE ${clauses.join(' AND ')} ORDER BY id ASC`,
      ...args,
    );
  }

  async getLastWorkflowEventTime(workflowId: string, kind: string, body: string): Promise<string | null> {
    const row = one<{ ts: string | null }>(
      `SELECT MAX(created_at) AS ts FROM p6_workflow_events
         WHERE workflow_id = ? AND kind = ? AND body = ?`,
      workflowId,
      kind,
      body,
    );
    return row?.ts ?? null;
  }

  // ── Transcript ──────────────────────────────────────────────────────────────

  async listTranscript(
    workflowId: string,
    cursor: TranscriptCursor | null,
    limit: number,
  ): Promise<{ rows: TranscriptRow[]; nextCursor: TranscriptCursor | null }> {
    type R = { src: string; id: number; created_at: string; kind: string; body: string; run_id: string | null };
    let rows: R[];
    if (cursor) {
      rows = getDb().prepare(`
        WITH merged AS (
          SELECT 'r' AS src, e.id, e.created_at, e.type AS kind, e.payload AS body, e.run_id
          FROM p6_events e
          JOIN p6_runs r ON r.id = e.run_id
          WHERE r.workflow_id = ?
          UNION ALL
          SELECT 'w' AS src, we.id, we.created_at, we.kind, we.body, NULL AS run_id
          FROM p6_workflow_events we
          WHERE we.workflow_id = ?
        )
        SELECT * FROM merged
        WHERE (
          created_at < ?
          OR (created_at = ? AND src > ?)
          OR (created_at = ? AND src = ? AND id < ?)
        )
        ORDER BY created_at DESC, src ASC, id DESC
        LIMIT ?
      `).all(workflowId, workflowId, cursor.ts, cursor.ts, cursor.src, cursor.ts, cursor.src, cursor.id, limit) as R[];
    } else {
      rows = getDb().prepare(`
        WITH merged AS (
          SELECT 'r' AS src, e.id, e.created_at, e.type AS kind, e.payload AS body, e.run_id
          FROM p6_events e
          JOIN p6_runs r ON r.id = e.run_id
          WHERE r.workflow_id = ?
          UNION ALL
          SELECT 'w' AS src, we.id, we.created_at, we.kind, we.body, NULL AS run_id
          FROM p6_workflow_events we
          WHERE we.workflow_id = ?
        )
        SELECT * FROM merged
        ORDER BY created_at DESC, src ASC, id DESC
        LIMIT ?
      `).all(workflowId, workflowId, limit) as R[];
    }

    const nextCursor: TranscriptCursor | null =
      rows.length === limit
        ? { ts: rows[rows.length - 1].created_at, src: rows[rows.length - 1].src as 'r' | 'w', id: Number(rows[rows.length - 1].id) }
        : null;

    return {
      rows: rows.map((r) => ({
        src: r.src as 'r' | 'w',
        id: Number(r.id),
        created_at: r.created_at,
        kind: r.kind,
        body: r.body,
        run_id: r.run_id ?? null,
      })),
      nextCursor,
    };
  }

  // ── Delegation ──────────────────────────────────────────────────────────────

  async countRunningChildWorkflows(parentId: string): Promise<number> {
    const r = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM p6_workflows WHERE parent_id = ? AND status IN ('running','pending')",
      parentId,
    );
    return Number(r?.n ?? 0);
  }

  async countRunningChildrenByUser(userId: string): Promise<number> {
    const r = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM p6_workflows WHERE parent_id IS NOT NULL AND created_by = ? AND status IN ('running','pending')",
      userId,
    );
    return Number(r?.n ?? 0);
  }

  async createChildWorkflowChecked(
    input: CreateWorkflowInput,
    opts: { parentId: string; userId: string; maxRunningPerParent: number; maxRunningPerUser: number },
  ): Promise<WorkflowRecord> {
    const { parentId, userId, maxRunningPerParent, maxRunningPerUser } = opts;
    tx(() => {
      if (maxRunningPerParent > 0) {
        const pc = one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM p6_workflows WHERE parent_id = ? AND status IN ('running','pending')",
          parentId,
        );
        if (Number(pc?.n ?? 0) >= maxRunningPerParent) {
          throw new HttpError(
            429,
            `This session already has ${pc?.n ?? 0} running child session(s). ` +
              `The maximum per parent is ${maxRunningPerParent}. Wait for a child to finish.`,
          );
        }
      }
      if (maxRunningPerUser > 0) {
        const uc = one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM p6_workflows WHERE parent_id IS NOT NULL AND created_by = ? AND status IN ('running','pending')",
          userId,
        );
        if (Number(uc?.n ?? 0) >= maxRunningPerUser) {
          throw new HttpError(
            429,
            `You already have ${uc?.n ?? 0} running delegated sessions. ` +
              `The maximum per user is ${maxRunningPerUser}. Wait for a child to finish.`,
          );
        }
      }
      insert('p6_workflows', {
        id: input.id,
        project_id: input.project_id,
        title: input.title ?? '',
        goal: input.goal,
        status: input.status,
        stop_reason: input.stop_reason ?? '',
        engine: input.engine,
        trust_tools: input.trust_tools,
        lead_agent: input.lead_agent,
        workspace_id: input.workspace_id,
        output_files_enabled: input.output_files_enabled,
        repo_ids: input.repo_ids,
        iteration_count: input.iteration_count,
        max_iterations: input.max_iterations,
        credential_id: input.credential_id,
        model: input.model,
        jira_key: input.jira_key ?? '',
        jira_summary: input.jira_summary ?? '',
        jira_url: input.jira_url ?? '',
        created_by: input.created_by,
        created_at: input.created_at,
        updated_at: input.updated_at,
        parent_id: parentId,
      });
    });
    const row = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', input.id)!;
    return toWorkflow(row);
  }

  async releaseChildDelegationSlot(_childId: string, _parentId: string, _userId: string): Promise<void> {
    // SQLite: counts are computed live from the DB — no counters to maintain
  }

  async acquireChildDelegationSlot(
    _childId: string,
    _parentId: string,
    _userId: string,
    _maxRunningPerParent: number,
    _maxRunningPerUser: number,
  ): Promise<void> {
    // SQLite: counts are computed live from the DB — cap re-checked by createChildWorkflowChecked
  }

  async listTerminalChildWorkflows(cutoff: string): Promise<WorkflowRecord[]> {
    const rows = all<Row>(
      `SELECT id, project_id, created_by, status, updated_at, stop_reason FROM p6_workflows
        WHERE parent_id IS NOT NULL
          AND status IN ('done','failed','paused')
          AND stop_reason != 'child-idle'
          AND updated_at < ?`,
      cutoff,
    );
    return rows.map(toWorkflow);
  }

  async listPendingWorkflows(): Promise<WorkflowRecord[]> {
    const rows = all<Row>("SELECT * FROM p6_workflows WHERE status = 'pending'");
    return rows.map(toWorkflow);
  }

  async finalizeRun(
    id: string,
    expectedStatus: string,
    patch: Partial<RunRecord>,
    _statsHint: import('./sessions.ts').RunFinalizeStats,
  ): Promise<boolean> {
    // SQLite: stats are computed from live queries — just delegate to updateRunConditional.
    return this.updateRunConditional(id, expectedStatus, patch);
  }
}
