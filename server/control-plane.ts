/**
 * Session control plane — concurrency caps, graceful drain, queue management,
 * worktree TTL cleanup, approval SLA, and the status API.
 *
 * This module owns the shared mutable state for cap enforcement and drain mode.
 * It is imported by workflows.ts (to gate new sessions) and by index.ts
 * (to initiate SIGTERM drain and the periodic cleanup job).
 */
import path from 'node:path';
import fs from 'node:fs';
import { all, one, run as exec, type Row } from './db.ts';
import { get, post } from './http.ts';
import { now } from './util.ts';
import { publish, projectChannel } from './events.ts';
import { getSettings } from './settings.ts';

/* ------------------------------------------------------------------ */
/* Drain state                                                          */
/* ------------------------------------------------------------------ */

let draining = false;
let drainStart = 0;

/** True while the server is draining (accepting no new runs/sessions/iterations). */
export function isDraining(): boolean {
  return draining;
}

/**
 * Enter drain mode: stop accepting new runs/sessions/iterations.
 * Running iterations are allowed to finish up to timeoutMs.
 * Returns a promise that resolves when all active sessions have stopped
 * or the timeout expires (whichever comes first).
 */
export function startDrain(timeoutMs: number, checkRunning: () => boolean): Promise<void> {
  if (draining) return Promise.resolve();
  draining = true;
  drainStart = Date.now();
  console.log('[drain] Drain mode started; waiting up to', Math.round(timeoutMs / 1000), 's for running sessions to finish.');
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!checkRunning() || Date.now() - drainStart >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(check, 500).unref();
    };
    check();
  });
}

export function stopDrain(): void {
  draining = false;
}

/* ------------------------------------------------------------------ */
/* Concurrency cap helpers                                              */
/* ------------------------------------------------------------------ */

export interface ConcurrencyCaps {
  /** Max top-level running sessions across all users (0 = no cap). */
  globalMax: number;
  /** Max top-level running sessions per user (0 = no cap). */
  perUserMax: number;
  /** Max top-level running sessions per project (0 = no cap). */
  perProjectMax: number;
}

const DEFAULT_CAPS: ConcurrencyCaps = {
  globalMax: 0,
  perUserMax: 5,
  perProjectMax: 0,
};

export function getCaps(): ConcurrencyCaps {
  const s = getSettings();
  const cp = s.controlPlane ?? {};
  return {
    globalMax: Number(cp.globalMax ?? DEFAULT_CAPS.globalMax),
    perUserMax: Number(cp.perUserMax ?? DEFAULT_CAPS.perUserMax),
    perProjectMax: Number(cp.perProjectMax ?? DEFAULT_CAPS.perProjectMax),
  };
}

/** Count top-level running sessions (depth = 0, status = running). */
function countRunning(filter?: { userId?: string; projectId?: string }): number {
  const conditions: string[] = ["status = 'running'", "depth = 0"];
  const params: string[] = [];
  if (filter?.userId) { conditions.push('created_by = ?'); params.push(filter.userId); }
  if (filter?.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId); }
  return Number(one<{ n: number }>(`SELECT COUNT(*) AS n FROM workflows WHERE ${conditions.join(' AND ')}`, ...params)?.n ?? 0);
}

/** Total top-level running sessions. */
export function runningCount(): number {
  return countRunning();
}

/**
 * Check whether a new top-level session can start.
 * Returns null if it can, or an error message if it cannot.
 */
export function checkConcurrency(userId: string, projectId: string): string | null {
  const caps = getCaps();

  if (isDraining()) {
    return 'The server is restarting soon. New sessions are paused. Please try again in a moment.';
  }

  if (caps.globalMax > 0 && countRunning() >= caps.globalMax) {
    return `The portal already has ${caps.globalMax} sessions running. Stop one to start another.`;
  }

  if (caps.perUserMax > 0 && countRunning({ userId }) >= caps.perUserMax) {
    return `You already have ${caps.perUserMax} sessions running. Stop one to start another.`;
  }

  if (caps.perProjectMax > 0 && countRunning({ projectId }) >= caps.perProjectMax) {
    return `This project already has ${caps.perProjectMax} sessions running. Stop one to start another.`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Queue management                                                    */
/* ------------------------------------------------------------------ */

/**
 * Returns which concurrency cap is hit (and the reason string), or null if none is hit.
 * Drain mode always returns a reason but does NOT queue — queued sessions stay queued.
 */
export function concurrencyReason(userId: string, projectId: string): string | null {
  const caps = getCaps();
  if (isDraining()) return 'drain';
  if (caps.globalMax > 0 && countRunning() >= caps.globalMax) return `global:${caps.globalMax}`;
  if (caps.perUserMax > 0 && countRunning({ userId }) >= caps.perUserMax) return `user:${caps.perUserMax}`;
  if (caps.perProjectMax > 0 && countRunning({ projectId }) >= caps.perProjectMax) return `project:${caps.perProjectMax}`;
  return null;
}

/** Human-readable label for a queue_reason value. */
export function queueReasonLabel(reason: string): string {
  if (!reason) return '';
  if (reason === 'drain') return 'The server is restarting soon.';
  if (reason.startsWith('global:')) return `The portal is at its concurrency limit (${reason.split(':')[1]} sessions).`;
  if (reason.startsWith('user:')) return `You have reached your session limit (${reason.split(':')[1]} running).`;
  if (reason.startsWith('project:')) return `This project is at its session limit (${reason.split(':')[1]} running).`;
  return reason;
}

/** Queue position of a workflow (1-based, among queued workflows in the same project ordered by queued_at). */
export function queuePosition(workflowId: string): number {
  const w = one<{ project_id: string; queued_at: string | null }>('SELECT project_id, queued_at FROM workflows WHERE id = ?', workflowId);
  if (!w || !w.queued_at) return 0;
  const pos = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM workflows WHERE status = 'queued' AND project_id = ? AND queued_at <= ?",
    w.project_id, w.queued_at,
  );
  return Number(pos?.n ?? 1);
}

/**
 * Kick the oldest queued top-level session (FIFO by queued_at) in each project whose
 * concurrency slot just freed. Called by workflows.ts after a session stops/pauses/finishes.
 * Returns the ids of sessions started.
 */
export function drainQueue(): string[] {
  if (isDraining()) return [];
  // Find queued sessions, oldest first across all projects.
  const queued = all<Row>(
    "SELECT id, project_id, created_by FROM workflows WHERE status = 'queued' AND parent_id IS NULL ORDER BY queued_at ASC, created_at ASC LIMIT 50",
  );
  const started: string[] = [];
  for (const w of queued) {
    // Re-check caps for this session's user + project.
    const reason = concurrencyReason(String(w.created_by), String(w.project_id));
    if (reason) continue; // still over cap
    // Promote to running.
    exec(
      "UPDATE workflows SET status = 'running', queue_reason = '', queued_at = NULL, stop_reason = '', updated_at = ? WHERE id = ?",
      now(), w.id,
    );
    started.push(String(w.id));
    publish(projectChannel(String(w.project_id)), 'workflow.updated', { id: w.id });
  }
  return started;
}

/* ------------------------------------------------------------------ */
/* Worktree TTL cleanup                                                */
/* ------------------------------------------------------------------ */

/**
 * Remove `work/<runId>/` folders for finished sessions that are older than
 * `ttlDays`. Never deletes folders with uncommitted changes; flags them instead.
 *
 * Returns { deleted, skipped } counts.
 */
export async function cleanupWorktrees(
  getProjectDir: (projectId: string) => string | null,
  ttlDays: number,
): Promise<{ deleted: number; skipped: number }> {
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();

  // Finished sessions older than the cutoff
  const finished = all<Row>(
    `SELECT w.id AS wid, w.project_id,
            r.id AS run_id, r.worktree, r.meta, r.finished_at
       FROM workflows w
       LEFT JOIN agent_runs r ON r.id = w.last_run_id
      WHERE w.status IN ('done','stopped','failed')
        AND w.updated_at < ?`,
    cutoff,
  );

  let deleted = 0;
  let skipped = 0;

  for (const row of finished) {
    const pdir = getProjectDir(row.project_id);
    if (!pdir) continue;

    // Collect the work directory for this session's last run.
    let workDir: string | null = null;
    if (row.meta) {
      try {
        const m = JSON.parse(row.meta);
        if (m.workDir) workDir = path.join(pdir, m.workDir);
      } catch { /* ignore */ }
    }
    if (!workDir) continue;
    if (!fs.existsSync(workDir)) continue;

    // Keep the folder when a working copy in it holds work that exists nowhere else, or when that cannot be checked.
    const check = await checkWorkingCopies(workDir);
    if (check.keep) {
      // Flag with a workflow event instead of deleting.
      skipped++;
      const flagged = one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflow_events WHERE workflow_id = ? AND kind = 'worktree_dirty'",
        row.wid,
      )?.n ?? 0;
      if (!flagged) {
        exec(
          "INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, 'worktree_dirty', ?, ?, ?, 0, ?)",
          row.wid,
          row.run_id ?? null,
          check.keep,
          JSON.stringify({ workDir: path.relative(pdir, workDir).replace(/\\/g, '/'), flagged: true }),
          now(),
        );
        publish(projectChannel(row.project_id), 'workflow.updated', { id: row.wid });
      }
      continue;
    }

    // Safe to delete. Then the repository clones forget the deleted worktrees: git would otherwise keep their
    // branches "checked out" there and refuse to check them out in a later run's worktree.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      deleted++;
    } catch (e) {
      console.error('[cleanup] Could not remove', workDir, e);
      skipped++;
      continue;
    }
    const { git } = await import('./git.ts');
    for (const common of check.clones) await git(['--git-dir', common, 'worktree', 'prune'], { timeoutMs: 60_000 }).catch(() => undefined);
  }

  return { deleted, skipped };
}

/**
 * Whether a run folder may be deleted. `keep` is the reason to keep it (shown to the session's people), or '' when
 * every git working copy in it (the folder itself and its direct subfolders) is clean and has no commit that is not
 * on a remote. A copy git cannot check (an error or a timeout) keeps the folder: losing work is worse than keeping
 * a folder. `clones` are the git folders of the repository clones that the worktrees belong to.
 */
export async function checkWorkingCopies(workDir: string): Promise<{ keep: string; clones: string[] }> {
  const { git } = await import('./git.ts');
  let dirs: string[];
  try {
    dirs = [workDir, ...fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(workDir, e.name))];
  } catch {
    return { keep: 'The working copy of this session could not be read, so it was kept. Review it, then push or discard it.', clones: [] };
  }
  const clones = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    try {
      const opts = { cwd: dir, timeoutMs: 60_000 };
      if ((await git(['status', '--porcelain'], opts)).stdout.trim()) {
        return { keep: 'This session has uncommitted changes in its working copy. Review and push or discard them before the folder is cleaned up.', clones: [] };
      }
      if (Number((await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], opts)).stdout.trim()) > 0) {
        return { keep: 'This session has commits in its working copy that were never pushed. Push or discard them before the folder is cleaned up.', clones: [] };
      }
      const common = path.resolve(dir, (await git(['rev-parse', '--git-common-dir'], opts)).stdout.trim());
      if (!isInside(workDir, common)) clones.add(common);
    } catch {
      return { keep: 'The working copy of this session could not be checked (git failed or took too long), so it was kept. Review it, then push or discard it.', clones: [] };
    }
  }
  return { keep: '', clones: [...clones] };
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* ------------------------------------------------------------------ */
/* Approval SLA                                                        */
/* ------------------------------------------------------------------ */

/** Check for overdue pending inputs and publish events. Called periodically. */
export function checkApprovalSla(slaMinutes: number): void {
  if (slaMinutes <= 0) return;
  const cutoff = new Date(Date.now() - slaMinutes * 60_000).toISOString();

  // Find inputs that have been pending longer than the SLA and haven't been escalated yet
  const overdue = all<Row>(
    `SELECT i.id, i.project_id, i.run_id, i.type, i.tool_name,
            i.created_at, i.expires_at, i.escalated_at
       FROM inputs i
      WHERE i.status = 'pending'
        AND i.created_at < ?
        AND i.escalated_at IS NULL`,
    cutoff,
  );

  for (const inp of overdue) {
    // Mark as escalated
    exec(
      'UPDATE inputs SET escalated_at = ? WHERE id = ?',
      now(),
      inp.id,
    );
    // Publish an input.overdue event
    publish(projectChannel(inp.project_id), 'input.overdue', {
      id: inp.id,
      project_id: inp.project_id,
      run_id: inp.run_id,
      type: inp.type,
      tool_name: inp.tool_name,
      created_at: inp.created_at,
      overdue_since: cutoff,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Budget threshold events                                             */
/* ------------------------------------------------------------------ */

/**
 * Publish budget.threshold events (80 % and 100 %) to the project SSE channel.
 * Called after each completed run to check if any threshold was just crossed.
 */
export function checkBudgetThresholds(opts: {
  projectId: string | null;
  userId: string | null;
  newSpendUsd: number;
  projectBudgetUsd: number | null;
  userBudgetUsd: number | null;
  userMonthSpendUsd: number;
  projectMonthSpendUsd: number;
}): void {
  const thresholds = [0.8, 1.0];

  if (opts.projectBudgetUsd && opts.projectBudgetUsd > 0 && opts.projectId) {
    for (const t of thresholds) {
      const prevSpend = Math.max(0, opts.projectMonthSpendUsd - opts.newSpendUsd);
      const prev = prevSpend / opts.projectBudgetUsd;
      const cur = opts.projectMonthSpendUsd / opts.projectBudgetUsd;
      if (prev < t && cur >= t) {
        publish(projectChannel(opts.projectId), 'budget.threshold', {
          kind: 'project',
          project_id: opts.projectId,
          threshold: t,
          spent_usd: opts.projectMonthSpendUsd,
          budget_usd: opts.projectBudgetUsd,
        });
      }
    }
  }

  if (opts.userBudgetUsd && opts.userBudgetUsd > 0 && opts.userId && opts.projectId) {
    for (const t of thresholds) {
      const prevSpend = Math.max(0, opts.userMonthSpendUsd - opts.newSpendUsd);
      const prev = prevSpend / opts.userBudgetUsd;
      const cur = opts.userMonthSpendUsd / opts.userBudgetUsd;
      if (prev < t && cur >= t) {
        publish(projectChannel(opts.projectId), 'budget.threshold', {
          kind: 'user',
          user_id: opts.userId,
          threshold: t,
          spent_usd: opts.userMonthSpendUsd,
          budget_usd: opts.userBudgetUsd,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Status API                                                          */
/* ------------------------------------------------------------------ */

export function registerControlPlaneRoutes(): void {
  /** Admin status endpoint — queue depth, running counts, drain state, caps. */
  get('/api/admin/control-plane', (_ctx) => {
    const caps = getCaps();

    const running = countRunning();
    const queued = Number(
      one<{ n: number }>("SELECT COUNT(*) AS n FROM workflows WHERE status = 'queued'")?.n ?? 0,
    );
    const waitingApprovals = Number(
      one<{ n: number }>("SELECT COUNT(*) AS n FROM inputs WHERE status = 'pending'")?.n ?? 0,
    );

    return {
      drain: {
        active: draining,
        startedAt: draining ? new Date(drainStart).toISOString() : null,
      },
      sessions: {
        running,
        queued,
      },
      approvals: {
        pending: waitingApprovals,
      },
      caps,
    };
  }, { auth: 'admin' });

  /** Admin endpoint to toggle drain mode. */
  post('/api/admin/drain', async (ctx) => {
    const body = await ctx.json<{ enable: boolean }>();
    if (body.enable) {
      if (!draining) {
        draining = true;
        drainStart = Date.now();
      }
    } else {
      draining = false;
    }
    return { drain: { active: draining, startedAt: draining ? new Date(drainStart).toISOString() : null } };
  }, { auth: 'admin' });
}

/* ------------------------------------------------------------------ */
/* Per-user monthly budget spend helper                               */
/* ------------------------------------------------------------------ */

export function userMonthSpend(userId: string): number {
  const d = new Date();
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const r = one<{ s: number }>(
    'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE created_by = ? AND created_at >= ?',
    userId, since,
  );
  return r?.s ?? 0;
}
