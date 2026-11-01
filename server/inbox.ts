/**
 * Inbox management — approval requests, questions, push notifications, blocked sessions.
 *
 * Routes:
 *   GET  /api/inbox            — list unresolved items for the current user
 *   GET  /api/inbox/count      — { count } unresolved items (for nav badge)
 *   POST /api/inbox/:id/resolve — resolve (approve/dismiss) an inbox item
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { one, all, insert, run } from './db.ts';
import type { Row } from './db.ts';
import { generateId, now, badRequest } from './util.ts';
import { emit } from './events.ts';
import { resolveApproval } from './agent/approvals.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InboxType = 'approval' | 'question' | 'push' | 'blocked' | 'review-ready';

export interface InboxItemCreate {
  type: InboxType;
  payload: object;
  projectId?: string | null;
  workflowId?: string | null;
  runId?: string | null;
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Create a new inbox item and notify the project channel.
 * Returns the created row id.
 */
export function createInboxItem(opts: InboxItemCreate): string {
  const id = generateId();
  insert('p6_inbox', {
    id,
    project_id: opts.projectId ?? null,
    workflow_id: opts.workflowId ?? null,
    run_id: opts.runId ?? null,
    type: opts.type,
    payload: JSON.stringify(opts.payload),
    resolved: 0,
    resolved_by: null,
    resolved_at: null,
    created_at: now(),
  });
  // Notify project subscribers
  if (opts.projectId) {
    emit(opts.projectId, {
      type: 'inbox.created',
      inboxId: id,
      itemType: opts.type,
      workflowId: opts.workflowId ?? null,
      runId: opts.runId ?? null,
    });
  }
  return id;
}

// ── View helper ───────────────────────────────────────────────────────────────

function inboxView(row: Row, projectName?: string, workflowGoal?: string) {
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: projectName ?? null,
    workflow_id: row.workflow_id,
    workflow_goal: workflowGoal ?? null,
    run_id: row.run_id,
    type: row.type,
    payload: safeJson(row.payload as string, {}),
    resolved: Boolean(row.resolved),
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at ?? null,
    created_at: row.created_at,
    elapsed_ms: Date.now() - new Date(String(row.created_at)).getTime(),
  };
}

function safeJson(s: string | null | undefined, fallback: unknown): unknown {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerInboxRoutes(): void {

  // GET /api/inbox
  router.get('/api/inbox', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const limit = Math.min(Number(req.query.get('limit') ?? 100), 200);
    const offset = Number(req.query.get('offset') ?? 0);

    // Load items the user has access to: all projects they are a member of (or all for admins)
    let items: Row[];
    if (req.user.is_admin) {
      items = all<Row>(
        `SELECT i.* FROM p6_inbox i
          WHERE i.resolved = 0
          ORDER BY i.created_at DESC
          LIMIT ? OFFSET ?`,
        limit,
        offset,
      );
    } else {
      items = all<Row>(
        `SELECT i.* FROM p6_inbox i
           JOIN project_members pm ON pm.project_id = i.project_id AND pm.user_id = ?
          WHERE i.resolved = 0
          ORDER BY i.created_at DESC
          LIMIT ? OFFSET ?`,
        req.user.id as string,
        limit,
        offset,
      );
    }

    const enriched = items.map((item) => {
      const project = item.project_id
        ? one<Row>('SELECT name FROM projects WHERE id = ?', item.project_id as string)
        : null;
      const workflow = item.workflow_id
        ? one<Row>('SELECT goal FROM p6_workflows WHERE id = ?', item.workflow_id as string)
        : null;
      return inboxView(item, project?.name as string | undefined, workflow?.goal as string | undefined);
    });

    // Total count
    let total: number;
    if (req.user.is_admin) {
      total = (one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_inbox WHERE resolved = 0')?.n ?? 0);
    } else {
      total = (one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM p6_inbox i
           JOIN project_members pm ON pm.project_id = i.project_id AND pm.user_id = ?
          WHERE i.resolved = 0`,
        req.user.id as string,
      )?.n ?? 0);
    }

    sendJson(res, 200, { items: enriched, total });
  });

  // GET /api/inbox/count
  router.get('/api/inbox/count', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    let count: number;
    if (req.user.is_admin) {
      count = one<{ n: number }>('SELECT COUNT(*) AS n FROM p6_inbox WHERE resolved = 0')?.n ?? 0;
    } else {
      count = one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM p6_inbox i
           JOIN project_members pm ON pm.project_id = i.project_id AND pm.user_id = ?
          WHERE i.resolved = 0`,
        req.user.id as string,
      )?.n ?? 0;
    }

    sendJson(res, 200, { count });
  });

  // POST /api/inbox/:id/resolve
  router.post('/api/inbox/:id/resolve', (req: PortalRequest, res: PortalResponse): void => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const item = one<Row>('SELECT * FROM p6_inbox WHERE id = ?', req.params.id);
    if (!item) { sendJson(res, 404, { error: 'Inbox item not found' }); return; }

    if (item.resolved) {
      sendJson(res, 400, { error: 'This item was already resolved' });
      return;
    }

    // Check project membership
    if (!req.user.is_admin && item.project_id) {
      const member = one<Row>(
        'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
        item.project_id as string,
        req.user.id as string,
      );
      if (!member) { sendJson(res, 403, { error: 'Not a project member' }); return; }
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const response = body.response ?? null;

    // ── Approval-specific checks (mirrors the fingerprint/expiry/atomic-claim
    //    logic in crud.ts POST /runs/:rid/input so the two paths cannot drift).
    if (item.type === 'approval') {
      const clientHash = typeof body.inputHash === 'string' ? body.inputHash : null;
      const pl = safeJson(item.payload as string, {}) as Record<string, unknown>;
      const inputId = typeof pl.inputId === 'string' ? pl.inputId : null;
      const runId   = item.run_id ? String(item.run_id) : null;

      if (!inputId || !runId) {
        sendJson(res, 400, { error: 'Inbox item is missing inputId or runId' });
        return;
      }

      const inputRow = one<Row>('SELECT * FROM p6_inputs WHERE id = ? AND run_id = ?', inputId, runId);
      if (!inputRow) {
        sendJson(res, 409, { error: 'Nobody answered this in time, so the agent was told to carry on without it.' });
        return;
      }

      if (inputRow.status === 'expired') {
        sendJson(res, 409, { error: 'Nobody answered this in time, so the agent was told to carry on without it.' });
        return;
      }

      if (response === 'approve') {
        let storedHash = (inputRow.input_hash as string | null) ?? null;
        if (!storedHash) {
          try {
            const ipl = JSON.parse(inputRow.payload as string ?? '{}') as Record<string, unknown>;
            storedHash = typeof ipl.inputHash === 'string' ? ipl.inputHash : null;
          } catch { /* skip */ }
        }
        if (storedHash && clientHash !== storedHash) {
          sendJson(res, 409, { error: 'This is not the tool call you reviewed. Reload the page and review it again.' });
          return;
        }
      }

      const claimed = run(
        "UPDATE p6_inputs SET status = 'answered', response = ?, allow_all = 0, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
        JSON.stringify(response),
        req.user.id as string,
        now(),
        inputId,
      );
      if (!claimed.changes) {
        sendJson(res, 409, { error: 'Someone answered this a moment ago.' });
        return;
      }

      const decision: 'allow' | 'deny' = response === 'approve' ? 'allow' : 'deny';
      resolveApproval(runId, inputId, decision, { remember: false, message: '' });

      if (item.project_id) {
        emit(String(item.project_id), { type: 'input.resolved', inputId, status: 'answered' });
      }
    }

    run(
      'UPDATE p6_inbox SET resolved = 1, resolved_by = ?, resolved_at = ? WHERE id = ?',
      req.user.id as string,
      now(),
      req.params.id,
    );

    if (item.project_id) {
      emit(String(item.project_id), {
        type: 'inbox.resolved',
        inboxId: item.id,
        resolvedBy: req.user.id,
        response,
      });
    }

    sendJson(res, 200, { ok: true });
  });
}
