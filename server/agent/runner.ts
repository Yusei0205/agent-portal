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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { one, all, run as dbRun, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { generateId, now } from '../util.ts';
import { emit, emitGlobal } from '../events.ts';
import { loadRunPermissions, evaluateCommand } from '../guardrails.ts';
import { createWorkDir } from '../workflows/working-copies.ts';
import { registerRun, deregisterRun } from '../workflows/controls.ts';
import { createInboxItem } from '../inbox.ts';
import { config } from '../config.ts';
import type { AgentRun, RunContext } from './types.ts';
import { runDemo } from './demo.ts';
import { runClaudeCode } from './claude-code.ts';
import { runKiro } from './kiro.ts';
import { materialiseForRun, cleanupRunHome } from '../user-config.ts';
import { deliverChildResult } from '../delegation.ts';
import { issueDetail, downloadAttachments, mustMapping } from '../jira.ts';
import { ticketMarkdown, composeRunPrompt } from '../jira-text.ts';

// ── Dashboard change notifications ────────────────────────────────────────────

/**
 * Debounced emitter for `dashboard.changed` events.
 * Bursts of status changes within 500 ms are collapsed into a single global
 * event so the frontend does not get flooded during parallel agent runs.
 *
 * The event carries NO project-identifying data — it is a refetch trigger only.
 * The frontend matches on `type` and refetches; the server re-applies access
 * scope on each fetch. This prevents cross-project information leaks via the
 * global SSE channel (invariant: per-project data must not reach global
 * subscribers, per portal-events.ts).
 */
const _DASH_KEY = 'global';
const _dashPending = new Map<string, ReturnType<typeof setTimeout>>();

export function notifyDashboard(_projectId: string | null): void {
  const existing = _dashPending.get(_DASH_KEY);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _dashPending.delete(_DASH_KEY);
    emitGlobal({ type: 'dashboard.changed' });
  }, 500);
  // Allow the Node.js process to exit even while the timer is pending
  if (typeof t === 'object' && t !== null && 'unref' in t) (t as { unref(): void }).unref();
  _dashPending.set(_DASH_KEY, t);
}

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

  // ── Working copy: reuse persistent dir or create on first run ────────────
  //
  // Each workflow gets ONE working copy for its entire lifetime so file
  // artefacts (repos, generated files, agent configs) survive across runs.
  // The path is stored in p6_workflows.work_dir after the first run creates it.
  let workDir: string;
  if (workflow.work_dir) {
    workDir = String(workflow.work_dir);
    // Ensure the directory exists (defensive; it should already)
    await fsp.mkdir(workDir, { recursive: true });
  } else {
    // First run: create a persistent working copy keyed to the workflow
    workDir = await createWorkDir(workflowId, projectDir);
    dbRun(
      'UPDATE p6_workflows SET work_dir = ?, updated_at = ? WHERE id = ?',
      workDir,
      now(),
      workflowId,
    );
  }

  // ── Determine the prompt for this run ─────────────────────────────────────
  //
  // On first run (no unconsumed events), use the original goal.
  // On resume, use the unconsumed human/command messages that arrived since
  // the last run.  Mark them consumed so they are not replayed.
  const pendingEvents = all<Row>(
    `SELECT id, kind, body FROM p6_workflow_events
      WHERE workflow_id = ? AND consumed = 0 AND kind IN ('human', 'command', 'child-result')
      ORDER BY id ASC`,
    workflowId,
  );

  let prompt: string;
  if (pendingEvents.length > 0) {
    // Mark all fetched events consumed before the run starts (atomic intent)
    const maxId = Number(pendingEvents[pendingEvents.length - 1].id);
    dbRun(
      `UPDATE p6_workflow_events SET consumed = 1
        WHERE workflow_id = ? AND id <= ? AND kind IN ('human', 'command', 'child-result') AND consumed = 0`,
      workflowId,
      maxId,
    );
    prompt = pendingEvents.map((m) => String(m.body)).join('\n\n');
  } else {
    prompt = String(workflow.goal);
  }

  // ── Jira ticket context ───────────────────────────────────────────────────
  // When the workflow has a jira_key, fetch the latest ticket (including any
  // new comments) and download its attachments into the run's work dir so the
  // agent can read them. Compose the final prompt with the ticket fenced as
  // untrusted content. If Jira is unreachable, emit a status event and
  // continue with the goal alone.
  const jiraKey = workflow.jira_key ? String(workflow.jira_key).trim() : '';
  if (jiraKey && workflow.project_id) {
    try {
      const projectId = String(workflow.project_id);
      const mapping = mustMapping(projectId);
      const rawTicket = await issueDetail(projectId, mapping, jiraKey);
      const ticket = await downloadAttachments(projectId, rawTicket, workDir);
      const ticketMd = ticketMarkdown(ticket);

      // Resolve the primary repo name for the prompt (first matched repo, if any)
      let repoName: string | null = null;
      const repoIds = parseJsonArray(String(workflow.repo_ids ?? '[]'));
      if (repoIds.length > 0) {
        const repo = one<Row>('SELECT name FROM repositories WHERE id = ?', repoIds[0]);
        repoName = repo ? String(repo.name) : null;
      }

      // Wrap the user's instruction (or goal on first run) with the fenced ticket
      prompt = composeRunPrompt({ instruction: prompt, repoName, ticket: ticketMd, key: jiraKey });

      // Emit a Jira meta event so clients can show the linked ticket
      emit(projectId, {
        type: 'run.jira',
        runId,
        workflowId,
        jiraKey,
        jiraUrl: ticket.url,
        jiraSummary: ticket.summary,
      });
    } catch (e: unknown) {
      // Jira unreachable: log a status event and continue with the goal alone
      const msg = String((e as { message?: string })?.message ?? e).slice(0, 200);
      emitRunEvent(
        runId,
        workflow.project_id ? String(workflow.project_id) : null,
        workflowId,
        'status',
        { text: `Could not read ${jiraKey} from Jira, continuing without ticket context: ${msg}` },
      );
    }
  }

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
  notifyDashboard(workflow.project_id ? String(workflow.project_id) : null);

  // Notify lifecycle hook (e.g. marks associated review as 'running')
  fireHook(workflowId, runId, 'start');

  // Register abort controller
  const ctrl = registerRun(runId);

  try {
    // Materialise user config into run home (F5)
    await materialiseForRun(workflowId, runId, workDir);

    // Load permissions
    const permissions = await loadRunPermissions(workflow.project_id ? String(workflow.project_id) : null);

    // Build the AgentRun descriptor
    const agentRun: AgentRun = {
      runId,
      workflowId,
      projectId: workflow.project_id ? String(workflow.project_id) : null,
      goal: prompt,  // pending messages on resume; original goal on first run
      kind: workflow.kind ? String(workflow.kind) : null,
      engine: (workflow.engine as 'claude-code' | 'kiro' | 'demo') || 'demo',
      trusted: Boolean(workflow.trust_tools),
      dataDir: config.dataDir,
      workDir,
      repoIds: parseJsonArray(String(workflow.repo_ids ?? '[]')),
      leadAgent: workflow.lead_agent ? String(workflow.lead_agent) : null,
      permissions,
      credentialId: workflow.credential_id ? String(workflow.credential_id) : null,
      credentialOwnerId: workflow.created_by ? String(workflow.created_by) : null,
      model: workflow.model && String(workflow.model).trim() ? String(workflow.model).trim() : null,
    };

    // Set up the run's approval map
    const runApprovals = new Map<string, PendingApproval>();
    pendingApprovals.set(runId, runApprovals);

    const runContext: RunContext = {
      run: agentRun,
      emit: (type, payload) => emitRunEvent(runId, agentRun.projectId, agentRun.workflowId, type, payload),
      awaitInput: (toolName, toolInput) => awaitApproval(runId, workflowId, agentRun, toolName, toolInput, runApprovals, ctrl.signal),
      allowAll: new Set<string>(),
      signal: ctrl.signal,
    };

    // Prepare review work directory (write diff.patch so real engines can read it)
    if (agentRun.kind === 'review' && agentRun.engine !== 'demo') {
      await prepareReviewWorkDir(agentRun, workDir).catch((e) => {
        // Non-fatal: log but continue; the engine may still work from the goal text
        console.warn(`[runner] Review workDir prep failed for ${runId}:`, e);
      });
    }

    // Run the appropriate engine
    let result: string;
    if (agentRun.engine === 'demo') {
      result = await runDemo(runContext);
    } else if (agentRun.engine === 'claude-code') {
      result = await runClaudeCode(runContext);
    } else if (agentRun.engine === 'kiro') {
      result = await runKiro(runContext);
    } else {
      // Unknown engine: fail with a clear error (requirement D-12 — no silent fallback)
      throw new Error(`Unknown engine "${agentRun.engine}". Set the workflow engine to claude-code, kiro, or demo.`);
    }

    // Success: update run record
    dbRun(
      'UPDATE p6_runs SET status = ?, finished_at = ? WHERE id = ?',
      'done',
      now(),
      runId,
    );

    // Update workflow: iteration count, status, and last_turn_at (item 5: set on completion)
    dbRun(
      `UPDATE p6_workflows
          SET status = 'done', iteration_count = iteration_count + 1,
              last_turn_at = ?, updated_at = ?
        WHERE id = ?`,
      now(),
      now(),
      workflowId,
    );

    // Notify lifecycle hook (e.g. finalises associated review stats and auto-post)
    fireHook(workflowId, runId, 'done');
    notifyDashboard(agentRun.projectId);

    // Deliver child-result to parent if this is a child session (F7)
    if (workflow.parent_id) {
      deliverChildResult(workflowId);
    }

    if (agentRun.projectId) {
      emit(agentRun.projectId, { type: 'run.done', runId, workflowId, result: result.slice(0, 400) });
      emit(agentRun.projectId, { type: 'run.updated', workflowId, runId, status: 'done' });
      emit(agentRun.projectId, { type: 'workflow.updated', workflowId, status: 'done' });
    }
  } catch (e: unknown) {
    const aborted = (e as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted;
    const msg = aborted ? 'Cancelled' : String((e as { message?: string })?.message ?? e);

    // Guard: if the run no longer exists in the current DB (e.g. test cleanup
    // replaced the in-memory DB while this background task was still running),
    // skip all DB writes to avoid FOREIGN KEY constraint errors.
    const runStillExists = (() => {
      try { return !!one<{ id: string }>('SELECT id FROM p6_runs WHERE id = ?', runId); }
      catch { return false; }
    })();

    if (!runStillExists) {
      deregisterRun(runId);
      return;
    }

    dbRun(
      'UPDATE p6_runs SET status = ?, finished_at = ? WHERE id = ?',
      aborted ? 'cancelled' : 'failed',
      now(),
      runId,
    );

    // Update workflow status and last_turn_at (item 5: also set on failure/cancellation)
    dbRun(
      `UPDATE p6_workflows
          SET status = ?, last_turn_at = ?, updated_at = ?
        WHERE id = ?`,
      aborted ? 'paused' : 'failed',
      now(),
      now(),
      workflowId,
    );

    emitRunEvent(runId, workflow.project_id ? String(workflow.project_id) : null, workflowId, 'run-failed', { error: msg });
    notifyDashboard(workflow.project_id ? String(workflow.project_id) : null);

    if (workflow.project_id) {
      emit(String(workflow.project_id), { type: 'run.updated', workflowId, runId, status: aborted ? 'cancelled' : 'failed' });
      emit(String(workflow.project_id), { type: 'workflow.updated', workflowId, status: aborted ? 'paused' : 'failed' });
    }

    // Notify lifecycle hook — fires for both abort/cancel and real failures.
    // 'cancelled' keeps the review out of 'running' limbo; 'failed' marks actual errors.
    if (aborted) {
      fireHook(workflowId, runId, 'cancelled');
    } else {
      fireHook(workflowId, runId, 'failed');
      // Deliver child-result to parent even on failure (F7)
      if (workflow.parent_id) {
        deliverChildResult(workflowId);
      }
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
    // Delete the materialised home directory (contains decrypted ~/.aws and SSO tokens).
    // workDir itself is intentionally kept so session artefacts survive across runs.
    await cleanupRunHome(runId);
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

// ── Review work directory prep ─────────────────────────────────────────────────

/**
 * For review runs: generate the git diff between the review's base_ref and
 * head_ref, writing it as diff.patch into the run's workDir. This lets real
 * engines read the actual changes instead of relying on the goal text alone.
 *
 * Non-fatal: the caller catches and logs errors.
 */
async function prepareReviewWorkDir(agentRun: AgentRun, workDir: string): Promise<void> {
  // Find the review record linked to this workflow
  const review = one<Row>(
    'SELECT base_ref, head_ref, repo_id FROM p10_reviews WHERE workflow_id = ?',
    agentRun.workflowId,
  );
  if (!review) return;

  const baseRef = String(review.base_ref ?? '');
  const headRef = String(review.head_ref ?? '');
  if (!baseRef || !headRef) return;

  // Find the repo clone directory
  const repoId = agentRun.repoIds[0] ?? (review.repo_id ? String(review.repo_id) : null);
  if (!repoId) return;

  const repo = one<Row>('SELECT * FROM repositories WHERE id = ?', repoId);
  if (!repo) return;

  const projectRow = agentRun.projectId
    ? one<Row>('SELECT slug FROM projects WHERE id = ?', agentRun.projectId)
    : null;
  const slug = String(projectRow?.slug ?? 'unknown');

  // Derive the clone directory (same logic as repos.ts repoDir)
  const repoName = String(repo.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cloneDir = path.join(config.dataDir, 'projects', slug, 'repos', repoName);

  if (!fs.existsSync(cloneDir)) return;

  // Run git diff to produce the patch
  const diff = await spawnGit(['diff', `${baseRef}...${headRef}`], cloneDir).catch(() => null);
  if (!diff) return;

  const patchPath = path.join(workDir, 'diff.patch');
  await import('node:fs/promises').then((fsp) => fsp.writeFile(patchPath, diff, 'utf8'));
}

async function spawnGit(args: string[], cwd: string): Promise<string> {
  const { spawn: _spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const proc = _spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || `git exited with ${code}`));
      }
    });
    proc.on('error', reject);
  });
}
