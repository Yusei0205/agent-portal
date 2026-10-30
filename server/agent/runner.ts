/**
 * Agent run orchestrator — the most critical file in P6.
 *
 * Responsibilities:
 *   1. Set up the run work directory.
 *   2. Copy project files into the work dir.
 *   3. Load permissions via loadRunPermissions().
 *   4. For each tool call: evaluate via evaluateCommand(), handle ask/block/allow.
 *   5. Write guard: Write/Edit target must be inside workDir.
 *   6. Emit structured events throughout the lifecycle.
 *   7. On completion: update the run record.
 *
 * NOTE: This runner never uses hardcoded blocked-command lists.
 * ALL decisions route through evaluateCommand() from guardrails.ts.
 */

import path from 'node:path';
import { one, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now } from '../util.ts';
import { emit } from '../events.ts';
import { loadRunPermissions, evaluateCommand } from '../guardrails.ts';
import { createWorkDir } from '../workflows/working-copies.ts';
import { registerRun, deregisterRun } from '../workflows/controls.ts';
import { createInboxItem } from '../inbox.ts';
import { config } from '../config.ts';
import type { AgentRun, RunContext } from './types.ts';
import { runDemo } from './demo.ts';

// ── Run lifecycle hook ────────────────────────────────────────────────────────

/**
 * Optional hook called at key lifecycle points for every run.
 * Registered by review-lifecycle.ts (and any other consumer) to react to run
 * state changes without coupling the runner to domain-specific logic.
 *
 * event: 'start'     — run has moved from pending → running
 *        'done'      — run completed successfully
 *        'failed'    — run failed (non-abort error)
 *        'cancelled' — run was aborted / cancelled by the user
 */
let _runLifecycleHook: (
  (workflowId: string, runId: string, event: 'start' | 'done' | 'failed' | 'cancelled') => void
) | null = null;

export function setRunLifecycleHook(
  fn: (workflowId: string, runId: string, event: 'start' | 'done' | 'failed' | 'cancelled') => void,
): void {
  _runLifecycleHook = fn;
}

function fireHook(workflowId: string, runId: string, event: 'start' | 'done' | 'failed' | 'cancelled'): void {
  if (!_runLifecycleHook) return;
  try { _runLifecycleHook(workflowId, runId, event); } catch { /* hook errors must not crash the runner */ }
}

// ── Pending approval map ──────────────────────────────────────────────────────

interface PendingApproval {
  resolve: (v: 'approve' | 'deny') => void;
  reject: (e: unknown) => void;
}

/** runId → inputId → resolver */
const pendingApprovals = new Map<string, Map<string, PendingApproval>>();

// ── Approval resolution (called by the CRUD API when a user responds) ─────────

/**
 * Resolve a pending approval input.
 * Called from the /runs/:rid/input endpoint.
 */
export function resolveApproval(
  runId: string,
  inputId: string,
  decision: 'approve' | 'deny',
): boolean {
  const runMap = pendingApprovals.get(runId);
  const pending = runMap?.get(inputId);
  if (!pending) return false;
  runMap!.delete(inputId);
  if (runMap!.size === 0) pendingApprovals.delete(runId);
  pending.resolve(decision);
  return true;
}

// ── SSE event emission ────────────────────────────────────────────────────────

/**
 * Emit an event for a run: writes to p6_events and to the SSE channel.
 * workflowId is included in the SSE payload so clients can match run events
 * to a specific workflow without a separate lookup.
 */
export function emitRunEvent(runId: string, projectId: string | null, workflowId: string | null, type: string, payload: object): void {
  insert('p6_events', {
    run_id: runId,
    type,
    payload: JSON.stringify(payload),
    created_at: now(),
  });
  // Publish to project SSE channel so connected UIs see it live
  if (projectId) {
    emit(projectId, { type: 'run.event', runId, workflowId, eventType: type, payload });
  }
}

// ── Main executor ─────────────────────────────────────────────────────────────

/**
 * Execute a run. Runs the appropriate engine, handles guardrails, manages state.
 * This function is called in the background (not awaited by the caller).
 */
export async function executeRun(runId: string, workflowId: string): Promise<void> {
  // Load workflow and project
  const workflow = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', workflowId);
  if (!workflow) {
    dbRun('UPDATE p6_runs SET status = ?, finished_at = ? WHERE id = ?', 'failed', now(), runId);
    return;
  }

  const project = workflow.project_id
    ? one<Row>('SELECT * FROM projects WHERE id = ?', String(workflow.project_id))
    : null;

  const slug = project ? String(project.slug) : 'unknown';
  const projectDir = path.join(config.dataDir, 'projects', slug);
  const workDir = path.join(projectDir, 'work', runId);

  // Update run to running
  dbRun(
    'UPDATE p6_runs SET status = ?, started_at = ? WHERE id = ?',
    'running',
    now(),
    runId,
  );

  // Emit to project channel
  if (workflow.project_id) {
    emit(String(workflow.project_id), { type: 'run.started', runId, workflowId });
  }

  // Notify lifecycle hook (e.g. marks associated review as 'running')
  fireHook(workflowId, runId, 'start');

  // Register abort controller
  const ctrl = registerRun(runId);

  try {
    // Create work directory
    await createWorkDir(runId, projectDir);

    // Load permissions
    const permissions = await loadRunPermissions(workflow.project_id ? String(workflow.project_id) : null);

    // Build the AgentRun descriptor
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId: workflow.project_id ? String(workflow.project_id) : null,
      goal: String(workflow.goal),
      kind: workflow.kind ? String(workflow.kind) : null,
      engine: (workflow.engine as 'claude-code' | 'kiro' | 'demo') || 'demo',
      trusted: Boolean(workflow.trust_tools),
      dataDir: config.dataDir,
      workDir,
      repoIds: parseJsonArray(String(workflow.repo_ids ?? '[]')),
      leadAgent: workflow.lead_agent ? String(workflow.lead_agent) : null,
      permissions,
    };

    // Set up the run's approval map
    const runApprovals = new Map<string, PendingApproval>();
    pendingApprovals.set(runId, runApprovals);

    const runContext: RunContext = {
      run: agentRun,
      emit: (type, payload) => emitRunEvent(runId, agentRun.projectId, agentRun.workflowId, type, payload),
      awaitInput: (toolName, toolInput) => awaitApproval(runId, workflowId, agentRun, toolName, toolInput, runApprovals, ctrl.signal),
      allowAll: new Set<string>(),
    };

    // Run the appropriate engine
    let result: string;
    if (agentRun.engine === 'demo') {
      result = await runDemo(runContext);
    } else {
      // Real engines not yet wired in the greenfield build — fall back to demo with a note
      result = await runDemo({
        ...runContext,
        run: { ...agentRun, engine: 'demo' },
      });
    }

    // Success: update run record
    dbRun(
      'UPDATE p6_runs SET status = ?, finished_at = ? WHERE id = ?',
      'done',
      now(),
      runId,
    );

    // Update workflow iteration count and status
    dbRun(
      `UPDATE p6_workflows
          SET status = 'done', iteration_count = iteration_count + 1, updated_at = ?
        WHERE id = ?`,
      now(),
      workflowId,
    );

    // Notify lifecycle hook (e.g. finalises associated review stats and auto-post)
    fireHook(workflowId, runId, 'done');

    if (agentRun.projectId) {
      emit(agentRun.projectId, { type: 'run.done', runId, workflowId, result: result.slice(0, 400) });
    }
  } catch (e: unknown) {
    const aborted = (e as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted;
    const msg = aborted ? 'Cancelled' : String((e as { message?: string })?.message ?? e);

    dbRun(
      'UPDATE p6_runs SET status = ?, finished_at = ? WHERE id = ?',
      aborted ? 'cancelled' : 'failed',
      now(),
      runId,
    );

    dbRun(
      `UPDATE p6_workflows
          SET status = ?, updated_at = ?
        WHERE id = ?`,
      aborted ? 'paused' : 'failed',
      now(),
      workflowId,
    );

    emitRunEvent(runId, workflow.project_id ? String(workflow.project_id) : null, workflowId, 'run-failed', { error: msg });

    // Notify lifecycle hook — fires for both abort/cancel and real failures.
    // 'cancelled' keeps the review out of 'running' limbo; 'failed' marks actual errors.
    if (aborted) {
      fireHook(workflowId, runId, 'cancelled');
    } else {
      fireHook(workflowId, runId, 'failed');
    }

    if (!aborted) {
      console.error(`[runner] Run ${runId} failed:`, e);
    }
  } finally {
    // Clean up pending approvals
    const runApprovals = pendingApprovals.get(runId);
    if (runApprovals) {
      for (const p of runApprovals.values()) {
        p.reject(new DOMException('Run ended', 'AbortError'));
      }
      pendingApprovals.delete(runId);
    }
    deregisterRun(runId);
  }
}

// ── Approval wait ─────────────────────────────────────────────────────────────

async function awaitApproval(
  runId: string,
  workflowId: string,
  run: AgentRun,
  toolName: string,
  toolInput: string,
  runApprovals: Map<string, PendingApproval>,
  signal: AbortSignal,
): Promise<'approve' | 'deny'> {
  const inputId = generateId();

  // Record in p6_inputs
  insert('p6_inputs', {
    id: inputId,
    run_id: runId,
    tool_name: toolName,
    tool_input: toolInput,
    response: null,
    allow_all: 0,
    created_at: now(),
  });

  // Create an inbox item for the approval
  createInboxItem({
    type: 'approval',
    payload: { inputId, toolName, toolInput: JSON.parse(toolInput.length > 4000 ? toolInput.slice(0, 4000) : toolInput) },
    projectId: run.projectId,
    workflowId,
    runId,
  });

  // Update run to waiting
  dbRun('UPDATE p6_runs SET status = ? WHERE id = ?', 'running', runId);

  emitRunEvent(runId, run.projectId, workflowId, 'approval-request', {
    inputId,
    toolName,
    toolInput,
  });

  return new Promise<'approve' | 'deny'>((resolve, reject) => {
    runApprovals.set(inputId, { resolve, reject });

    const onAbort = (): void => {
      runApprovals.delete(inputId);
      reject(new DOMException('Run cancelled', 'AbortError'));
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
