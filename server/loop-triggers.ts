/**
 * Loop triggers — fire loop specs automatically.
 *
 * Supported trigger kinds:
 *  - manual:       a person or the API presses "Run now".
 *  - cron:         a mini 5-field cron expression; evaluated every minute by this module.
 *  - interval:     every N minutes.
 *  - webhook:      a generic inbound POST whose body is injected as template variables.
 *  - github_event: pull_request or workflow_run/check_suite failures, HMAC-verified.
 *  - jira_event:   poll Jira via existing server/jira.ts helpers; status change or JQL match.
 *
 * Dedup: the same (spec_id, dedup_key) fires at most once per hour.
 * Rate limit: default 3 firings per spec per hour, configurable in trigger_config.maxPerHour.
 *
 * This module starts one setInterval tick when startTriggerEngine() is called (from index.ts).
 * Tests inject an overridable clock and Jira fetcher via the injectable seams at the bottom.
 */
import crypto from 'node:crypto';
import { all, one, insert, run as exec, type Row } from './db.ts';
import { post, get } from './http.ts';
import { requireProject, getProject, notifyProject } from './projects.ts';
import { badRequest, notFound, newId, now, str, parseJson, HttpError } from './util.ts';
import { audit } from './audit.ts';
import { checkConcurrency, isDraining, concurrencyReason, queueReasonLabel, drainQueue } from './control-plane.ts';
import { assertBudget } from './settings.ts';
import { getLoopSpec, getLoopSpecsByProject, fillTemplate, checkTriggerRateLimit, isDuplicateTrigger, recordTriggerFire, type LoopSpec } from './loop-specs.ts';
import type { AuditAction } from './audit.ts';

/* ------------------------------------------------------------------ */
/* Injectable seams for testing                                        */
/* ------------------------------------------------------------------ */

/** Override in tests to avoid real Jira calls. */
let _jiraPoller: ((projectId: string, jql: string) => Promise<{ key: string; summary: string; status: string }[]>) | null = null;
export function setJiraPoller(fn: typeof _jiraPoller): void {
  _jiraPoller = fn;
}

/** Override in tests to control time (ms since epoch). */
let _nowMs: (() => number) | null = null;
export function setNowMs(fn: (() => number) | null): void {
  _nowMs = fn;
}

function nowMs(): number {
  return _nowMs ? _nowMs() : Date.now();
}

/* ------------------------------------------------------------------ */
/* Mini cron parser (5-field: minute hour dom month dow)              */
/* ------------------------------------------------------------------ */

/** Parse a single cron field, returning the set of matching values. */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const step = part.includes('/') ? parseInt(part.split('/')[1], 10) : 1;
    const range = part.split('/')[0];
    let lo: number, hi: number;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(Number);
    } else {
      lo = hi = Number(range);
    }
    if (isNaN(lo) || isNaN(hi) || isNaN(step) || step < 1) continue;
    for (let v = Math.max(min, lo); v <= Math.min(max, hi); v += step) result.add(v);
  }
  return result;
}

/**
 * Parse a 5-field cron expression. Returns a function that says whether
 * a given Date matches the expression.
 */
export function parseCron(expr: string): (d: Date) => boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron must have 5 fields, got "${expr}"`);
  const [min, hour, dom, month, dow] = parts;
  const mins = parseCronField(min, 0, 59);
  const hours = parseCronField(hour, 0, 23);
  const doms = parseCronField(dom, 1, 31);
  const months = parseCronField(month, 1, 12);
  const dows = parseCronField(dow, 0, 6);
  return (d: Date) =>
    mins.has(d.getMinutes()) &&
    hours.has(d.getHours()) &&
    doms.has(d.getDate()) &&
    months.has(d.getMonth() + 1) &&
    dows.has(d.getDay());
}

/** Validate a 5-field cron expression without throwing on * fields. Returns error message or null. */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

/* ------------------------------------------------------------------ */
/* Create a workflow from a loop spec                                  */
/* ------------------------------------------------------------------ */

/**
 * Fill {{variable}} placeholders in a goal template, including common built-ins like {{date}}.
 */
function buildGoal(spec: LoopSpec, vars: Record<string, string>): string {
  const allVars: Record<string, string> = {
    date: new Date().toISOString().slice(0, 10),
    'repo.name': '',
    ...vars,
  };
  return fillTemplate(spec.goal_template, allVars);
}

/**
 * Start a new workflow session from a loop spec. Respects drain, concurrency caps, and budgets.
 * Called by the manual run endpoint, cron jobs, and webhook handlers.
 */
export async function createWorkflowFromSpec(
  spec: LoopSpec,
  userId: string,
  vars: Record<string, string> = {},
  startNow = true,
): Promise<Row> {
  // During drain, queue the session (do not reject — trigger-fired sessions must never be lost).
  const drainingNow = isDraining();
  const project = getProject(spec.project_id);

  // Concurrency cap: queue instead of rejecting.
  const capReason = drainingNow ? 'drain' : concurrencyReason(userId, project.id);
  const shouldQueue = startNow && capReason !== null;

  // Budget
  try {
    assertBudget(undefined, userId, project.id);
  } catch (e: any) {
    throw badRequest(e.message);
  }

  const goal = buildGoal(spec, vars);
  const title = (goal.split('\n')[0] || spec.name).slice(0, 80);

  // Apply stop rules from spec
  const sr = spec.stop_rules;
  const maxIterations = sr.maxIterations ?? 8;
  const budgetUsd = sr.budgetUsd ?? 5;

  const id = newId('w_');
  const ts = now();
  insert('workflows', {
    id,
    project_id: project.id,
    title,
    goal,
    status: shouldQueue ? 'queued' : (startNow ? 'running' : 'paused'),
    stop_reason: shouldQueue ? queueReasonLabel(capReason!) : (startNow ? '' : 'Not started yet. Press Resume to start.'),
    queue_reason: shouldQueue ? capReason! : '',
    queued_at: shouldQueue ? ts : null,
    model: 'sonnet',
    budget_usd: budgetUsd,
    budget_credits: 20,
    max_iterations: maxIterations,
    verify_command: '',
    rules: '',
    iteration: 0,
    burst_start: 0,
    spent_usd: 0,
    spent_credits: 0,
    work_branch: '',
    lead_agent: spec.lead_agent ?? '',
    engine: spec.engine ?? '',
    push_mode: spec.push_mode ?? 'ask',
    trust_tools: spec.trust_tools ?? 0,
    loop_spec_id: spec.id,
    planning_gate: spec.planning_gate,
    jira_key: vars['ticket.key'] ?? '',
    jira_summary: vars['ticket.summary'] ?? '',
    jira_url: vars['ticket.url'] ?? '',
    summary: '',
    created_by: userId,
    created_at: ts,
    updated_at: ts,
  });

  // Persist verification pipeline into loop_run_states (spec_snapshot)
  exec(
    `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, spec_snapshot, updated_at)
     VALUES (?, 0, 0, 'null', '[]', ?, ?)
     ON CONFLICT(workflow_id) DO NOTHING`,
    id,
    JSON.stringify({
      verification: spec.verification,
      stop_rules: spec.stop_rules,
      memory_config: spec.memory_config,
      escalation: spec.escalation,
      spec_id: spec.id,
    }),
    ts,
  );

  if (startNow && !shouldQueue) {
    const { kick } = await import('./workflows.ts') as any;
    if (typeof kick === 'function') kick(id);
  }

  notifyProject(project.id, 'workflow.created', { id });

  return one<Row>('SELECT * FROM workflows WHERE id = ?', id) as Row;
}

/* ------------------------------------------------------------------ */
/* Inbound webhook handler (generic + GitHub)                         */
/* ------------------------------------------------------------------ */

const WEBHOOK_RATE_LIMIT_MS = 60_000; // Token bucket window

/**
 * Verify HMAC-SHA256 X-Hub-Signature-256 header (GitHub format).
 * Returns true when the body matches the secret.
 */
function verifyHmac(secret: string, body: Buffer, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Build the dedup key for a GitHub event so the same PR or check suite does not start twice.
 */
function githubDedupKey(event: string, payload: any): string {
  if (event === 'pull_request') return `github:pr:${payload?.pull_request?.node_id ?? payload?.number ?? '?'}`;
  if (event === 'workflow_run') return `github:wf:${payload?.workflow_run?.id ?? '?'}`;
  if (event === 'check_suite') return `github:cs:${payload?.check_suite?.id ?? '?'}`;
  return `github:${event}:${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/* Cron engine                                                         */
/* ------------------------------------------------------------------ */

let _cronTimer: ReturnType<typeof setInterval> | null = null;
let _jiraTimer: ReturnType<typeof setInterval> | null = null;

/** Track last-fired minute per spec so we don't fire twice in the same minute. */
const cronLastFired = new Map<string, string>(); // spec_id → 'YYYY-MM-DDTHH:MM'

function minuteKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function runCronTick(): Promise<void> {
  const d = new Date(nowMs());
  const mk = minuteKey(d);
  const { rowToSpecFromRow } = await import('./loop-specs.ts');
  const specs = all<Row>("SELECT * FROM loop_specs WHERE trigger_kind = 'cron'");
  for (const r of specs) {
    const spec = rowToSpecFromRow(r);
    if (!spec) continue;
    const cron = spec.trigger_config.cron;
    if (!cron) continue;

    // Don't fire twice in the same minute
    if (cronLastFired.get(spec.id) === mk) continue;

    let matches = false;
    try {
      matches = parseCron(cron)(d);
    } catch {
      continue; // invalid cron — skip
    }
    if (!matches) continue;

    cronLastFired.set(spec.id, mk);

    // Dedup and rate limit
    const dedupKey = `cron:${spec.id}:${mk}`;
    if (isDuplicateTrigger(spec.id, dedupKey)) continue;
    const rateErr = checkTriggerRateLimit(spec.id);
    if (rateErr) {
      console.warn(`[trigger] Cron rate limit for spec ${spec.id}: ${rateErr}`);
      continue;
    }
    if (isDraining()) continue;

    // Find a valid user (the spec's creator; fall back to any admin).
    const userId = await resolveTriggerUser(spec.project_id, spec.created_by);
    if (!userId) continue;

    try {
      const wf = await createWorkflowFromSpec(spec, userId, {});
      recordTriggerFire(spec.id, 'cron', { cron, minute: mk }, wf.id);
      exec(
        'UPDATE trigger_history SET dedup_key = ? WHERE spec_id = ? AND fired_at = (SELECT MAX(fired_at) FROM trigger_history WHERE spec_id = ?)',
        dedupKey, spec.id, spec.id,
      );
      console.log(`[trigger] Cron fired spec "${spec.name}" (${spec.id}) → session ${String(wf.id)}`);
    } catch (e: any) {
      console.error(`[trigger] Cron failed for spec ${spec.id}:`, e.message);
    }
  }
}

async function runJiraPollTick(): Promise<void> {
  if (isDraining()) return;
  const specs = all<Row>("SELECT * FROM loop_specs WHERE trigger_kind = 'jira_event'");
  for (const r of specs) {
    try {
      await pollJiraForSpec(r);
    } catch (e: any) {
      // Jira errors are expected (not connected, etc.); log at debug level only.
      if (process.env.DEBUG_TRIGGERS) console.error(`[trigger] Jira poll for spec ${r.id}:`, e.message);
    }
  }
}

async function pollJiraForSpec(r: Row): Promise<void> {
  const { rowToSpecFromRow } = await import('./loop-specs.ts');
  const spec = rowToSpecFromRow(r);
  if (!spec) return;
  const tc = spec.trigger_config;
  if (!tc.jql && !tc.statusName && !_jiraPoller) return;

  // Build a JQL query: either the spec's JQL or a status-change query.
  // Skip JQL building if using the injectable seam (tests).
  let jql = tc.jql ?? '';
  if (!jql && tc.statusName && !_jiraPoller) {
    let mapping: { projectKey: string; jql: string } | null = null;
    try {
      const { mustMapping } = await import('./jira.ts');
      mapping = mustMapping(spec.project_id);
    } catch {
      return; // Jira not connected
    }
    if (!mapping) return;
    jql = `project = ${mapping.projectKey} AND status = "${tc.statusName}" AND updated >= -2h ORDER BY updated DESC`;
  }
  if (!jql && !_jiraPoller) return;

  // Use the injectable seam if set (for tests), otherwise use the real Jira client.
  let tickets: { key: string; summary: string; status: string }[];
  if (_jiraPoller) {
    tickets = await _jiraPoller(spec.project_id, jql || `status = "${tc.statusName}"`);
  } else {
    try {
      const { searchJiraIssues } = await import('./jira.ts');
      tickets = await searchJiraIssues(spec.project_id, jql, 10);
    } catch {
      return; // Jira not connected for this project
    }
  }

  const rateErr = checkTriggerRateLimit(spec.id);
  if (rateErr) return;

  const userId = await resolveTriggerUser(spec.project_id, spec.created_by);
  if (!userId) return;

  for (const ticket of tickets.slice(0, 3)) {
    const dedupKey = `jira:${spec.id}:${ticket.key}:${tc.statusName ?? tc.jql ?? ''}`;
    if (isDuplicateTrigger(spec.id, dedupKey)) continue;
    if (isDraining()) return;

    try {
      const vars: Record<string, string> = {
        'ticket.key': ticket.key,
        'ticket.summary': ticket.summary,
        'ticket.status': ticket.status,
        ...((ticket as any).url ? { 'ticket.url': String((ticket as any).url) } : {}),
      };
      const wf = await createWorkflowFromSpec(spec, userId, vars);
      recordTriggerFire(spec.id, 'jira_event', { jql, ticket: ticket.key }, wf.id);
      exec(
        'UPDATE trigger_history SET dedup_key = ? WHERE id = (SELECT id FROM trigger_history WHERE spec_id = ? ORDER BY fired_at DESC LIMIT 1)',
        dedupKey, spec.id,
      );
      console.log(`[trigger] Jira fired spec "${spec.name}" for ticket ${ticket.key} → session ${String(wf.id)}`);
    } catch (e: any) {
      console.error(`[trigger] Jira trigger failed for spec ${spec.id} ticket ${ticket.key}:`, e.message);
    }
  }
}

/** Find a valid user ID to own a trigger-fired session: creator first, then any admin. */
async function resolveTriggerUser(projectId: string, preferredUserId: string | null): Promise<string | null> {
  if (preferredUserId) {
    const u = one<{ id: string; disabled: number }>('SELECT id, disabled FROM users WHERE id = ?', preferredUserId);
    if (u && !u.disabled) return u.id;
  }
  // Fall back to any admin who is a project member or any admin.
  const admin = one<{ id: string }>('SELECT id FROM users WHERE is_admin = 1 AND disabled = 0 LIMIT 1');
  return admin?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Start / stop the trigger engine                                     */
/* ------------------------------------------------------------------ */

export function startTriggerEngine(): void {
  if (_cronTimer) return; // already running

  // Run cron every minute (align to 30s after the minute start to account for system jitter).
  const msUntilNextMinute = 60_000 - (nowMs() % 60_000) + 100;
  setTimeout(() => {
    runCronTick().catch(console.error);
    _cronTimer = setInterval(() => {
      runCronTick().catch(console.error);
    }, 60_000);
    _cronTimer.unref();
  }, msUntilNextMinute).unref();

  // Poll Jira every 5 minutes.
  _jiraTimer = setInterval(() => {
    runJiraPollTick().catch(console.error);
  }, 5 * 60_000);
  _jiraTimer.unref();
}

export function stopTriggerEngine(): void {
  if (_cronTimer) { clearInterval(_cronTimer); _cronTimer = null; }
  if (_jiraTimer) { clearInterval(_jiraTimer); _jiraTimer = null; }
}

/** Run the cron tick immediately (for testing). */
export async function tickCron(): Promise<void> {
  await runCronTick();
}

/** Run the Jira poll tick immediately (for testing). */
export async function tickJira(): Promise<void> {
  await runJiraPollTick();
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerTriggerRoutes(): void {
  // Generic inbound webhook — POST /api/loop-specs/:sid/webhook
  post('/api/loop-specs/:sid/webhook', async (ctx) => {
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.trigger_kind !== 'webhook') throw badRequest('This spec does not accept webhooks');
    const secret = spec.trigger_config.secret;
    if (!secret) throw new HttpError(401, 'Webhook secret not configured');

    // Verify HMAC signature from X-Hub-Signature-256 header (same format as GitHub).
    const rawBody = await ctx.raw(1_000_000);
    const sig = String(ctx.req.headers['x-hub-signature-256'] ?? ctx.req.headers['x-portal-signature'] ?? '');
    if (sig && !verifyHmac(secret, rawBody, sig)) {
      throw new HttpError(401, 'Webhook signature is invalid');
    }

    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { /* not JSON is fine */ }

    const rateErr = checkTriggerRateLimit(spec.id);
    if (rateErr) throw new HttpError(429, rateErr);

    if (isDraining()) throw new HttpError(503, 'The server is draining. Try again in a moment.');

    const dedupKey = `webhook:${spec.id}:${String(payload.id ?? payload.eventId ?? '')}:${now().slice(0, 16)}`;
    if (String(payload.id ?? '') && isDuplicateTrigger(spec.id, dedupKey)) {
      return { ok: true, duplicate: true };
    }

    // Flatten payload into template variables.
    const vars: Record<string, string> = {};
    const flatten = (obj: unknown, prefix = '') => {
      if (typeof obj === 'object' && obj && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          flatten(v, prefix ? `${prefix}.${k}` : k);
        }
      } else if (typeof obj === 'string' || typeof obj === 'number') {
        vars[prefix] = String(obj);
      }
    };
    flatten(payload);

    const userId = await resolveTriggerUser(spec.project_id, spec.created_by);
    if (!userId) throw new HttpError(503, 'No active user found to own this trigger-fired session');

    const wf = await createWorkflowFromSpec(spec, userId, vars);
    recordTriggerFire(spec.id, 'webhook', payload, wf.id);
    exec(
      'UPDATE trigger_history SET dedup_key = ? WHERE id = (SELECT id FROM trigger_history WHERE spec_id = ? ORDER BY fired_at DESC LIMIT 1)',
      dedupKey, spec.id,
    );
    return { ok: true, workflowId: wf.id };
  }, { auth: 'public' });

  // GitHub webhook — POST /api/loop-specs/:sid/github
  post('/api/loop-specs/:sid/github', async (ctx) => {
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.trigger_kind !== 'github_event') throw badRequest('This spec does not accept GitHub events');
    const secret = spec.trigger_config.secret;
    if (!secret) throw new HttpError(401, 'Webhook secret not configured for this spec');

    // Must have the GitHub delivery ID header
    const deliveryId = String(ctx.req.headers['x-github-delivery'] ?? '');
    const event = String(ctx.req.headers['x-github-event'] ?? '');

    const rawBody = await ctx.raw(5_000_000);
    const sig = String(ctx.req.headers['x-hub-signature-256'] ?? '');
    if (!verifyHmac(secret, rawBody, sig)) {
      throw new HttpError(401, 'GitHub signature is invalid');
    }

    let payload: any = {};
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { /* ignore */ }

    // Only handle events the spec cares about.
    const wantedEvents = spec.trigger_config.events ?? ['pull_request', 'workflow_run', 'check_suite'];
    if (!wantedEvents.includes(event)) {
      return { ok: true, ignored: true, reason: `Event "${event}" not in spec's event filter` };
    }

    // For workflow_run and check_suite, only fire on failures.
    if (event === 'workflow_run' && payload.workflow_run?.conclusion !== 'failure') {
      return { ok: true, ignored: true, reason: 'workflow_run was not a failure' };
    }
    if (event === 'check_suite' && payload.check_suite?.conclusion !== 'failure') {
      return { ok: true, ignored: true, reason: 'check_suite was not a failure' };
    }

    const dedupKey = githubDedupKey(event, payload) + `:${deliveryId}`;
    if (isDuplicateTrigger(spec.id, dedupKey)) {
      return { ok: true, duplicate: true };
    }

    const rateErr = checkTriggerRateLimit(spec.id);
    if (rateErr) throw new HttpError(429, rateErr);

    if (isDraining()) throw new HttpError(503, 'The server is draining.');

    // Extract useful variables from the payload.
    const vars: Record<string, string> = {
      'github.event': event,
      'repo.name': payload.repository?.name ?? '',
      'repo.full_name': payload.repository?.full_name ?? '',
    };
    if (event === 'pull_request') {
      vars['pr.number'] = String(payload.pull_request?.number ?? '');
      vars['pr.title'] = String(payload.pull_request?.title ?? '');
      vars['pr.branch'] = String(payload.pull_request?.head?.ref ?? '');
      vars['pr.url'] = String(payload.pull_request?.html_url ?? '');
    }
    if (event === 'workflow_run') {
      vars['wf.name'] = String(payload.workflow_run?.name ?? '');
      vars['wf.url'] = String(payload.workflow_run?.html_url ?? '');
    }

    const userId = await resolveTriggerUser(spec.project_id, spec.created_by);
    if (!userId) throw new HttpError(503, 'No active user for trigger-fired session');

    const wf = await createWorkflowFromSpec(spec, userId, vars);
    recordTriggerFire(spec.id, 'github_event', { event, deliveryId }, wf.id);
    exec(
      'UPDATE trigger_history SET dedup_key = ? WHERE id = (SELECT id FROM trigger_history WHERE spec_id = ? ORDER BY fired_at DESC LIMIT 1)',
      dedupKey, spec.id,
    );
    return { ok: true, workflowId: wf.id };
  }, { auth: 'public' });
}
