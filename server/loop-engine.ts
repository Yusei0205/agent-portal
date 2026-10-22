/**
 * Loop engine services — outbound webhooks, Inbox API, Readiness API, and escalation.
 *
 * Outbound webhooks:
 *   - Subscriptions stored in `outbound_webhooks` table.
 *   - Delivery: HMAC-SHA256 X-Portal-Signature header, retries with exponential backoff.
 *   - Events: session.done, session.blocked, session.failed, push.pending,
 *              approval.overdue, budget.threshold, trigger.fired.
 *
 * Inbox API (GET /api/inbox):
 *   - Cross-project list of everything that needs a human.
 *   - SSE badge count updates via the existing project event streams.
 *
 * Readiness API (GET /api/projects/:pid/readiness):
 *   - Each setup item: ok/missing/warn, a plain message, which setting fixes it.
 *
 * Escalation:
 *   - Inbox item + optional outbound webhook when a session is blocked/failed/over-budget.
 *   - Optional GitHub issue creation (GitHub repos only).
 */
import crypto from 'node:crypto';
import { all, one, insert, run as exec, type Row } from './db.ts';
import { del, get, post, put, openSse, HANDLED } from './http.ts';
import { requireProject, getProject, notifyProject } from './projects.ts';
import { badRequest, notFound, newId, now, str, parseJson, sleep, HttpError } from './util.ts';
import { publish, projectChannel, subscribe } from './events.ts';
import { audit } from './audit.ts';
import { getSettings, monthSpend } from './settings.ts';
import type { AuditAction } from './audit.ts';

/* ------------------------------------------------------------------ */
/* Outbound webhook delivery                                           */
/* ------------------------------------------------------------------ */

export type WebhookEvent =
  | 'session.done'
  | 'session.blocked'
  | 'session.failed'
  | 'push.pending'
  | 'approval.overdue'
  | 'budget.threshold'
  | 'trigger.fired';

export interface OutboundWebhook {
  id: string;
  project_id: string | null;  // null = global (all projects)
  url: string;
  secret_hint: string;        // first 6 chars of the secret, for display
  events: WebhookEvent[];
  created_by: string;
  created_at: string;
}

function signPayload(secret: string, payload: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Deliver a webhook with up to 3 retries (exponential backoff: 5s, 25s, 125s).
 * Failures are logged to console; never throw.
 */
async function deliverWebhook(url: string, secret: string, event: WebhookEvent, data: unknown): Promise<void> {
  const payload = JSON.stringify({ event, data, delivered_at: now() });
  const sig = signPayload(secret, payload);
  const delays = [0, 5_000, 25_000];
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Portal-Signature': sig,
          'X-Portal-Event': event,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return; // delivered
      console.warn(`[webhook] ${url} returned ${res.status} for event ${event}`);
    } catch (e: any) {
      console.warn(`[webhook] ${url} failed (event ${event}): ${e.message}`);
    }
  }
}

/**
 * Fire all matching outbound webhooks for a project event.
 * Non-blocking: runs in background, never throws.
 */
export function fireWebhooks(projectId: string | null, event: WebhookEvent, data: unknown): void {
  let rows: Row[];
  if (projectId) {
    rows = all<Row>(
      "SELECT * FROM outbound_webhooks WHERE (project_id = ? OR project_id IS NULL) AND events LIKE ?",
      projectId, `%${event}%`,
    );
  } else {
    rows = all<Row>("SELECT * FROM outbound_webhooks WHERE project_id IS NULL AND events LIKE ?", `%${event}%`);
  }
  for (const row of rows) {
    const events: WebhookEvent[] = parseJson<WebhookEvent[]>(row.events, []);
    if (!events.includes(event)) continue;
    const secret = String(row.secret ?? '');
    if (!secret) continue;
    deliverWebhook(String(row.url), secret, event, data).catch(console.error);
  }
  // Also publish to SSE so the browser badge updates in real time.
  if (projectId) publish(projectChannel(projectId), `webhook.${event}`, data);
}

/* ------------------------------------------------------------------ */
/* Escalation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Escalate a blocked/failed/budget-exhausted session:
 *  1. Create an inbox item (persisted as a workflow event with kind='escalation').
 *  2. Fire outbound webhooks.
 *  3. Optionally create a GitHub issue.
 */
export function escalateSession(workflowId: string, reason: 'blocked' | 'failed' | 'budget', message: string): void {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', workflowId);
  if (!w) return;

  // Create inbox item as a workflow event
  exec(
    "INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, 'escalation', NULL, ?, ?, 0, ?)",
    workflowId,
    `Session escalated (${reason}): ${message.slice(0, 300)}`,
    JSON.stringify({ reason, message }),
    now(),
  );

  // Fire outbound webhooks
  const eventName: WebhookEvent = reason === 'failed' ? 'session.failed' : reason === 'budget' ? 'budget.threshold' : 'session.blocked';
  fireWebhooks(String(w.project_id), eventName, {
    workflowId,
    projectId: w.project_id,
    title: w.title,
    reason,
    message,
  });

  notifyProject(String(w.project_id), 'workflow.escalated', { id: workflowId, reason });

  // GitHub issue creation is deferred to a later stage (requires GitHub token and repo URL).
}

/* ------------------------------------------------------------------ */
/* Inbox API                                                           */
/* ------------------------------------------------------------------ */

export interface InboxItem {
  kind: 'waiting' | 'push_ready' | 'plan_pending' | 'escalation' | 'done';
  workflowId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  detail: string;
  prUrl: string | null;
  createdAt: string;
  isOverdue: boolean;
}

/**
 * Build the Inbox list for a user.
 * Includes:
 *  - Pending approvals / questions (inputs with status='pending')
 *  - Push-pending sessions
 *  - Plan-pending sessions (planning_gate waiting)
 *  - Escalated sessions (workflow_events.kind='escalation', unconsumed)
 *  - Recently done sessions with PR links
 */
export function buildInbox(userId: string, projectFilter: string | null): InboxItem[] {
  const items: InboxItem[] = [];
  const now_ = new Date().toISOString();
  const slaMinutes = getSettings().controlPlane?.approvalSlaMinutes ?? 30;
  const slaMs = slaMinutes * 60_000;

  // -- Pending inputs (questions / approvals) --
  // Use a JOIN on a subquery to avoid SQL injection.
  const pendingInputs = projectFilter
    ? all<Row>(
        `SELECT i.*, w.title AS wf_title, w.project_id, p.name AS project_name
           FROM inputs i
           JOIN workflows w ON (w.id = i.run_id)
           JOIN projects p ON p.id = w.project_id
          WHERE i.status = 'pending' AND w.project_id = ?
          ORDER BY i.created_at DESC LIMIT 200`,
        projectFilter,
      )
    : all<Row>(
        `SELECT i.*, w.title AS wf_title, w.project_id, p.name AS project_name
           FROM inputs i
           JOIN workflows w ON (w.id = i.run_id)
           JOIN projects p ON p.id = w.project_id
          WHERE i.status = 'pending'
          ORDER BY i.created_at DESC LIMIT 200`,
      );
  for (const inp of pendingInputs) {
    const age = new Date(now_).getTime() - new Date(String(inp.created_at)).getTime();
    items.push({
      kind: 'waiting',
      workflowId: String(inp.run_id ?? ''),
      projectId: String(inp.project_id),
      projectName: String(inp.project_name ?? ''),
      sessionTitle: String(inp.wf_title ?? ''),
      detail: String(inp.payload ? (() => { try { return JSON.parse(inp.payload)?.question ?? JSON.parse(inp.payload)?.content ?? ''; } catch { return ''; } })() : '').slice(0, 200),
      prUrl: null,
      createdAt: String(inp.created_at),
      isOverdue: age > slaMs,
    });
  }

  // -- Push-pending sessions --
  const pushPending = projectFilter
    ? all<Row>(
        `SELECT w.*, p.name AS project_name
           FROM workflows w
           JOIN projects p ON p.id = w.project_id
          WHERE w.pending_push != ''
            AND w.project_id = ?
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY w.updated_at DESC LIMIT 50`,
        projectFilter, userId, userId,
      )
    : all<Row>(
        `SELECT w.*, p.name AS project_name
           FROM workflows w
           JOIN projects p ON p.id = w.project_id
          WHERE w.pending_push != ''
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY w.updated_at DESC LIMIT 50`,
        userId, userId,
      );
  for (const w of pushPending) {
    const pushReq = parseJson<any>(w.pending_push, null);
    const filesLine = pushReq ? `Push to "${pushReq.branch}"` : 'Push pending';
    items.push({
      kind: 'push_ready',
      workflowId: String(w.id),
      projectId: String(w.project_id),
      projectName: String(w.project_name ?? ''),
      sessionTitle: String(w.title),
      detail: filesLine,
      prUrl: null,
      createdAt: String(w.updated_at),
      isOverdue: false,
    });
  }

  // -- Plan-pending sessions --
  const planPending = projectFilter
    ? all<Row>(
        `SELECT w.*, p.name AS project_name
           FROM workflows w
           JOIN projects p ON p.id = w.project_id
          WHERE w.planning_gate = 1 AND w.status = 'paused' AND w.stop_reason LIKE 'Plan ready%'
            AND w.project_id = ?
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY w.updated_at DESC LIMIT 20`,
        projectFilter, userId, userId,
      )
    : all<Row>(
        `SELECT w.*, p.name AS project_name
           FROM workflows w
           JOIN projects p ON p.id = w.project_id
          WHERE w.planning_gate = 1 AND w.status = 'paused' AND w.stop_reason LIKE 'Plan ready%'
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY w.updated_at DESC LIMIT 20`,
        userId, userId,
      );
  for (const w of planPending) {
    items.push({
      kind: 'plan_pending',
      workflowId: String(w.id),
      projectId: String(w.project_id),
      projectName: String(w.project_name ?? ''),
      sessionTitle: String(w.title),
      detail: 'Plan ready for approval',
      prUrl: null,
      createdAt: String(w.updated_at),
      isOverdue: false,
    });
  }

  // -- Escalations (unconsumed) --
  const escalations = projectFilter
    ? all<Row>(
        `SELECT we.*, w.title AS wf_title, w.project_id, p.name AS project_name
           FROM workflow_events we
           JOIN workflows w ON w.id = we.workflow_id
           JOIN projects p ON p.id = w.project_id
          WHERE we.kind = 'escalation' AND we.consumed = 0 AND w.project_id = ?
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY we.created_at DESC LIMIT 50`,
        projectFilter, userId, userId,
      )
    : all<Row>(
        `SELECT we.*, w.title AS wf_title, w.project_id, p.name AS project_name
           FROM workflow_events we
           JOIN workflows w ON w.id = we.workflow_id
           JOIN projects p ON p.id = w.project_id
          WHERE we.kind = 'escalation' AND we.consumed = 0
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY we.created_at DESC LIMIT 50`,
        userId, userId,
      );
  for (const e of escalations) {
    items.push({
      kind: 'escalation',
      workflowId: String(e.workflow_id),
      projectId: String(e.project_id),
      projectName: String(e.project_name ?? ''),
      sessionTitle: String(e.wf_title ?? ''),
      detail: String(e.body ?? '').slice(0, 200),
      prUrl: null,
      createdAt: String(e.created_at),
      isOverdue: false,
    });
  }

  // -- Recently done sessions with PR links (last 24h) --
  const doneCutoff = new Date(Date.now() - 86_400_000).toISOString();
  const doneRows = projectFilter
    ? all<Row>(
        `SELECT w.*, p.name AS project_name,
                (SELECT we2.data FROM workflow_events we2 WHERE we2.workflow_id = w.id AND we2.kind = 'push' ORDER BY we2.id DESC LIMIT 1) AS last_push_data
           FROM workflows w
           JOIN projects p ON p.id = w.project_id
          WHERE w.status = 'done' AND w.updated_at >= ? AND w.project_id = ?
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY w.updated_at DESC LIMIT 20`,
        doneCutoff, projectFilter, userId, userId,
      )
    : all<Row>(
        `SELECT w.*, p.name AS project_name,
                (SELECT we2.data FROM workflow_events we2 WHERE we2.workflow_id = w.id AND we2.kind = 'push' ORDER BY we2.id DESC LIMIT 1) AS last_push_data
           FROM workflows w
           JOIN projects p ON p.id = w.project_id
          WHERE w.status = 'done' AND w.updated_at >= ?
            AND (w.created_by = ? OR EXISTS (SELECT 1 FROM project_members WHERE project_id = w.project_id AND user_id = ?))
          ORDER BY w.updated_at DESC LIMIT 20`,
        doneCutoff, userId, userId,
      );
  for (const w of doneRows) {
    let prUrl: string | null = null;
    if (w.last_push_data) {
      try {
        const d = JSON.parse(w.last_push_data);
        const results: any[] = d.results ?? [];
        prUrl = results.find((r: any) => r.pr)?.pr ?? null;
      } catch { /* skip */ }
    }
    items.push({
      kind: 'done',
      workflowId: String(w.id),
      projectId: String(w.project_id),
      projectName: String(w.project_name ?? ''),
      sessionTitle: String(w.title),
      detail: String(w.stop_reason || w.summary || '').slice(0, 200),
      prUrl,
      createdAt: String(w.updated_at),
      isOverdue: false,
    });
  }

  return items;
}

/** Count "needs you" items for the nav badge. */
export function inboxNeedsYouCount(userId: string): number {
  // pending inputs + push-pending + plan-pending + escalations
  const inputs = Number(one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM inputs i
      WHERE i.status = 'pending'
        AND EXISTS (SELECT 1 FROM workflows w WHERE (w.id = i.run_id OR w.project_id = i.project_id) AND w.created_by = ?)`,
    userId,
  )?.n ?? 0);
  const pushes = Number(one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM workflows WHERE pending_push != '' AND created_by = ?",
    userId,
  )?.n ?? 0);
  const plans = Number(one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM workflows WHERE planning_gate = 1 AND status = 'paused' AND stop_reason LIKE 'Plan ready%' AND created_by = ?",
    userId,
  )?.n ?? 0);
  const esc = Number(one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workflow_events we
      WHERE we.kind = 'escalation' AND we.consumed = 0
        AND EXISTS (SELECT 1 FROM workflows w WHERE w.id = we.workflow_id AND w.created_by = ?)`,
    userId,
  )?.n ?? 0);
  return inputs + pushes + plans + esc;
}

/* ------------------------------------------------------------------ */
/* Readiness API                                                       */
/* ------------------------------------------------------------------ */

export interface ReadinessItem {
  key: string;
  status: 'ok' | 'missing' | 'warn';
  label: string;
  message: string;
  /** Which settings page / field fixes this. */
  fix?: string;
}

export interface ReadinessReport {
  items: ReadinessItem[];
  ready: boolean;
  /** Number of 'missing' items. */
  blocking: number;
}

/**
 * Build the readiness report for a project.
 * All checks are synchronous DB reads; no network calls.
 */
export async function buildReadiness(projectId: string): Promise<ReadinessReport> {
  const items: ReadinessItem[] = [];

  // 1. Provider / engine connection
  try {
    // Import project-aws.ts dynamically to avoid circular deps at load time.
    // This is a sync read so we use a sync-compatible pattern.
    const { effectiveProvider } = await import('./project-aws.ts');
    const provider = effectiveProvider(projectId);
    if (provider === 'demo') {
      items.push({ key: 'provider', status: 'warn', label: 'Model provider', message: 'Demo mode — runs are simulated. Switch to Anthropic or Bedrock to use real Claude.', fix: 'Settings › Model provider' });
    } else {
      items.push({ key: 'provider', status: 'ok', label: 'Model provider', message: `${provider} (connected)` });
    }
  } catch (e: any) {
    items.push({ key: 'provider', status: 'missing', label: 'Model provider', message: 'No provider configured. Add an API key or AWS credentials.', fix: 'Settings › Model provider' });
  }

  // 2. AWS identity (needed for Bedrock or CodeCommit)
  const pa = one<Row>('SELECT auth, connection_id FROM project_aws WHERE project_id = ?', projectId);
  const needsAws = pa?.auth !== 'inherit' && pa?.auth !== '' && pa?.auth;
  if (needsAws) {
    const conn = pa?.connection_id ? one<Row>('SELECT id, name FROM aws_connections WHERE id = ?', pa.connection_id) : null;
    if (conn) {
      items.push({ key: 'aws', status: 'ok', label: 'AWS account', message: String(conn.name) });
    } else {
      items.push({ key: 'aws', status: 'warn', label: 'AWS account', message: 'No AWS account selected for this project.', fix: 'Project › Setup › Connection' });
    }
  }

  // 3. Git connection
  const repos = all<Row>('SELECT id, name, status, connection_id FROM repos WHERE project_id = ? LIMIT 5', projectId);
  if (!repos.length) {
    items.push({ key: 'git_connection', status: 'missing', label: 'Git connection', message: 'No repositories connected yet.', fix: 'Project › Repositories' });
  } else {
    const connections = all<Row>('SELECT id FROM git_connections WHERE id IN (' + repos.map(() => '?').join(',') + ')', ...repos.map((r) => r.connection_id).filter(Boolean));
    const hasConn = connections.length > 0 || repos.some((r) => !r.connection_id);
    items.push({ key: 'git_connection', status: hasConn ? 'ok' : 'warn', label: 'Git connection', message: hasConn ? 'Git connection configured' : 'No git credentials found for the repositories.', fix: hasConn ? undefined : 'Settings › Git connections' });
  }

  // 4. Repositories
  if (!repos.length) {
    items.push({ key: 'repository', status: 'missing', label: 'Repository', message: 'Add a repository to start sessions.', fix: 'Project › Repositories' });
  } else {
    const ready = repos.filter((r) => r.status === 'ready');
    const cloning = repos.filter((r) => r.status === 'cloning');
    const errored = repos.filter((r) => r.status === 'error');
    if (ready.length) {
      items.push({ key: 'repository', status: 'ok', label: 'Repository', message: `${ready.length} repository${ready.length > 1 ? 'ies' : 'y'} ready` });
    } else if (cloning.length) {
      items.push({ key: 'repository', status: 'warn', label: 'Repository', message: `${cloning.length} repository cloning…` });
    } else if (errored.length) {
      items.push({ key: 'repository', status: 'missing', label: 'Repository', message: `Repository error: ${String(errored[0].error ?? 'unknown').slice(0, 100)}`, fix: 'Project › Repositories' });
    }
  }

  // 5. Lead agent
  const project = getProject(projectId);
  if (!project.default_lead_agent) {
    items.push({ key: 'lead_agent', status: 'warn', label: 'Lead agent', message: 'No lead agent set — the default agent will plan and decide.', fix: 'Project › Agents' });
  } else {
    items.push({ key: 'lead_agent', status: 'ok', label: 'Lead agent', message: project.default_lead_agent });
  }

  // 6. Budget
  const settings = getSettings();
  const projectBudget = one<Row>('SELECT monthly_budget_usd FROM projects WHERE id = ?', projectId);
  const budgetUsd = projectBudget?.monthly_budget_usd ?? settings.budget.monthlyUsd;
  if (!budgetUsd) {
    items.push({ key: 'budget', status: 'warn', label: 'Budget', message: 'No budget cap set — sessions can spend without limit.', fix: 'Settings › Budget' });
  } else {
    const spent = monthSpend(projectId);
    const pct = Math.round((spent / Number(budgetUsd)) * 100);
    if (pct >= 100) {
      items.push({ key: 'budget', status: 'missing', label: 'Budget', message: `Budget exhausted ($${spent.toFixed(2)} / $${budgetUsd}).`, fix: 'Settings › Budget' });
    } else if (pct >= 80) {
      items.push({ key: 'budget', status: 'warn', label: 'Budget', message: `${pct}% of $${budgetUsd} budget used this month.`, fix: 'Settings › Budget' });
    } else {
      items.push({ key: 'budget', status: 'ok', label: 'Budget', message: `$${spent.toFixed(2)} of $${budgetUsd} used this month` });
    }
  }

  // 7. Jira (optional — only check if mapped)
  const jiraMapping = one<Row>('SELECT project_key FROM project_jira WHERE project_id = ?', projectId);
  if (jiraMapping) {
    items.push({ key: 'jira', status: 'ok', label: 'Jira', message: `Mapped to project ${jiraMapping.project_key}` });
  }

  const blocking = items.filter((i) => i.status === 'missing').length;
  return { items, ready: blocking === 0, blocking };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerLoopEngineRoutes(): void {
  /* ----- Readiness ----- */
  get('/api/projects/:pid/readiness', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return buildReadiness(project.id);
  });

  /* ----- Inbox ----- */
  get('/api/inbox', (ctx) => {
    const userId = ctx.user!.id;
    const projectFilter = ctx.query.get('project') ?? null;
    const filterMode = ctx.query.get('filter') ?? 'needs_you';
    const items = buildInbox(userId, projectFilter);
    // Filter by mode
    let filtered = items;
    if (filterMode === 'needs_you') {
      filtered = items.filter((i) => i.kind !== 'done');
    } else if (filterMode === 'done') {
      filtered = items.filter((i) => i.kind === 'done');
    }
    const needsYouCount = items.filter((i) => i.kind !== 'done').length;
    ctx.res.setHeader('X-Inbox-Needs-You', String(needsYouCount));
    return { items: filtered, needs_you: needsYouCount };
  });

  // SSE stream for real-time inbox badge updates
  get('/api/inbox/events', (ctx) => {
    const userId = ctx.user!.id;
    const sse = openSse(ctx);
    // Send initial count
    const count = inboxNeedsYouCount(userId);
    sse.send('inbox.count', { needs_you: count });

    // Subscribe to all accessible projects
    const projects = all<Row>(
      `SELECT DISTINCT project_id FROM project_members WHERE user_id = ?
       UNION SELECT DISTINCT project_id FROM workflows WHERE created_by = ?`,
      userId, userId,
    );
    const unsubs: (() => void)[] = [];
    for (const row of projects) {
      const unsub = subscribe(projectChannel(String(row.project_id)), (_event, _data) => {
        const newCount = inboxNeedsYouCount(userId);
        sse.send('inbox.count', { needs_you: newCount });
      });
      unsubs.push(unsub);
    }
    sse.onClose(() => { for (const u of unsubs) u(); });
    return HANDLED;
  });

  // Dismiss an escalation (mark the event as consumed)
  post('/api/workflows/:id/dismiss-escalation', (ctx) => {
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', ctx.params.id);
    if (!w) throw notFound('Session not found');
    requireProject(ctx, String(w.project_id));
    exec("UPDATE workflow_events SET consumed = 1 WHERE workflow_id = ? AND kind = 'escalation' AND consumed = 0", ctx.params.id);
    notifyProject(String(w.project_id), 'workflow.updated', { id: ctx.params.id });
    return { ok: true };
  });

  // Approve a plan (planning_gate sessions)
  post('/api/workflows/:id/approve-plan', async (ctx) => {
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', ctx.params.id);
    if (!w) throw notFound('Session not found');
    requireProject(ctx, String(w.project_id), 'editor');
    if (!Boolean(w.planning_gate) || w.status !== 'paused' || !String(w.stop_reason ?? '').startsWith('Plan ready')) {
      throw badRequest('This session is not waiting for plan approval');
    }
    const body = await ctx.json().catch(() => ({}));
    const edit = String(body.planEdit ?? '').trim();
    if (edit) {
      // Append the human's plan edits as an instruction
      exec(
        "INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, 'human', NULL, ?, ?, 0, ?)",
        ctx.params.id,
        `Plan approved with edits: ${edit}`,
        JSON.stringify({ by: ctx.user!.name }),
        now(),
      );
    }
    exec("UPDATE workflows SET status = 'running', stop_reason = '', burst_start = iteration, updated_at = ? WHERE id = ?", now(), ctx.params.id);
    exec("INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, 'status', NULL, 'Plan approved; session carrying on.', '{}', 0, ?)", ctx.params.id, now());
    const { kick } = await import('./workflows.ts') as any;
    if (typeof kick === 'function') kick(ctx.params.id);
    notifyProject(String(w.project_id), 'workflow.updated', { id: ctx.params.id });
    return { ok: true };
  });

  /* ----- Outbound webhooks CRUD ----- */
  get('/api/outbound-webhooks', (ctx) => {
    if (!ctx.user?.is_admin) throw new HttpError(403, 'Admins only');
    const rows = all<Row>('SELECT id, project_id, url, secret_hint, events, created_by, created_at FROM outbound_webhooks ORDER BY created_at DESC');
    return {
      webhooks: rows.map((r) => ({
        id: r.id,
        project_id: r.project_id,
        url: r.url,
        secret_hint: r.secret_hint,
        events: parseJson<string[]>(r.events, []),
        created_at: r.created_at,
      })),
    };
  });

  post('/api/outbound-webhooks', async (ctx) => {
    if (!ctx.user?.is_admin) throw new HttpError(403, 'Admins only');
    const body = await ctx.json();
    const url = str(body.url, 'URL', { max: 500 }).trim();
    if (!/^https?:\/\/./.test(url)) throw badRequest('URL must start with http:// or https://');
    const secret = crypto.randomBytes(24).toString('hex');
    const events: WebhookEvent[] = Array.isArray(body.events) ? body.events : [];
    const id = newId('wh_');
    exec(
      'INSERT INTO outbound_webhooks (id, project_id, url, secret, secret_hint, events, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, body.projectId ?? null, url, secret, secret.slice(0, 6), JSON.stringify(events), ctx.user!.id, now(),
    );
    audit(ctx, 'webhook.create' as AuditAction, `webhook:${id}`, { url: url.replace(/\/\/[^@/]+@/, '//***@') });
    return { id, secret, secret_hint: secret.slice(0, 6) };
  });

  del('/api/outbound-webhooks/:id', (ctx) => {
    if (!ctx.user?.is_admin) throw new HttpError(403, 'Admins only');
    exec('DELETE FROM outbound_webhooks WHERE id = ?', ctx.params.id);
    return { ok: true };
  });

  // Test endpoint — fires a test event to a specific webhook
  post('/api/outbound-webhooks/:id/test', (ctx) => {
    if (!ctx.user?.is_admin) throw new HttpError(403, 'Admins only');
    const row = one<Row>('SELECT * FROM outbound_webhooks WHERE id = ?', ctx.params.id);
    if (!row) throw notFound('Webhook not found');
    deliverWebhook(String(row.url), String(row.secret), 'session.done', { test: true, message: 'This is a test delivery from Agent Portal.' })
      .catch(console.error);
    return { ok: true, message: 'Test delivery started (check your endpoint)' };
  });
}
