/**
 * Inbox management — approval requests, questions, push notifications, blocked sessions.
 *
 * Routes:
 *   GET  /api/inbox            — list unresolved items for the current user
 *   GET  /api/inbox/count      — { count } unresolved items (for nav badge)
 *   POST /api/inbox/:id/resolve — resolve (approve/dismiss) an inbox item
 *
 * All data access goes through InboxRepository and ProjectRepository.
 */

import { router, sendJson } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { generateId, now } from './util.ts';
import { emit } from './events.ts';
import { resolveApproval } from './agent/approvals.ts';
import { getInboxRepository } from './repositories/inbox.ts';
import { getProjectRepository } from './repositories/projects.ts';
import type { InboxRecord } from './repositories/inbox.ts';

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
 * Returns the created record id.
 */
export async function createInboxItem(opts: InboxItemCreate): Promise<string> {
  const id = generateId();
  const repo = getInboxRepository();
  await repo.create({
    id,
    project_id: opts.projectId ?? null,
    workflow_id: opts.workflowId ?? null,
    run_id: opts.runId ?? null,
    type: opts.type,
    payload: JSON.stringify(opts.payload),
    created_at: now(),
  });
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

// ── Stale approvals ───────────────────────────────────────────────────────────

/**
 * An approval can be answered in the session, expire, or be cancelled with the run, and none of those paths knows the
 * inbox item. Check each listed approval against its input record; the ones that are no longer waiting are closed here
 * so they stop showing buttons that can only fail.
 */
async function dropStaleApprovals(items: InboxRecord[]): Promise<InboxRecord[]> {
  const approvals = items.filter((i) => i.type === 'approval');
  if (approvals.length === 0) return items;
  const { getSessionsRepository } = await import('./repositories/sessions.ts');
  const sessRepo = getSessionsRepository();
  const inboxRepo = getInboxRepository();
  const stale = new Set<string>();
  await Promise.all(approvals.map(async (item) => {
    try {
      const pl = safeJson(item.payload, {}) as Record<string, unknown>;
      const inputId = typeof pl.inputId === 'string' ? pl.inputId : null;
      const runId = item.run_id ? String(item.run_id) : null;
      if (!inputId || !runId) return;
      const row = await sessRepo.getInputByRunAndId(runId, inputId);
      if (row && row.status === 'pending') return;
      stale.add(item.id);
      await inboxRepo.resolveConditional(item.id, 'system', now());
    } catch { /* leave it listed; the next load tries again */ }
  }));
  return stale.size ? items.filter((i) => !stale.has(i.id)) : items;
}

async function withoutStale(count: number, load: () => Promise<{ items: InboxRecord[] }>): Promise<number> {
  if (count === 0) return 0;
  try {
    const { items } = await load();
    const live = await dropStaleApprovals(items);
    return Math.max(0, count - (items.length - live.length));
  } catch { return count; }
}

// ── View helper ───────────────────────────────────────────────────────────────

function inboxView(
  item: InboxRecord,
  projectName?: string | null,
  workflowGoal?: string | null,
): Record<string, unknown> {
  return {
    id: item.id,
    project_id: item.project_id,
    project_name: projectName ?? null,
    workflow_id: item.workflow_id,
    workflow_goal: workflowGoal ?? null,
    run_id: item.run_id,
    type: item.type,
    payload: safeJson(item.payload, {}),
    resolved: Boolean(item.resolved),
    resolved_by: item.resolved_by ?? null,
    resolved_at: item.resolved_at ?? null,
    created_at: item.created_at,
    elapsed_ms: Date.now() - new Date(item.created_at).getTime(),
  };
}

function safeJson(s: string | null | undefined, fallback: unknown): unknown {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── Enrich helper ──────────────────────────────────────────────────────────────

async function enrichItems(items: InboxRecord[]): Promise<Array<Record<string, unknown>>> {
  const sessionRepo = getInboxRepository();
  void sessionRepo; // suppress if unused
  // Collect unique project/workflow IDs
  const projectIds = [...new Set(items.map((i) => i.project_id).filter(Boolean) as string[])];
  const workflowIds = [...new Set(items.map((i) => i.workflow_id).filter(Boolean) as string[])];

  // Load project names in batch using the projects repository
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    const projRepo = getProjectRepository();
    await Promise.all(
      projectIds.map(async (pid) => {
        const p = await projRepo.getProjectById(pid);
        if (p) projectNames.set(pid, p.name);
      }),
    );
  }

  // Load workflow goals using the sessions repository
  const workflowGoals = new Map<string, string>();
  if (workflowIds.length > 0) {
    const { getSessionsRepository } = await import('./repositories/sessions.ts');
    const sessRepo = getSessionsRepository();
    await Promise.all(
      workflowIds.map(async (wid) => {
        const wf = await sessRepo.getWorkflowById(wid);
        if (wf) workflowGoals.set(wid, wf.goal);
      }),
    );
  }

  return items.map((item) =>
    inboxView(
      item,
      item.project_id ? projectNames.get(item.project_id) ?? null : null,
      item.workflow_id ? workflowGoals.get(item.workflow_id) ?? null : null,
    ),
  );
}

// ── Route registration ─────────────────────────────────────────────────────────

export function registerInboxRoutes(): void {

  // GET /api/inbox
  router.get('/api/inbox', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const limit = Math.min(Number(req.query.get('limit') ?? 100), 200);
    const offset = Number(req.query.get('offset') ?? 0);
    const inboxRepo = getInboxRepository();

    let result: { items: InboxRecord[]; total: number };
    if (req.user.is_admin) {
      result = await inboxRepo.listAllUnresolved({ limit, offset });
    } else {
      // Use projects repository to get the user's project IDs
      const projRepo = getProjectRepository();
      const myProjects = await projRepo.listMyProjects(String(req.user.id));
      const projectIds = myProjects.map((p) => p.id);
      result = await inboxRepo.listUnresolvedByProjects(projectIds, { limit, offset });
    }

    const live = await dropStaleApprovals(result.items);
    const enriched = await enrichItems(live);
    sendJson(res, 200, { items: enriched, total: Math.max(0, result.total - (result.items.length - live.length)) });
  });

  // GET /api/inbox/count
  router.get('/api/inbox/count', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const inboxRepo = getInboxRepository();
    let count: number;
    if (req.user.is_admin) {
      count = await inboxRepo.countAllUnresolved();
      count = await withoutStale(count, () => inboxRepo.listAllUnresolved({ limit: 200, offset: 0 }));
    } else {
      const projRepo = getProjectRepository();
      const myProjects = await projRepo.listMyProjects(String(req.user.id));
      const projectIds = myProjects.map((p) => p.id);
      count = await inboxRepo.countUnresolvedByProjects(projectIds);
      count = await withoutStale(count, () => inboxRepo.listUnresolvedByProjects(projectIds, { limit: 200, offset: 0 }));
    }

    sendJson(res, 200, { count });
  });

  // POST /api/inbox/:id/resolve
  router.post('/api/inbox/:id/resolve', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!req.user) { sendJson(res, 401, { error: 'Sign in to continue' }); return; }

    const inboxRepo = getInboxRepository();
    const item = await inboxRepo.getById(req.params.id);
    if (!item) { sendJson(res, 404, { error: 'Inbox item not found' }); return; }

    if (item.resolved) {
      sendJson(res, 400, { error: 'This item was already resolved' });
      return;
    }

    // Check project membership
    if (!req.user.is_admin && item.project_id) {
      const projRepo = getProjectRepository();
      const isMember = await projRepo.isMember(item.project_id, String(req.user.id));
      if (!isMember) { sendJson(res, 403, { error: 'Not a project member' }); return; }
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const response = body.response ?? null;

    // ── Approval-specific checks
    if (item.type === 'push' && response === 'approve' && req.authViaToken) {
      sendJson(res, 403, { error: 'API tokens cannot approve a push. Approve it from a signed-in browser, or decline it.' });
      return;
    }
    if (item.type === 'approval' && response === 'approve' && req.authViaToken) {
      sendJson(res, 403, { error: 'API tokens cannot approve tool calls. Approve it from a signed-in browser, or decline it.' });
      return;
    }
    if (item.type === 'approval') {
      const clientHash = typeof body.inputHash === 'string' ? body.inputHash : null;
      const pl = safeJson(item.payload, {}) as Record<string, unknown>;
      const inputId = typeof pl.inputId === 'string' ? pl.inputId : null;
      const runId = item.run_id ? String(item.run_id) : null;

      if (!inputId || !runId) {
        sendJson(res, 400, { error: 'Inbox item is missing inputId or runId' });
        return;
      }

      const { getSessionsRepository } = await import('./repositories/sessions.ts');
      const sessRepo = getSessionsRepository();
      const inputRow = await sessRepo.getInputByRunAndId(runId, inputId);
      if (!inputRow || inputRow.status === 'expired') {
        await inboxRepo.resolveConditional(req.params.id, 'system', now()).catch(() => false);
        sendJson(res, 409, { error: 'Nobody answered this in time, so the agent was told to carry on without it.' });
        return;
      }
      if (inputRow.status !== 'pending') {
        await inboxRepo.resolveConditional(req.params.id, 'system', now()).catch(() => false);
        sendJson(res, 409, { error: 'This was already answered.' });
        return;
      }

      if (response === 'approve') {
        let storedHash = inputRow.input_hash ?? null;
        if (!storedHash) {
          try {
            const ipl = JSON.parse(inputRow.payload ?? '{}') as Record<string, unknown>;
            storedHash = typeof ipl.inputHash === 'string' ? ipl.inputHash : null;
          } catch { /* skip */ }
        }
        if (storedHash && clientHash !== storedHash) {
          sendJson(res, 409, { error: 'This is not the tool call you reviewed. Reload the page and review it again.' });
          return;
        }
      }

      const claimed = await sessRepo.updateInputConditional(inputId, 'pending', {
        status: 'answered',
        response: JSON.stringify(response),
        allow_all: 0,
        answered_by: String(req.user.id),
        answered_at: now(),
      });
      if (!claimed) {
        sendJson(res, 409, { error: 'Someone answered this a moment ago.' });
        return;
      }

      const decision: 'allow' | 'deny' = response === 'approve' ? 'allow' : 'deny';
      resolveApproval(runId, inputId, decision, { remember: false, message: '' });

      if (item.project_id) {
        emit(item.project_id, { type: 'input.resolved', inputId, status: 'answered' });
      }
    }

    // Atomic resolve (race-safe — only one winner)
    const resolved = await inboxRepo.resolveConditional(
      req.params.id,
      String(req.user.id),
      now(),
    );
    if (!resolved) {
      sendJson(res, 409, { error: 'Someone resolved this a moment ago.' });
      return;
    }

    // A "push" question: approving opens the pull request (in the background), declining records it on the session.
    if (item.type === 'push') {
      const pl = safeJson(item.payload, {}) as Record<string, unknown>;
      const wid = item.workflow_id ? String(item.workflow_id) : '';
      const rid = typeof pl.repoId === 'string' ? pl.repoId : '';
      if (wid && rid) {
        const sp = await import('./session-pr.ts');
        if (response === 'approve') {
          void sp.createPullRequestForSession(wid, rid, { approvedBy: String(req.user.id) })
            .catch((e: unknown) => console.error('[session-pr] approved pull request failed:', e));
        } else {
          await sp.declinePullRequestForSession(wid, rid).catch(() => undefined);
        }
      }
    }

    if (item.project_id) {
      emit(item.project_id, {
        type: 'inbox.resolved',
        inboxId: item.id,
        resolvedBy: req.user.id,
        response,
      });
    }

    sendJson(res, 200, { ok: true });
  });
}
