/**
 * Delegation service — F7.
 *
 * Manages the lifecycle of delegated child sessions:
 *   - createChildSession()            — creates and starts a child workflow that inherits
 *                                       project, workspace, engine, credential, integrations
 *   - checkDelegationLimits()         — enforces per-parent and per-user caps (throws 429)
 *   - deliverChildResult()            — inserts child-result event into parent and resumes parent
 *   - stopAndDeleteChildren()         — recursive cleanup when parent is deleted
 *   - checkDelegationChildIdleStop()  — periodic idle-stop for finished children
 *
 * All data access for p6_workflows, p6_runs, p6_workflow_events goes through the
 * sessions repository so this module works on both SQLite and DynamoDB backends.
 */

import { generateId, now, HttpError, sha256 } from './util.ts';
import { emit } from './events.ts';
import { getDb } from './db.ts';
import type { DatabaseSync } from 'node:sqlite';
import { startRun } from './workflows/driver.ts';
import { cancelRun } from './workflows/controls.ts';
import { randomBytes } from 'node:crypto';
import { getApiTokenRepository } from './repositories/api-tokens.ts';
import { getDelegationSettingsRepository } from './repositories/delegation-settings.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import type { DelegationSettings } from './repositories/delegation-settings.ts';
import { DELEGATION_DEFAULTS } from './repositories/delegation-settings.ts';

// Re-export DelegationSettings type for callers that import it from here
export type { DelegationSettings };

// ── Settings (synchronous, SQLite-only compatibility helpers) ─────────────────

/**
 * Read delegation settings synchronously from the settings table.
 * Works in both SQLite mode and for tests that read settings via direct DB.
 * In DynamoDB mode, use getDelegationSettingsRepository().get() instead.
 */
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

/**
 * Write delegation settings synchronously to the settings table.
 * Works in SQLite mode. For DynamoDB mode, use getDelegationSettingsRepository().patch(patch).
 */
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
 * Assert delegation limits are not exceeded.
 * Throws HttpError 429 with a descriptive message if they are.
 * Async in DynamoDB mode (reads counter items); fast synchronous COUNT in SQLite mode.
 *
 * Pass `settings` when you already have the settings (avoids a second async read).
 */
export async function checkDelegationLimits(
  parentWorkflowId: string,
  userId: string,
  settings?: DelegationSettings,
): Promise<void> {
  const s = settings ?? await getDelegationSettingsRepository().get();

  if (!s.enabled) {
    throw new HttpError(429, 'Delegation is disabled by the portal administrator.');
  }

  const repo = getSessionsRepository();
  const runningChildren = await repo.countRunningChildWorkflows(parentWorkflowId);
  if (s.maxRunningPerParent > 0 && runningChildren >= s.maxRunningPerParent) {
    throw new HttpError(
      429,
      `This session already has ${runningChildren} running child session(s). ` +
        `The maximum per parent is ${s.maxRunningPerParent}. Wait for a child to finish.`,
    );
  }

  const userRunning = await repo.countRunningChildrenByUser(userId);
  if (s.maxRunningPerUser > 0 && userRunning >= s.maxRunningPerUser) {
    throw new HttpError(
      429,
      `You already have ${userRunning} running delegated sessions. ` +
        `The maximum per user is ${s.maxRunningPerUser}. Wait for a child to finish.`,
    );
  }
}

// ── Child session creation ────────────────────────────────────────────────────

/**
 * Create and start a child session that inherits the parent's project,
 * workspace, repos, engine, credential, integrations, and lead agent.
 *
 * Returns the child workflow record.
 */
export async function createChildSession(
  parentWorkflowId: string,
  userId: string,
  task: string,
  opts: { title?: string; leadAgent?: string } = {},
): Promise<import('./repositories/sessions.ts').WorkflowRecord> {
  const repo = getSessionsRepository();
  const parent = await repo.getWorkflowById(parentWorkflowId);
  if (!parent) throw new HttpError(404, 'Parent session not found');

  const settings = await getDelegationSettingsRepository().get();

  // Nested delegation check
  if (!settings.allowNested && parent.parent_id) {
    throw new HttpError(
      429,
      'Nested delegation is disabled. A child session cannot itself delegate to further children.',
    );
  }

  if (!settings.enabled) {
    throw new HttpError(429, 'Delegation is disabled by the portal administrator.');
  }

  // Atomically check limits and create the child workflow.
  // SQLite: uses tx() to check counts + insert atomically (TOCTOU-safe).
  // DynamoDB: uses TransactWriteItems with conditional counter increments.
  const childId = generateId();
  const ts = now();

  const child = await repo.createChildWorkflowChecked(
    {
      id: childId,
      project_id: parent.project_id,
      goal: task,
      title: opts.title ?? '',
      status: 'pending',
      engine: parent.engine || 'demo',
      trust_tools: parent.trust_tools,
      lead_agent: opts.leadAgent ?? parent.lead_agent,
      workspace_id: parent.workspace_id,
      output_files_enabled: 0,
      repo_ids: parent.repo_ids || '[]',
      iteration_count: 0,
      max_iterations: parent.max_iterations,
      credential_id: parent.credential_id,
      model: parent.model || '',
      created_by: userId,
      created_at: ts,
      updated_at: ts,
    },
    {
      parentId: parentWorkflowId,
      userId,
      maxRunningPerParent: settings.maxRunningPerParent,
      maxRunningPerUser: settings.maxRunningPerUser,
    },
  );

  // Start the run
  try {
    await startRun(childId);
    await repo.updateWorkflow(childId, {
      last_turn_at: ts,
      stop_reason: '',
      updated_at: ts,
    });
  } catch (e: unknown) {
    // startRun can throw if the concurrency limit is hit
    // Delete the child and release the delegation slot
    await repo.deleteWorkflow(childId).catch(() => {});
    await repo.releaseChildDelegationSlot(childId, parentWorkflowId, userId).catch(() => {});
    throw e;
  }

  if (parent.project_id) {
    emit(parent.project_id, {
      type: 'workflow.child-started',
      parentWorkflowId,
      childWorkflowId: childId,
    });
    emit(parent.project_id, { type: 'workflow.created', workflowId: childId });
  }

  return child;
}

// ── Child result delivery ─────────────────────────────────────────────────────

/** Longest child result posted to the parent. It becomes part of the parent's next prompt. */
export const MAX_CHILD_RESULT_CHARS = 8_000;

/** A child run's result as the parent gets it: trimmed, and cut to MAX_CHILD_RESULT_CHARS. */
export function childResultText(result: string | null | undefined): string {
  const text = String(result ?? '').trim();
  if (text.length <= MAX_CHILD_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_CHILD_RESULT_CHARS)}\n[The result was cut here. The child session has all of it.]`;
}

/**
 * Deliver a child-result event to the parent workflow.
 * Called after a child run finishes (done or failed), with the run's result: the agent's
 * answer, or why the run failed. That text is what the parent gets back from the child.
 *
 * If the parent is paused or done, it is resumed (new run started).
 * The delegation slot is released so the per-parent and per-user counters
 * are updated.
 */
export async function deliverChildResult(childWorkflowId: string, result = ''): Promise<void> {
  try {
    const repo = getSessionsRepository();
    const child = await repo.getWorkflowById(childWorkflowId);
    if (!child || !child.parent_id) return;

    const parentId = child.parent_id;
    const parent = await repo.getWorkflowById(parentId);
    if (!parent) return;

    const childTitle = child.title || child.goal.slice(0, 60);
    const childStatus = child.status ?? 'done';
    const summary = childResultText(result);

    // Release delegation running-child slot — idempotent via dlgSlotHeld flag.
    // SQLite: no-op. DynamoDB: TransactWriteItems clearing dlgSlotHeld + decrement counters.
    if (child.created_by) {
      await repo.releaseChildDelegationSlot(childWorkflowId, parentId, child.created_by).catch((e: unknown) => {
        console.error('[delegation] releaseChildDelegationSlot failed:', e);
      });
    }

    // Insert child-result event into parent's event log
    await repo.appendWorkflowEvent({
      workflow_id: parentId,
      kind: 'child-result',
      body: `Child session "${childTitle}" finished with status: ${childStatus}.\n${summary}`.trim(),
      data: JSON.stringify({
        childId: childWorkflowId,
        childTitle,
        status: childStatus,
        summary,
      }),
      created_at: now(),
    });

    // Emit project event
    if (parent.project_id) {
      emit(parent.project_id, {
        type: 'workflow.child-finished',
        parentWorkflowId: parentId,
        childWorkflowId,
        childTitle,
        status: childStatus,
      });
    }

    const parentStatus = parent.status ?? '';
    const parentHasIterations =
      parent.max_iterations <= 0 || parent.iteration_count < parent.max_iterations;

    if ((parentStatus === 'paused' || parentStatus === 'done') && parentHasIterations) {
      const resumeTs = now();
      const resumed = await repo.updateWorkflowConditional(parentId, parentStatus, {
        status: 'pending',
        stop_reason: '',
        last_turn_at: resumeTs,
        updated_at: resumeTs,
      }, { hintParentId: parent.parent_id });
      if (resumed) {
        if (parent.project_id) {
          emit(parent.project_id, { type: 'workflow.updated', workflowId: parentId, status: 'pending' });
        }
        startRun(parentId).catch((e: unknown) => {
          console.error(`[delegation] Failed to resume parent ${parentId} after child result:`, e);
        });
      }
    } else if ((parentStatus === 'paused' || parentStatus === 'done') && !parentHasIterations) {
      const doneTs = now();
      await repo.updateWorkflowConditional(parentId, parentStatus, {
        status: 'done',
        stop_reason: 'max_iterations',
        updated_at: doneTs,
      }, { hintParentId: parent.parent_id }).catch(() => {/* already updated */});
      if (parent.project_id) {
        emit(parent.project_id, { type: 'workflow.updated', workflowId: parentId, status: 'done' });
      }
    }
  } catch (e: unknown) {
    console.error('[delegation] Error delivering child result:', e);
  }
}

// ── Recursive child cleanup ───────────────────────────────────────────────────

/**
 * Stop and delete all direct and nested children of a workflow.
 * Called when a parent session is deleted.
 */
export async function stopAndDeleteChildren(parentWorkflowId: string): Promise<void> {
  const repo = getSessionsRepository();
  const children = await repo.listChildWorkflows(parentWorkflowId);

  for (const child of children) {
    const childId = child.id;

    // Recurse first (nested children)
    await stopAndDeleteChildren(childId);

    // Cancel any active runs
    const activeRun = await repo.getActiveRun(childId);
    if (activeRun) {
      try { cancelRun(activeRun.id); } catch { /* ignore */ }
    }

    // Release delegation slot before deleting (idempotent — no-op if slot not held)
    if (child.created_by) {
      await repo.releaseChildDelegationSlot(childId, parentWorkflowId, child.created_by).catch(() => {});
    }

    // Delete the child (cascades to runs + events via FK in SQLite; explicit in DynamoDB)
    await repo.deleteWorkflow(childId);
    if (child.project_id) {
      emit(child.project_id, { type: 'workflow.deleted', workflowId: childId });
    }
  }
}

// ── Child idle stop ───────────────────────────────────────────────────────────

/**
 * Stop finished children that have been idle for longer than idleStopMinutes.
 * Run periodically alongside the main idle-stop check.
 */
export async function checkDelegationChildIdleStop(): Promise<void> {
  try {
    const settings = await getDelegationSettingsRepository().get();
    const idleMinutes = settings.idleStopMinutes;
    const cutoff = new Date(Date.now() - idleMinutes * 60_000).toISOString();

    const repo = getSessionsRepository();
    const children = await repo.listTerminalChildWorkflows(cutoff);

    for (const child of children) {
      const childId = child.id;
      const ts = now();
      const updated = await repo.updateWorkflowConditional(childId, child.status, {
        status: 'paused',
        stop_reason: 'child-idle',
        updated_at: ts,
      }, { hintParentId: child.parent_id });
      if (!updated) continue; // concurrent update, skip

      if (child.project_id) {
        emit(child.project_id, {
          type: 'workflow.child-idle-stopped',
          childWorkflowId: childId,
        });
        emit(child.project_id, { type: 'workflow.updated', workflowId: childId, status: 'paused' });
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
