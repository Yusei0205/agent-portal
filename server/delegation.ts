/**
 * Delegation service — F7.
 *
 * Manages the lifecycle of delegated child sessions:
 *   - createChildSession()      — creates and starts a child workflow that inherits
 *                                 project, workspace, engine, credential, integrations
 *   - checkDelegationLimits()   — enforces per-parent and per-user caps (throws 429)
 *   - deliverChildResult()      — inserts child-result event into parent and resumes parent
 *   - stopAndDeleteChildren()   — recursive cleanup when parent is deleted
 *   - checkDelegationChildIdleStop() — periodic idle-stop for finished children
 */

import { one, all, insert, run as dbRun, getDb, tx } from './db.ts';
import type { Row } from './db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { generateId, now, HttpError, sha256 } from './util.ts';
import { emit } from './events.ts';
import { startRun } from './workflows/driver.ts';
import { cancelRun } from './workflows/controls.ts';
import { randomBytes } from 'node:crypto';
import { getApiTokenRepository } from './repositories/api-tokens.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DelegationSettings {
  enabled: boolean;
  maxRunningPerParent: number;
  maxRunningPerUser: number;
  idleStopMinutes: number;
  allowNested: boolean;
  nudgeThreshold: number;
}

const DELEGATION_DEFAULTS: DelegationSettings = {
  enabled: true,
  maxRunningPerParent: 3,
  maxRunningPerUser: 5,
  idleStopMinutes: 15,
  allowNested: false,
  nudgeThreshold: 4,
};

// ── Settings ──────────────────────────────────────────────────────────────────

export function getDelegationSettings(db?: DatabaseSync): DelegationSettings {
  const d = db ?? getDb();
  const out = { ...DELEGATION_DEFAULTS };

  const get = (key: string): string | null => {
    const r = d.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  };

  const enabled = get('delegation.enabled');
  if (enabled !== null) out.enabled = enabled === 'true';

  const maxParent = get('delegation.maxRunningPerParent');
  if (maxParent !== null) {
    const v = parseInt(maxParent, 10);
    if (Number.isFinite(v)) out.maxRunningPerParent = Math.max(0, Math.min(10, v));
  }

  const maxUser = get('delegation.maxRunningPerUser');
  if (maxUser !== null) {
    const v = parseInt(maxUser, 10);
    if (Number.isFinite(v)) out.maxRunningPerUser = Math.max(0, Math.min(20, v));
  }

  const idleStop = get('delegation.idleStopMinutes');
  if (idleStop !== null) {
    const v = parseInt(idleStop, 10);
    if (Number.isFinite(v)) out.idleStopMinutes = Math.max(1, Math.min(240, v));
  }

  const allowNested = get('delegation.allowNested');
  if (allowNested !== null) out.allowNested = allowNested === 'true';

  const nudge = get('delegation.nudgeThreshold');
  if (nudge !== null) {
    const v = parseInt(nudge, 10);
    if (Number.isFinite(v)) out.nudgeThreshold = Math.max(0, Math.min(20, v));
  }

  return out;
}

export function setDelegationSettings(patch: Partial<DelegationSettings>, db?: DatabaseSync): void {
  const d = db ?? getDb();
  const set = (key: string, value: string): void => {
    d.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  };

  if (patch.enabled !== undefined) set('delegation.enabled', String(patch.enabled));
  if (patch.maxRunningPerParent !== undefined) set('delegation.maxRunningPerParent', String(patch.maxRunningPerParent));
  if (patch.maxRunningPerUser !== undefined) set('delegation.maxRunningPerUser', String(patch.maxRunningPerUser));
  if (patch.idleStopMinutes !== undefined) set('delegation.idleStopMinutes', String(patch.idleStopMinutes));
  if (patch.allowNested !== undefined) set('delegation.allowNested', String(patch.allowNested));
  if (patch.nudgeThreshold !== undefined) set('delegation.nudgeThreshold', String(patch.nudgeThreshold));
}

// ── Limit checks ──────────────────────────────────────────────────────────────

/**
 * Count running children of the given parent workflow.
 * 'running' here means status = 'running' | 'pending'.
 */
function countRunningChildren(parentWorkflowId: string): number {
  const r = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM p6_workflows
      WHERE parent_id = ? AND status IN ('running','pending')`,
    parentWorkflowId,
  );
  return Number(r?.n ?? 0);
}

/**
 * Count all running child sessions across all workflows created by the given user.
 */
function countRunningChildrenForUser(userId: string): number {
  const r = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM p6_workflows
      WHERE parent_id IS NOT NULL
        AND created_by = ?
        AND status IN ('running','pending')`,
    userId,
  );
  return Number(r?.n ?? 0);
}

/**
 * Assert delegation limits are not exceeded.
 * Throws HttpError 429 with a descriptive message if they are.
 */
export function checkDelegationLimits(
  parentWorkflowId: string,
  userId: string,
): void {
  const settings = getDelegationSettings();

  if (!settings.enabled) {
    throw new HttpError(429, 'Delegation is disabled by the portal administrator.');
  }

  const runningChildren = countRunningChildren(parentWorkflowId);
  if (settings.maxRunningPerParent > 0 && runningChildren >= settings.maxRunningPerParent) {
    throw new HttpError(
      429,
      `This session already has ${runningChildren} running child session(s). ` +
        `The maximum per parent is ${settings.maxRunningPerParent}. Wait for a child to finish.`,
    );
  }

  const userRunning = countRunningChildrenForUser(userId);
  if (settings.maxRunningPerUser > 0 && userRunning >= settings.maxRunningPerUser) {
    throw new HttpError(
      429,
      `You already have ${userRunning} running delegated sessions. ` +
        `The maximum per user is ${settings.maxRunningPerUser}. Wait for a child to finish.`,
    );
  }
}

// ── Child session creation ────────────────────────────────────────────────────

/**
 * Create and start a child session that inherits the parent's project,
 * workspace, repos, engine, credential, integrations, and lead agent.
 *
 * Returns the child workflow row.
 */
export async function createChildSession(
  parentWorkflowId: string,
  userId: string,
  task: string,
  opts: { title?: string; leadAgent?: string } = {},
): Promise<Row> {
  const parent = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', parentWorkflowId);
  if (!parent) throw new HttpError(404, 'Parent session not found');

  const settings = getDelegationSettings();

  // Nested delegation check
  if (!settings.allowNested && parent.parent_id) {
    throw new HttpError(
      429,
      'Nested delegation is disabled. A child session cannot itself delegate to further children.',
    );
  }

  // Atomically check limits + insert the child row to avoid TOCTOU races
  // where two concurrent createChildSession calls both pass the count check.
  const childId = generateId();
  const ts = now();

  tx(() => {
    // Re-check limits inside the transaction so the count is accurate
    checkDelegationLimits(parentWorkflowId, userId);

    insert('p6_workflows', {
      id: childId,
      project_id: parent.project_id != null ? String(parent.project_id) : null,
      goal: task,
      title: opts.title ?? '',
      status: 'pending',
      engine: parent.engine ? String(parent.engine) : 'demo',
      trust_tools: parent.trust_tools ? 1 : 0,
      lead_agent: opts.leadAgent ?? (parent.lead_agent != null ? String(parent.lead_agent) : null),
      workspace_id: parent.workspace_id != null ? String(parent.workspace_id) : null,
      output_files_enabled: 0,
      repo_ids: parent.repo_ids ? String(parent.repo_ids) : '[]',
      iteration_count: 0,
      max_iterations: Number(parent.max_iterations ?? 10),
      credential_id: parent.credential_id != null ? String(parent.credential_id) : null,
      model: parent.model != null ? String(parent.model) : '',
      parent_id: parentWorkflowId,
      created_by: userId,
      created_at: ts,
      updated_at: ts,
    });
  });

  // Start the run
  try {
    await startRun(childId);
    dbRun(
      "UPDATE p6_workflows SET last_turn_at = ?, stop_reason = '', updated_at = ? WHERE id = ?",
      ts,
      ts,
      childId,
    );
  } catch (e: unknown) {
    // startRun can throw if the concurrency limit is hit
    // Delete the child we just created to avoid zombie rows
    dbRun('DELETE FROM p6_workflows WHERE id = ?', childId);
    throw e;
  }

  if (parent.project_id) {
    emit(String(parent.project_id), {
      type: 'workflow.child-started',
      parentWorkflowId,
      childWorkflowId: childId,
    });
    emit(String(parent.project_id), { type: 'workflow.created', workflowId: childId });
  }

  return one<Row>('SELECT * FROM p6_workflows WHERE id = ?', childId)!;
}

// ── Child result delivery ─────────────────────────────────────────────────────

/**
 * Deliver a child-result event to the parent workflow.
 * Called after a child run finishes (done or failed).
 *
 * If the parent is paused or done, it is resumed (new run started).
 */
export function deliverChildResult(childWorkflowId: string): void {
  try {
    const child = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', childWorkflowId);
    if (!child || !child.parent_id) return;

    const parentId = String(child.parent_id);
    const parent = one<Row>('SELECT * FROM p6_workflows WHERE id = ?', parentId);
    if (!parent) return;

    const childTitle =
      String(child.title || (child.goal as string).slice(0, 60));
    const childStatus = String(child.status ?? 'done');
    const childSummary = String(child.summary ?? '');

    // Insert child-result event into parent's event log (unconsumed: will be
    // picked up as the next turn's prompt)
    insert('p6_workflow_events', {
      workflow_id: parentId,
      kind: 'child-result',
      body: `Child session "${childTitle}" finished with status: ${childStatus}.\n${childSummary}`.trim(),
      data: JSON.stringify({
        childId: childWorkflowId,
        childTitle,
        status: childStatus,
        summary: childSummary,
      }),
      consumed: 0,
      created_at: now(),
    });

    // Emit project event
    if (parent.project_id) {
      emit(String(parent.project_id), {
        type: 'workflow.child-finished',
        parentWorkflowId: parentId,
        childWorkflowId,
        childTitle,
        status: childStatus,
      });
    }

    // Resume parent if it is paused or done, and only when it has iterations left.
    // Guard: parent may not auto-resume more than max_iterations times from child
    // results without a human turn — prevents infinite delegation loops.
    const parentStatus = String(parent.status ?? '');
    const parentMaxIter = Number(parent.max_iterations ?? 0);
    const parentIterCount = Number(parent.iteration_count ?? 0);
    const parentHasIterations = parentMaxIter <= 0 || parentIterCount < parentMaxIter;

    if ((parentStatus === 'paused' || parentStatus === 'done') && parentHasIterations) {
      const ts = now();
      dbRun(
        "UPDATE p6_workflows SET status = 'pending', stop_reason = '', last_turn_at = ?, updated_at = ? WHERE id = ?",
        ts,
        ts,
        parentId,
      );
      if (parent.project_id) {
        emit(String(parent.project_id), { type: 'workflow.updated', workflowId: parentId, status: 'pending' });
      }
      // Fire-and-forget resume
      startRun(parentId).catch((e: unknown) => {
        console.error(`[delegation] Failed to resume parent ${parentId} after child result:`, e);
      });
    } else if ((parentStatus === 'paused' || parentStatus === 'done') && !parentHasIterations) {
      // Parent has exhausted its iterations — mark it done with max_iterations stop reason
      dbRun(
        `UPDATE p6_workflows SET status = 'done', stop_reason = 'max_iterations', updated_at = ? WHERE id = ? AND stop_reason != 'max_iterations'`,
        now(),
        parentId,
      );
      if (parent.project_id) {
        emit(String(parent.project_id), { type: 'workflow.updated', workflowId: parentId, status: 'done' });
      }
    }
  } catch (e: unknown) {
    // deliverChildResult errors must not propagate — child run should still complete cleanly
    console.error('[delegation] Error delivering child result:', e);
  }
}

// ── Recursive child cleanup ───────────────────────────────────────────────────

/**
 * Stop and delete all direct and nested children of a workflow.
 * Called when a parent session is deleted.
 */
export function stopAndDeleteChildren(parentWorkflowId: string): void {
  const children = all<Row>(
    'SELECT id, project_id FROM p6_workflows WHERE parent_id = ?',
    parentWorkflowId,
  );

  for (const child of children) {
    const childId = String(child.id);

    // Recurse first (nested children)
    stopAndDeleteChildren(childId);

    // Cancel any active runs
    const activeRun = one<Row>(
      "SELECT id FROM p6_runs WHERE workflow_id = ? AND status IN ('pending','running')",
      childId,
    );
    if (activeRun) {
      try { cancelRun(String(activeRun.id)); } catch { /* ignore */ }
    }

    // Delete the child (runs + events cascade via FK; p10_scans.repo_id is unrelated)
    dbRun('DELETE FROM p6_workflows WHERE id = ?', childId);
    if (child.project_id) {
      emit(String(child.project_id), { type: 'workflow.deleted', workflowId: childId });
    }
  }
}

// ── Child idle stop ───────────────────────────────────────────────────────────

/**
 * Stop finished children that have been idle for longer than idleStopMinutes.
 * Run periodically alongside the main idle-stop check.
 */
export function checkDelegationChildIdleStop(): void {
  try {
    const settings = getDelegationSettings();
    const idleMinutes = settings.idleStopMinutes;
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();

    // Find children in terminal states that need cleanup (done/failed/paused)
    const children = all<Row>(
      `SELECT id, project_id FROM p6_workflows
        WHERE parent_id IS NOT NULL
          AND status IN ('done','failed','paused')
          AND updated_at < ?`,
      cutoff,
    );

    for (const child of children) {
      const childId = String(child.id);
      // Mark as paused with stop_reason = 'child-idle'
      dbRun(
        `UPDATE p6_workflows SET status = 'paused', stop_reason = 'child-idle', updated_at = ? WHERE id = ?`,
        now(),
        childId,
      );

      if (child.project_id) {
        emit(String(child.project_id), {
          type: 'workflow.child-idle-stopped',
          childWorkflowId: childId,
        });
        emit(String(child.project_id), { type: 'workflow.updated', workflowId: childId, status: 'paused' });
      }
    }
  } catch (e: unknown) {
    console.error('[delegation] Error in child idle stop check:', e);
  }
}

// ── Short-lived delegate token (for Kiro MCP auth) ────────────────────────────

export interface RunToken {
  raw: string;
  hash: string;
  tokenId: string;
}

/**
 * Create a least-privilege delegate token for a single Kiro run.
 *
 * Security properties:
 *   - scope: ['delegate'] only — accepted exclusively at /api/mcp, and within
 *     MCP only the delegate_session tool is registered for this scope.
 *   - Bound to workflowId: the MCP server enforces that the token can only
 *     create children of this parent workflow; any workflowId supplied by the
 *     caller is ignored.
 *   - Hard expiry: 1 hour regardless of run duration.
 *   - Hidden from the API Access token list and token stats.
 *   - Revoked explicitly in kiro.ts via revokeRunToken() in a finally block.
 */
export async function createRunToken(userId: string, workflowId: string): Promise<RunToken> {
  const raw = 'ap_' + randomBytes(16).toString('hex');
  const hash = sha256(raw);
  const tokenId = generateId();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(); // 1h hard cap
  const ts = now();

  await getApiTokenRepository().create({
    id: tokenId,
    user_id: userId,
    name: `[delegate-${tokenId.slice(0, 8)}]`,
    token_hash: hash,
    prefix: 'ap_' + raw.slice(3, 7),
    scope: 'read', // legacy column kept for schema compat; effective scope is 'delegate'
    scopes: JSON.stringify(['delegate']),
    expires_at: expiresAt,
    workflow_id: workflowId,
    project_id: null,
    created_at: ts,
  });

  return { raw, hash, tokenId };
}

/**
 * Revoke a previously created run token.
 */
export async function revokeRunToken(tokenId: string, userId: string): Promise<void> {
  try {
    await getApiTokenRepository().revoke(tokenId, userId, now());
  } catch {
    // Non-fatal
  }
}
