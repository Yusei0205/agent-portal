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
import { all, one, insert, run as exec, type Row, isDbOpen } from './db.ts';
import { post, get } from './http.ts';
import { requireProject, getProject, notifyProject, accessOf } from './projects.ts';
import { badRequest, notFound, newId, now, str, parseJson, HttpError } from './util.ts';
import { audit } from './audit.ts';
import { checkConcurrency, isDraining, concurrencyReason, queueReasonLabel, drainQueue } from './control-plane.ts';
import { assertBudget } from './settings.ts';
import { getLoopSpec, getLoopSpecsByProject, specActions, specMonthSpend, fillTemplate, checkTriggerRateLimit, isDuplicateTrigger, recordTriggerFire, rowToSpecFromRow, type LoopSpec } from './loop-specs.ts';
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

  // "Review pull request" reviews one pull request (from the event's variables or the person's) instead of starting a goal session (NEW-3).
  if (specActions(spec.trigger_config).includes('review_pr')) {
    const { startPrReview } = await import('./pr-review.ts');
    return startPrReview(spec, userId, vars);
  }

  // Several actions, or a pull request for the result (NEW-2 "Keep docs current"): one coordinated firing.
  if (specActions(spec.trigger_config).length > 1 || (spec.trigger_config.publishPr && specActions(spec.trigger_config).length)) {
    const { runRefreshActions } = await import('./docs-sync.ts');
    return runRefreshActions(spec, userId, vars);
  }

  if (spec.trigger_config.action && spec.monthly_budget_usd !== null && specMonthSpend(spec.id) >= spec.monthly_budget_usd) {
    throw badRequest(`This loop spec's monthly budget of $${spec.monthly_budget_usd} is used up.`);
  }

  // "Refresh diagrams" redraws stale architecture diagrams instead of starting a goal session (NEW-1). It returns the
  // first session it started, or a row without an id when nothing was stale; `refreshed` lists everything it did.
  if (spec.trigger_config.action === 'refresh_diagrams') {
    const { refreshStaleDiagrams } = await import('./diagrams.ts');
    const refreshed = await refreshStaleDiagrams(project.id, userId, { specId: spec.id });
    const first = refreshed.started[0] ? one<Row>('SELECT * FROM workflows WHERE id = ?', refreshed.started[0].workflowId) : null;
    return {
      ...(first ?? { id: null, project_id: project.id, title: 'Refresh diagrams', status: 'done', stop_reason: refreshed.stale ? 'No diagram could be refreshed' : 'No diagram is stale' }),
      refreshed,
    };
  }

  // "Refresh docs" rewrites stale generated documents (NEW-6) the same way: the first session started, plus `refreshed`.
  if (spec.trigger_config.action === 'refresh_docs') {
    const { refreshStaleDocs } = await import('./generated-docs.ts');
    const refreshed = await refreshStaleDocs(project.id, userId, { specId: spec.id });
    const first = refreshed.started[0] ? one<Row>('SELECT * FROM workflows WHERE id = ?', refreshed.started[0].workflowId) : null;
    return {
      ...(first ?? { id: null, project_id: project.id, title: 'Refresh documents', status: 'done', stop_reason: refreshed.stale ? 'No document could be refreshed' : 'No document is stale' }),
      refreshed,
    };
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
let _cronAlignTimer: ReturnType<typeof setTimeout> | null = null;
let _jiraTimer: ReturnType<typeof setInterval> | null = null;

/** Track last-fired minute per spec so we don't fire twice in the same minute. */
const cronLastFired = new Map<string, string>(); // spec_id → 'YYYY-MM-DDTHH:MM'

function minuteKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function runCronTick(): Promise<void> {
  if (!isDbOpen()) return;
  const d = new Date(nowMs());
  const mk = minuteKey(d);
  try { (await import('./docs-sync.ts')).reconcileDocsSync(); } catch { /* best-effort */ }
  try { (await import('./pr-review.ts')).reconcilePrReviews(); } catch { /* best-effort */ }
  // A github_event spec may also carry a schedule (trigger_config.cron), e.g. the nightly pass of "Keep docs current".
  const specs = all<Row>("SELECT * FROM loop_specs WHERE trigger_kind = 'cron' OR (trigger_kind = 'github_event' AND trigger_config LIKE '%\"cron\"%')");
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

    // The person the trigger runs as (see resolveTriggerUser); without one it does not fire.
    if (!isDbOpen()) return;
    const userId = await resolveTriggerUser(spec.project_id, spec.created_by);
    if (!userId) {
      console.warn(`[trigger] cron spec "${spec.name}" (${spec.id}) skipped: ${NO_OWNER}`);
      continue;
    }

    try {
      if (!isDbOpen()) return;
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
  if (!isDbOpen()) return;
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
  if (!userId) {
    console.warn(`[trigger] Jira spec "${spec.name}" (${spec.id}) skipped: ${NO_OWNER}`);
    return;
  }

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

/**
 * The person a trigger-fired session runs as: the one who last saved the trigger, while they can still sign in and
 * still have edit access to the project. Nobody else: falling back to "any admin" let a trigger keep running with an
 * admin's identity and budget after its owner left the project. Without an owner the trigger does not fire; saving it
 * again makes the person who saves it the owner.
 */
export async function resolveTriggerUser(projectId: string, preferredUserId: string | null): Promise<string | null> {
  if (!preferredUserId) return null;
  const u = one<{ id: string; email: string; name: string; is_admin: number; disabled: number }>('SELECT id, email, name, is_admin, disabled FROM users WHERE id = ?', preferredUserId);
  if (!u || u.disabled) return null;
  const access = accessOf(u as any, projectId);
  if (access !== 'editor' && access !== 'owner') return null;
  return u.id;
}

/** Why a trigger cannot fire for want of an owner, for the caller's error. */
const NO_OWNER = 'This trigger has no owner who can run it (disabled, or no longer an editor of the project). Save the trigger again to become its owner.';

/* ------------------------------------------------------------------ */
/* Start / stop the trigger engine                                     */
/* ------------------------------------------------------------------ */

export function startTriggerEngine(): void {
  if (_cronTimer || _cronAlignTimer) return; // already running

  // Run cron every minute (align to 30s after the minute start to account for system jitter).
  const msUntilNextMinute = 60_000 - (nowMs() % 60_000) + 100;
  _cronAlignTimer = setTimeout(() => {
    _cronAlignTimer = null;
    // Do not start the cron engine if the DB was closed (server is shutting down).
    if (!isDbOpen()) return;
    runCronTick().catch(console.error);
    _cronTimer = setInterval(() => {
      if (isDbOpen()) runCronTick().catch(console.error);
    }, 60_000);
    _cronTimer.unref();
  }, msUntilNextMinute);
  _cronAlignTimer.unref();

  // Poll Jira every 5 minutes.
  _jiraTimer = setInterval(() => {
    if (isDbOpen()) runJiraPollTick().catch(console.error);
  }, 5 * 60_000);
  _jiraTimer.unref();
}

export function stopTriggerEngine(): void {
  if (_cronAlignTimer) { clearTimeout(_cronAlignTimer); _cronAlignTimer = null; }
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
    // The signature is required: without it anyone who knows this URL could start an unattended session.
    if (!sig) throw new HttpError(401, 'Sign the request: send X-Hub-Signature-256 (sha256=<HMAC of the body with the spec secret>)');
    if (!verifyHmac(secret, rawBody, sig)) {
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
    if (!userId) throw new HttpError(409, NO_OWNER);

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

    // review_pr (NEW-3): one review per pull request and commit, only for events that are a reason to review.
    if (specActions(spec.trigger_config).includes('review_pr')) {
      const { decideGithubEvent } = await import('./pr-review.ts');
      const d = decideGithubEvent(spec, event, payload);
      if (!d.fire) return { ok: true, ignored: true, reason: d.reason };
      if (isDuplicateTrigger(spec.id, d.key)) return { ok: true, duplicate: true };
      const rateErr = checkTriggerRateLimit(spec.id);
      if (rateErr) throw new HttpError(429, rateErr);
      if (isDraining()) throw new HttpError(503, 'The server is draining.');
      const userId = await resolveTriggerUser(spec.project_id, spec.created_by);
      if (!userId) throw new HttpError(409, NO_OWNER);
      const wf = await createWorkflowFromSpec(spec, userId, d.vars);
      if (!wf.id) return { ok: true, ignored: true, reason: String(wf.stop_reason) };
      recordTriggerFire(spec.id, 'github_event', { event, deliveryId, pr: d.vars['pr.number'], sha: d.vars['pr.sha'] }, wf.id);
      exec(
        'UPDATE trigger_history SET dedup_key = ? WHERE id = (SELECT id FROM trigger_history WHERE spec_id = ? ORDER BY fired_at DESC LIMIT 1)',
        d.key, spec.id,
      );
      return { ok: true, workflowId: wf.id, reviewId: (wf as any).review?.id ?? null };
    }

    // mergedOnly: a pull request counts only once it is merged into the repository's default branch.
    const mergedOnly = event === 'pull_request' && Boolean(spec.trigger_config.mergedOnly);
    if (mergedOnly) {
      const pr = payload.pull_request;
      if (payload.action !== 'closed' || pr?.merged !== true) return { ok: true, ignored: true, reason: 'pull_request was not merged' };
      const def = payload.repository?.default_branch;
      if (!def || pr?.base?.ref !== def) return { ok: true, ignored: true, reason: 'pull_request was not merged into the default branch' };
    }

    // For workflow_run and check_suite, only fire on failures.
    if (event === 'workflow_run' && payload.workflow_run?.conclusion !== 'failure') {
      return { ok: true, ignored: true, reason: 'workflow_run was not a failure' };
    }
    if (event === 'check_suite' && payload.check_suite?.conclusion !== 'failure') {
      return { ok: true, ignored: true, reason: 'check_suite was not a failure' };
    }

    const dedupKey = mergedOnly ? `github:pr-merged:${payload.pull_request?.node_id ?? payload.number ?? '?'}` : githubDedupKey(event, payload) + `:${deliveryId}`;
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
    if (!userId) throw new HttpError(409, NO_OWNER);

    const wf = await createWorkflowFromSpec(spec, userId, vars);
    recordTriggerFire(spec.id, 'github_event', { event, deliveryId }, wf.id);
    exec(
      'UPDATE trigger_history SET dedup_key = ? WHERE id = (SELECT id FROM trigger_history WHERE spec_id = ? ORDER BY fired_at DESC LIMIT 1)',
      dedupKey, spec.id,
    );
    return { ok: true, workflowId: wf.id };
  }, { auth: 'public' });
}
