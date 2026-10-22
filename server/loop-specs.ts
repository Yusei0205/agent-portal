/**
 * Loop specs — reusable named configurations for autonomous workflow sessions.
 *
 * A loop spec defines *everything* needed to run a session unattended: what triggers it (cron,
 * webhook, GitHub event, Jira event, or manually), what goal template to use (with
 * {{ticket.key}} / {{repo.name}} / {{date}} variables), which verification steps to run, when to
 * stop, and what to do when it is blocked or exhausted.
 *
 * Sessions record the spec they were started from, so metrics can be aggregated per spec.
 *
 * CRUD: project editors manage specs. Admins inherit editor access everywhere.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, insert, one, run as exec, update, type Row } from './db.ts';
import { del, get, post, put, patch } from './http.ts';
import { requireProject, getProject, notifyProject, projectDir } from './projects.ts';
import { badRequest, notFound, newId, now, str, parseJson, HttpError } from './util.ts';
import { audit } from './audit.ts';
import type { AuditAction } from './audit.ts';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface VerificationStep {
  /** Short name shown in the UI (e.g. "lint", "test", "build"). */
  step: string;
  /** Shell command to run (for cmd steps). */
  cmd?: string;
  /** Timeout in seconds. Default: 300. */
  timeout?: number;
  /** If true, a non-zero exit stops the pipeline and counts as a failure. */
  required?: boolean;
  /** Repository slug to run the command in (blank = the session's primary repo work dir). */
  workRepo?: string;
  /** Special step kind: "llm" uses the LLM judge. */
  kind?: 'cmd' | 'llm';
  /** For llm kind: evaluation rubric. */
  rubric?: string;
}

export interface StopRules {
  /** Max iterations per burst (overrides session-level limit when set). */
  maxIterations?: number;
  /** Per-session USD budget (overrides session-level budget when set). */
  budgetUsd?: number;
  /** Stop after N iterations with the same summary. Default: 3. */
  stagnationWindow?: number;
  /** Stop after N consecutive run failures. Default: 2. */
  maxConsecutiveFailures?: number;
  /** Hard wall-clock limit in minutes. 0 = no limit. */
  wallClockMinutes?: number;
  /** Require all required verification steps to pass before accepting "done". Default: true. */
  requireVerification?: boolean;
}

export interface MemoryConfig {
  /** Write per-iteration summaries to a progress file. Default: true. */
  progressFile?: boolean;
  /** Append agent answers to decisions.md (same pattern as the knowledge module). Default: false. */
  appendDecisions?: boolean;
  /** Max entries to keep in the progress file. Default: 20. */
  maxEntries?: number;
}

export interface EscalationConfig {
  /** Create an Inbox item when the session is blocked. Default: true. */
  onBlocked?: boolean;
  /** Create an Inbox item when the session fails. Default: true. */
  onFail?: boolean;
  /** Open a GitHub issue when blocked (GitHub repos only). Default: false. */
  githubIssueOnBlocked?: boolean;
  /** Fire the outbound webhook on escalation. Default: true. */
  webhook?: boolean;
}

export interface TriggerConfig {
  /** For cron: five-field cron expression (minute hour dom month dow). */
  cron?: string;
  /** For interval: run every N minutes. */
  intervalMinutes?: number;
  /** For webhook/github_event: the per-spec HMAC secret. */
  secret?: string;
  /** For github_event: the events to listen for (pull_request, workflow_run, check_suite). */
  events?: string[];
  /** For jira_event: the JQL expression to poll. */
  jql?: string;
  /** For jira_event: the status name to watch for. */
  statusName?: string;
  /** Max sessions to start per hour (default: 3). */
  maxPerHour?: number;
  /** Variables injected from the trigger payload (e.g. ticket key, PR number). */
  payloadVars?: Record<string, string>;
}

export interface LoopSpec {
  id: string;
  project_id: string;
  name: string;
  description: string;
  trigger_kind: 'manual' | 'cron' | 'webhook' | 'github_event' | 'jira_event';
  trigger_config: TriggerConfig;
  goal_template: string;
  verification: VerificationStep[];
  stop_rules: StopRules;
  memory_config: MemoryConfig;
  escalation: EscalationConfig;
  push_mode: string | null;
  trust_tools: number | null;
  lead_agent: string | null;
  engine: string | null;
  monthly_budget_usd: number | null;
  planning_gate: number;
  is_template: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/* Variable interpolation                                              */
/* ------------------------------------------------------------------ */

const VAR_RE = /\{\{([a-z_.]+)\}\}/g;

/**
 * Fill in {{variable}} placeholders in a goal template.
 * Unknown variables are left as-is so the agent can see what was not filled.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (_m, key) => vars[key] ?? _m);
}

/**
 * Extract all variable names used in a template.
 */
export function templateVars(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

/* ------------------------------------------------------------------ */
/* Built-in templates                                                  */
/* ------------------------------------------------------------------ */

export const BUILT_IN_TEMPLATES: Omit<LoopSpec, 'id' | 'project_id' | 'created_by' | 'created_at' | 'updated_at'>[] = [
  {
    name: 'Investigate and fix a ticket (RCA)',
    description: 'Research a Jira ticket, reproduce it, write the root cause and resolution, fix it, open a PR, and draft the Jira comment with before/after evidence.',
    trigger_kind: 'manual',
    trigger_config: { maxPerHour: 3 },
    goal_template: [
      'Ticket: {{ticket.url}} ({{ticket.key}}: {{ticket.summary}})',
      '',
      '1. Research the ticket, the related code and the project documents.',
      '2. Reproduce the issue and record how you did it.',
      '3. Write the root cause analysis (RCA) and the resolution.',
      '4. Follow and align with the project documents and the decisions log.',
      '5. Plan the fixes.',
      '6. Implement the fixes, with tests.',
      '7. Open a pull request.',
      '8. Give test steps to reproduce the issue and to confirm the fix, with evidence (before and after).',
      '9. Draft a comment for the Jira ticket summarising the RCA, the fix and the before/after test results.',
    ].join('\n'),
    verification: [],
    stop_rules: { maxIterations: 10, stagnationWindow: 3, requireVerification: true },
    memory_config: { progressFile: true, maxEntries: 20 },
    escalation: { onBlocked: true, onFail: true, webhook: true },
    push_mode: 'ask',
    trust_tools: 0,
    lead_agent: null,
    engine: null,
    monthly_budget_usd: null,
    planning_gate: 0,
    is_template: 1,
  },
  {
    name: 'Feature from Jira ticket',
    description: 'Implement a feature described in a Jira ticket. Fires when the ticket enters "In Progress".',
    trigger_kind: 'jira_event',
    trigger_config: { statusName: 'In Progress', maxPerHour: 3 },
    goal_template: 'Implement {{ticket.summary}} ({{ticket.key}}) in {{repo.name}}.\n\nTicket description:\n{{ticket.description}}\n\nStop when all tests pass and the code is ready for review.',
    verification: [
      { step: 'lint', cmd: 'npm run lint', timeout: 120, required: false, kind: 'cmd' },
      { step: 'test', cmd: 'npm test', timeout: 600, required: true, kind: 'cmd' },
    ],
    stop_rules: { maxIterations: 10, stagnationWindow: 3, requireVerification: true },
    memory_config: { progressFile: true, maxEntries: 20 },
    escalation: { onBlocked: true, onFail: true, webhook: true },
    push_mode: 'ask',
    trust_tools: 0,
    lead_agent: null,
    engine: null,
    monthly_budget_usd: null,
    planning_gate: 0,
    is_template: 1,
  },
  {
    name: 'Bug fix',
    description: 'Fix a bug from a Jira ticket or a direct instruction.',
    trigger_kind: 'manual',
    trigger_config: { maxPerHour: 3 },
    goal_template: 'Fix {{ticket.summary}} ({{ticket.key}}) in {{repo.name}}.\n\nDescription:\n{{ticket.description}}\n\nStop when the bug is fixed and all tests pass.',
    verification: [
      { step: 'test', cmd: 'npm test', timeout: 600, required: true, kind: 'cmd' },
    ],
    stop_rules: { maxIterations: 8, requireVerification: true },
    memory_config: { progressFile: true, maxEntries: 15 },
    escalation: { onBlocked: true, onFail: true, webhook: true },
    push_mode: 'ask',
    trust_tools: 0,
    lead_agent: null,
    engine: null,
    monthly_budget_usd: null,
    planning_gate: 0,
    is_template: 1,
  },
  {
    name: 'Nightly test fixer',
    description: 'Run nightly, pick up any failing tests in CI, and open a PR with a fix.',
    trigger_kind: 'cron',
    trigger_config: { cron: '0 2 * * *', maxPerHour: 1 },
    goal_template: 'Look at the failing tests in {{repo.name}} on {{date}}. Fix all failing tests. Open a PR when all tests pass.',
    verification: [
      { step: 'test', cmd: 'npm test', timeout: 600, required: true, kind: 'cmd' },
    ],
    stop_rules: { maxIterations: 6, budgetUsd: 3, requireVerification: true },
    memory_config: { progressFile: true, maxEntries: 10 },
    escalation: { onBlocked: true, onFail: false, webhook: true },
    push_mode: 'auto',
    trust_tools: 0,
    lead_agent: null,
    engine: null,
    monthly_budget_usd: null,
    planning_gate: 0,
    is_template: 1,
  },
  {
    name: 'Dependency update',
    description: 'Update outdated dependencies, run tests, and open a PR.',
    trigger_kind: 'cron',
    trigger_config: { cron: '0 3 * * 1', maxPerHour: 1 },
    goal_template: 'Update all outdated npm dependencies in {{repo.name}}. Run the test suite. If tests pass, open a PR. If tests fail, fix the breakages first.',
    verification: [
      { step: 'test', cmd: 'npm test', timeout: 600, required: true, kind: 'cmd' },
    ],
    stop_rules: { maxIterations: 5, budgetUsd: 2 },
    memory_config: { progressFile: true, maxEntries: 10 },
    escalation: { onBlocked: true, onFail: false, webhook: false },
    push_mode: 'auto',
    trust_tools: 0,
    lead_agent: null,
    engine: null,
    monthly_budget_usd: null,
    planning_gate: 0,
    is_template: 1,
  },
];

/* ------------------------------------------------------------------ */
/* DB helpers                                                          */
/* ------------------------------------------------------------------ */

function rowToSpec(r: Row): LoopSpec {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    name: String(r.name),
    description: String(r.description ?? ''),
    trigger_kind: (r.trigger_kind as LoopSpec['trigger_kind']) ?? 'manual',
    trigger_config: parseJson<TriggerConfig>(r.trigger_config, {}),
    goal_template: String(r.goal_template ?? ''),
    verification: parseJson<VerificationStep[]>(r.verification, []),
    stop_rules: parseJson<StopRules>(r.stop_rules, {}),
    memory_config: parseJson<MemoryConfig>(r.memory_config, {}),
    escalation: parseJson<EscalationConfig>(r.escalation, {}),
    push_mode: r.push_mode ?? null,
    trust_tools: r.trust_tools !== null && r.trust_tools !== undefined ? Number(r.trust_tools) : null,
    lead_agent: r.lead_agent ?? null,
    engine: r.engine ?? null,
    monthly_budget_usd: r.monthly_budget_usd !== null ? Number(r.monthly_budget_usd) : null,
    planning_gate: Number(r.planning_gate ?? 0),
    is_template: Number(r.is_template ?? 0),
    created_by: String(r.created_by),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function getLoopSpec(id: string): LoopSpec {
  const r = one<Row>('SELECT * FROM loop_specs WHERE id = ?', id);
  if (!r) throw notFound('Loop spec not found');
  return rowToSpec(r);
}

/** Export for use in loop-triggers.ts (avoids re-parsing). */
export const rowToSpecFromRow = rowToSpec;

export function getLoopSpecsByProject(projectId: string): LoopSpec[] {
  return all<Row>('SELECT * FROM loop_specs WHERE project_id = ? ORDER BY is_template DESC, name', projectId).map(rowToSpec);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const TRIGGER_KINDS = ['manual', 'cron', 'webhook', 'github_event', 'jira_event'];

function validateTriggerKind(k: unknown): LoopSpec['trigger_kind'] {
  if (!TRIGGER_KINDS.includes(String(k))) throw badRequest(`Trigger kind must be one of: ${TRIGGER_KINDS.join(', ')}`);
  return String(k) as LoopSpec['trigger_kind'];
}

function validateVerification(raw: unknown): VerificationStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Verification must be a list of steps');
  if (raw.length > 20) throw badRequest('At most 20 verification steps');
  return raw.map((s: any, i) => {
    if (!s || typeof s !== 'object') throw badRequest(`Step ${i + 1} must be an object`);
    if (!s.step || typeof s.step !== 'string') throw badRequest(`Step ${i + 1} must have a name`);
    const kind: VerificationStep['kind'] = s.kind === 'llm' ? 'llm' : 'cmd';
    const step: VerificationStep = {
      step: String(s.step).slice(0, 40),
      kind,
      timeout: s.timeout ? Math.min(3600, Math.max(5, Number(s.timeout))) : 300,
      required: s.required !== false,
    };
    if (kind === 'llm') {
      step.rubric = String(s.rubric ?? '').slice(0, 4000);
    } else {
      if (!s.cmd) throw badRequest(`Step "${s.step}" must have a cmd`);
      step.cmd = String(s.cmd).slice(0, 1000);
      if (s.workRepo) step.workRepo = String(s.workRepo).slice(0, 80);
    }
    return step;
  });
}

function validateStopRules(raw: unknown): StopRules {
  if (!raw || typeof raw !== 'object') return {};
  const s = raw as Record<string, unknown>;
  const out: StopRules = {};
  if (s.maxIterations !== undefined) out.maxIterations = Math.min(50, Math.max(1, Number(s.maxIterations)));
  if (s.budgetUsd !== undefined) out.budgetUsd = Math.min(1000, Math.max(0.1, Number(s.budgetUsd)));
  if (s.stagnationWindow !== undefined) out.stagnationWindow = Math.min(10, Math.max(1, Number(s.stagnationWindow)));
  if (s.maxConsecutiveFailures !== undefined) out.maxConsecutiveFailures = Math.min(10, Math.max(1, Number(s.maxConsecutiveFailures)));
  if (s.wallClockMinutes !== undefined) out.wallClockMinutes = Math.min(1440, Math.max(0, Number(s.wallClockMinutes)));
  if (s.requireVerification !== undefined) out.requireVerification = Boolean(s.requireVerification);
  return out;
}

function validateMemoryConfig(raw: unknown): MemoryConfig {
  if (!raw || typeof raw !== 'object') return { progressFile: true };
  const m = raw as Record<string, unknown>;
  const out: MemoryConfig = {};
  if (m.progressFile !== undefined) out.progressFile = Boolean(m.progressFile);
  if (m.appendDecisions !== undefined) out.appendDecisions = Boolean(m.appendDecisions);
  if (m.maxEntries !== undefined) out.maxEntries = Math.min(100, Math.max(1, Number(m.maxEntries)));
  return out;
}

function validateEscalation(raw: unknown): EscalationConfig {
  if (!raw || typeof raw !== 'object') return { onBlocked: true, onFail: true };
  const e = raw as Record<string, unknown>;
  const out: EscalationConfig = {};
  if (e.onBlocked !== undefined) out.onBlocked = Boolean(e.onBlocked);
  if (e.onFail !== undefined) out.onFail = Boolean(e.onFail);
  if (e.githubIssueOnBlocked !== undefined) out.githubIssueOnBlocked = Boolean(e.githubIssueOnBlocked);
  if (e.webhook !== undefined) out.webhook = Boolean(e.webhook);
  return out;
}

/* ------------------------------------------------------------------ */
/* Save-as-spec from a session                                         */
/* ------------------------------------------------------------------ */

/**
 * Create a loop spec from a live session's current settings.
 * Called by POST /api/workflows/:id/save-as-spec.
 */
export function saveSessionAsSpec(workflowId: string, userId: string, name: string, description: string): LoopSpec {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', workflowId);
  if (!w) throw notFound('Session not found');
  const id = newId('ls_');
  const verification: VerificationStep[] = w.verify_command
    ? [{ step: 'verify', cmd: String(w.verify_command), timeout: 300, required: true, kind: 'cmd' }]
    : [];
  insert('loop_specs', {
    id,
    project_id: w.project_id,
    name: name.slice(0, 80),
    description: description.slice(0, 500),
    trigger_kind: 'manual',
    trigger_config: JSON.stringify({ maxPerHour: 3 }),
    goal_template: String(w.goal ?? '').slice(0, 6000),
    verification: JSON.stringify(verification),
    stop_rules: JSON.stringify({ maxIterations: w.max_iterations ?? 8, budgetUsd: w.budget_usd ?? 5, requireVerification: true }),
    memory_config: JSON.stringify({ progressFile: true, maxEntries: 20 }),
    escalation: JSON.stringify({ onBlocked: true, onFail: true, webhook: true }),
    push_mode: w.push_mode ?? null,
    trust_tools: w.trust_tools ?? 0,
    lead_agent: w.lead_agent ?? null,
    engine: w.engine ?? null,
    monthly_budget_usd: w.monthly_budget_usd ?? null,
    planning_gate: 0,
    is_template: 0,
    created_by: userId,
    created_at: now(),
    updated_at: now(),
  });
  return getLoopSpec(id);
}

/* ------------------------------------------------------------------ */
/* Trigger rate limiting                                               */
/* ------------------------------------------------------------------ */

/**
 * Check whether a spec may fire based on its per-hour rate limit.
 * Returns null if allowed, or a reason string if not.
 */
export function checkTriggerRateLimit(specId: string): string | null {
  const spec = getLoopSpec(specId);
  const maxPerHour = spec.trigger_config.maxPerHour ?? 3;
  if (maxPerHour <= 0) return null; // 0 = unlimited

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const count = Number(
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM trigger_history WHERE spec_id = ? AND fired_at >= ?",
      specId, since,
    )?.n ?? 0,
  );
  if (count >= maxPerHour) {
    return `This loop spec has already fired ${maxPerHour} time(s) in the last hour. Wait before triggering again.`;
  }
  return null;
}

/**
 * Record a trigger fire in the history log (for dedup and rate-limit).
 */
export function recordTriggerFire(specId: string, kind: string, payload: Record<string, unknown>, workflowId: string | null): void {
  exec(
    'INSERT INTO trigger_history (id, spec_id, kind, payload, workflow_id, fired_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId('th_'),
    specId,
    kind,
    JSON.stringify(payload),
    workflowId,
    now(),
  );
}

/**
 * Check for dedup: has the same dedup key already fired in the last hour?
 */
export function isDuplicateTrigger(specId: string, dedupKey: string): boolean {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM trigger_history WHERE spec_id = ? AND dedup_key = ? AND fired_at >= ?",
    specId, dedupKey, since,
  );
  return Number(row?.n ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* Loop spec metrics                                                   */
/* ------------------------------------------------------------------ */

export function getSpecMetrics(specId: string, windowDays = 30): Record<string, unknown> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const rows = all<Row>(
    'SELECT * FROM loop_metrics WHERE loop_spec_id = ? AND started_at >= ?',
    specId, since,
  );
  if (!rows.length) {
    return { spec_id: specId, window_days: windowDays, total: 0, done: 0, failed: 0, blocked: 0, success_rate: null, avg_cost_usd: null, avg_iterations: null, avg_duration_s: null, autonomy_rate: null };
  }
  const total = rows.length;
  const done = rows.filter((r) => r.terminal_state === 'done').length;
  const failed = rows.filter((r) => r.terminal_state === 'failed').length;
  const blocked = rows.filter((r) => r.terminal_state === 'blocked').length;
  const costRows = rows.filter((r) => r.cost_usd !== null);
  const iterRows = rows.filter((r) => r.iterations_used !== null);
  const durRows = rows.filter((r) => r.duration_s !== null);
  const autoRows = rows.filter((r) => r.human_inputs !== null);
  const prRows = rows.filter((r) => r.pr_opened);
  return {
    spec_id: specId,
    window_days: windowDays,
    total,
    done,
    failed,
    blocked,
    success_rate: done / total,
    avg_cost_usd: costRows.length ? costRows.reduce((s, r) => s + Number(r.cost_usd), 0) / costRows.length : null,
    avg_iterations: iterRows.length ? iterRows.reduce((s, r) => s + Number(r.iterations_used), 0) / iterRows.length : null,
    avg_duration_s: durRows.length ? durRows.reduce((s, r) => s + Number(r.duration_s), 0) / durRows.length : null,
    autonomy_rate: autoRows.length ? autoRows.filter((r) => Number(r.human_inputs) === 0).length / autoRows.length : null,
    pr_rate: prRows.length / total,
  };
}

export function getProjectMetrics(projectId: string, windowDays = 30): Record<string, unknown> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const rows = all<Row>(
    'SELECT lm.*, ls.name AS spec_name FROM loop_metrics lm LEFT JOIN loop_specs ls ON ls.id = lm.loop_spec_id WHERE (ls.project_id = ? OR lm.project_id = ?) AND lm.started_at >= ?',
    projectId, projectId, since,
  );
  const bySpec = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.loop_spec_id ?? '__adhoc__';
    if (!bySpec.has(key)) bySpec.set(key, []);
    bySpec.get(key)!.push(r);
  }
  const specs = [...bySpec.entries()].map(([specId, sRows]) => {
    const total = sRows.length;
    const done = sRows.filter((r) => r.terminal_state === 'done').length;
    return {
      spec_id: specId === '__adhoc__' ? null : specId,
      spec_name: sRows[0]?.spec_name ?? (specId === '__adhoc__' ? 'Ad-hoc sessions' : null),
      total,
      done,
      success_rate: done / total,
      avg_cost_usd: total ? sRows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0) / total : null,
    };
  });
  const overall = {
    total: rows.length,
    done: rows.filter((r) => r.terminal_state === 'done').length,
    avg_cost_usd: rows.length ? rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0) / rows.length : null,
  };
  return { project_id: projectId, window_days: windowDays, overall, specs };
}

/**
 * Record loop metrics when a session closes (called from workflows.ts stopWith).
 * Safe to call multiple times — uses INSERT OR IGNORE.
 */
export function recordLoopMetrics(opts: {
  workflowId: string;
  specId: string | null;
  projectId: string;
  terminalState: string;
  iterationsUsed: number;
  costUsd: number;
  verifStepsPass: number;
  verifStepsFail: number;
  stagnationHit: number;
  humanInputs: number;
  prOpened: number;
  startedAt: string;
  finishedAt: string;
}): void {
  const duration = Math.round((new Date(opts.finishedAt).getTime() - new Date(opts.startedAt).getTime()) / 1000);
  exec(
    `INSERT OR IGNORE INTO loop_metrics
      (id, loop_spec_id, project_id, workflow_id, terminal_state, iterations_used, cost_usd,
       verif_steps_pass, verif_steps_fail, stagnation_hit, human_inputs, pr_opened,
       started_at, finished_at, duration_s)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('lm_'),
    opts.specId,
    opts.projectId,
    opts.workflowId,
    opts.terminalState,
    opts.iterationsUsed,
    opts.costUsd,
    opts.verifStepsPass,
    opts.verifStepsFail,
    opts.stagnationHit,
    opts.humanInputs,
    opts.prOpened,
    opts.startedAt,
    opts.finishedAt,
    isFinite(duration) && duration >= 0 ? duration : null,
  );
}

/* ------------------------------------------------------------------ */
/* Prometheus metrics text format                                      */
/* ------------------------------------------------------------------ */

export function prometheusMetrics(): string {
  const lines: string[] = [
    '# HELP portal_sessions_active Number of active (running) top-level sessions',
    '# TYPE portal_sessions_active gauge',
  ];
  // Per-project active sessions
  const active = all<Row>("SELECT project_id, COUNT(*) AS n FROM workflows WHERE status = 'running' AND depth = 0 GROUP BY project_id");
  for (const r of active) {
    lines.push(`portal_sessions_active{project="${String(r.project_id).replace(/"/g, '')}"} ${r.n}`);
  }
  if (!active.length) lines.push('portal_sessions_active 0');

  lines.push(
    '',
    '# HELP portal_approvals_pending Number of pending approval inputs across all projects',
    '# TYPE portal_approvals_pending gauge',
  );
  const pending = Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM inputs WHERE status = 'pending'")?.n ?? 0);
  lines.push(`portal_approvals_pending ${pending}`);

  lines.push(
    '',
    '# HELP portal_budget_used_usd Total USD spent in the current month',
    '# TYPE portal_budget_used_usd gauge',
  );
  const d = new Date();
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const spent = Number(one<{ s: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE created_at >= ?', since)?.s ?? 0);
  lines.push(`portal_budget_used_usd{month="${month}"} ${spent.toFixed(6)}`);

  lines.push(
    '',
    '# HELP portal_loop_specs_total Number of loop specs per project',
    '# TYPE portal_loop_specs_total gauge',
  );
  const specs = all<Row>('SELECT project_id, COUNT(*) AS n FROM loop_specs GROUP BY project_id');
  for (const r of specs) {
    lines.push(`portal_loop_specs_total{project="${String(r.project_id).replace(/"/g, '')}"} ${r.n}`);
  }

  lines.push(
    '',
    '# HELP portal_loop_runs_total Total loop spec runs by outcome (30-day window)',
    '# TYPE portal_loop_runs_total counter',
  );
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const outcomes = all<Row>(
    'SELECT terminal_state, COUNT(*) AS n FROM loop_metrics WHERE started_at >= ? GROUP BY terminal_state',
    thirtyDaysAgo,
  );
  for (const r of outcomes) {
    lines.push(`portal_loop_runs_total{outcome="${String(r.terminal_state).replace(/"/g, '')}"} ${r.n}`);
  }

  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerLoopSpecRoutes(): void {
  // List all specs for a project
  get('/api/projects/:pid/loop-specs', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    return { specs: getLoopSpecsByProject(project.id) };
  });

  // Seed built-in templates for a project (idempotent)
  post('/api/projects/:pid/loop-specs/seed', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const existing = new Set(
      all<Row>('SELECT name FROM loop_specs WHERE project_id = ? AND is_template = 1', project.id).map((r) => String(r.name)),
    );
    const created: string[] = [];
    for (const tmpl of BUILT_IN_TEMPLATES) {
      if (existing.has(tmpl.name)) continue;
      const id = newId('ls_');
      insert('loop_specs', {
        id,
        project_id: project.id,
        name: tmpl.name,
        description: tmpl.description,
        trigger_kind: tmpl.trigger_kind,
        trigger_config: JSON.stringify(tmpl.trigger_config),
        goal_template: tmpl.goal_template,
        verification: JSON.stringify(tmpl.verification),
        stop_rules: JSON.stringify(tmpl.stop_rules),
        memory_config: JSON.stringify(tmpl.memory_config),
        escalation: JSON.stringify(tmpl.escalation),
        push_mode: tmpl.push_mode,
        trust_tools: tmpl.trust_tools,
        lead_agent: tmpl.lead_agent,
        engine: tmpl.engine,
        monthly_budget_usd: tmpl.monthly_budget_usd,
        planning_gate: tmpl.planning_gate,
        is_template: 1,
        created_by: ctx.user!.id,
        created_at: now(),
        updated_at: now(),
      });
      created.push(tmpl.name);
    }
    return { created };
  });

  // Get a single spec
  get('/api/projects/:pid/loop-specs/:sid', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.project_id !== project.id) throw notFound('Loop spec not found');
    return { spec };
  });

  // Create a new spec
  post('/api/projects/:pid/loop-specs', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const body = await ctx.json();
    const triggerKind = validateTriggerKind(body.triggerKind ?? body.trigger_kind ?? 'manual');
    const triggerConfig: TriggerConfig = body.triggerConfig ?? body.trigger_config ?? {};
    if (triggerKind === 'webhook' || triggerKind === 'github_event') {
      if (!triggerConfig.secret) {
        triggerConfig.secret = crypto.randomBytes(24).toString('hex');
      }
    }
    triggerConfig.maxPerHour = Math.max(0, Math.min(100, Number(triggerConfig.maxPerHour ?? 3)));
    const id = newId('ls_');
    insert('loop_specs', {
      id,
      project_id: project.id,
      name: str(body.name, 'Name', { max: 80 }).trim(),
      description: str(body.description ?? '', 'Description', { max: 500, optional: true }).trim(),
      trigger_kind: triggerKind,
      trigger_config: JSON.stringify(triggerConfig),
      goal_template: str(body.goalTemplate ?? body.goal_template ?? '', 'Goal template', { max: 6000, optional: true }).trim(),
      verification: JSON.stringify(validateVerification(body.verification)),
      stop_rules: JSON.stringify(validateStopRules(body.stopRules ?? body.stop_rules)),
      memory_config: JSON.stringify(validateMemoryConfig(body.memoryConfig ?? body.memory_config)),
      escalation: JSON.stringify(validateEscalation(body.escalation)),
      push_mode: body.pushMode ?? body.push_mode ?? null,
      trust_tools: body.trustTools !== undefined ? (body.trustTools ? 1 : 0) : (body.trust_tools !== undefined ? Number(body.trust_tools) : null),
      lead_agent: body.leadAgent ?? body.lead_agent ?? null,
      engine: body.engine ?? null,
      monthly_budget_usd: body.monthlyBudgetUsd !== undefined ? Number(body.monthlyBudgetUsd) : null,
      planning_gate: body.planningGate ? 1 : 0,
      is_template: 0,
      created_by: ctx.user!.id,
      created_at: now(),
      updated_at: now(),
    });
    const spec = getLoopSpec(id);
    audit(ctx, 'loop_spec.create' as AuditAction, `loop_spec:${id}`, { projectId: project.id, name: spec.name });
    notifyProject(project.id, 'loop_spec.created', { id });
    return { spec };
  });

  // Update a spec
  put('/api/projects/:pid/loop-specs/:sid', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.project_id !== project.id) throw notFound('Loop spec not found');
    const body = await ctx.json();
    const p: Record<string, unknown> = { updated_at: now() };
    if (body.name !== undefined) p.name = str(body.name, 'Name', { max: 80 }).trim();
    if (body.description !== undefined) p.description = str(body.description, 'Description', { max: 500, optional: true }).trim();
    if (body.triggerKind !== undefined || body.trigger_kind !== undefined) {
      p.trigger_kind = validateTriggerKind(body.triggerKind ?? body.trigger_kind);
    }
    if (body.triggerConfig !== undefined || body.trigger_config !== undefined) {
      const tc = body.triggerConfig ?? body.trigger_config;
      if ((p.trigger_kind ?? spec.trigger_kind) === 'webhook' || (p.trigger_kind ?? spec.trigger_kind) === 'github_event') {
        if (!tc.secret) tc.secret = spec.trigger_config.secret ?? crypto.randomBytes(24).toString('hex');
      }
      tc.maxPerHour = Math.max(0, Math.min(100, Number(tc.maxPerHour ?? spec.trigger_config.maxPerHour ?? 3)));
      p.trigger_config = JSON.stringify(tc);
    }
    if (body.goalTemplate !== undefined || body.goal_template !== undefined) {
      p.goal_template = str(body.goalTemplate ?? body.goal_template, 'Goal template', { max: 6000, optional: true }).trim();
    }
    if (body.verification !== undefined) p.verification = JSON.stringify(validateVerification(body.verification));
    if (body.stopRules !== undefined || body.stop_rules !== undefined) p.stop_rules = JSON.stringify(validateStopRules(body.stopRules ?? body.stop_rules));
    if (body.memoryConfig !== undefined || body.memory_config !== undefined) p.memory_config = JSON.stringify(validateMemoryConfig(body.memoryConfig ?? body.memory_config));
    if (body.escalation !== undefined) p.escalation = JSON.stringify(validateEscalation(body.escalation));
    if (body.pushMode !== undefined || body.push_mode !== undefined) p.push_mode = body.pushMode ?? body.push_mode;
    if (body.trustTools !== undefined || body.trust_tools !== undefined) p.trust_tools = body.trustTools ? 1 : 0;
    if (body.leadAgent !== undefined || body.lead_agent !== undefined) p.lead_agent = body.leadAgent ?? body.lead_agent;
    if (body.engine !== undefined) p.engine = body.engine;
    if (body.monthlyBudgetUsd !== undefined) p.monthly_budget_usd = Number(body.monthlyBudgetUsd);
    if (body.planningGate !== undefined) p.planning_gate = body.planningGate ? 1 : 0;
    update('loop_specs', spec.id, p as Record<string, Parameters<typeof update>[2][string]>);
    const updated = getLoopSpec(spec.id);
    audit(ctx, 'loop_spec.update' as AuditAction, `loop_spec:${spec.id}`, { projectId: project.id });
    notifyProject(project.id, 'loop_spec.updated', { id: spec.id });
    return { spec: updated };
  });

  // Delete a spec
  del('/api/projects/:pid/loop-specs/:sid', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.project_id !== project.id) throw notFound('Loop spec not found');
    // Clear references before deleting (SQLite FK constraints without CASCADE).
    exec('UPDATE loop_metrics SET loop_spec_id = NULL WHERE loop_spec_id = ?', spec.id);
    exec('UPDATE workflows SET loop_spec_id = NULL WHERE loop_spec_id = ?', spec.id);
    exec('DELETE FROM loop_specs WHERE id = ?', spec.id);
    audit(ctx, 'loop_spec.delete' as AuditAction, `loop_spec:${spec.id}`, { projectId: project.id, name: spec.name });
    notifyProject(project.id, 'loop_spec.deleted', { id: spec.id });
    return { ok: true };
  });

  // Manual run from a spec (POST /api/projects/:pid/loop-specs/:sid/run)
  post('/api/projects/:pid/loop-specs/:sid/run', async (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid, 'editor');
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.project_id !== project.id) throw notFound('Loop spec not found');
    const body = await ctx.json().catch(() => ({}));
    // Check rate limit (same limit as automated triggers)
    const rateErr = checkTriggerRateLimit(spec.id);
    if (rateErr) throw badRequest(rateErr);
    const { createWorkflowFromSpec } = await import('./loop-triggers.ts');
    const workflow = await createWorkflowFromSpec(spec, ctx.user!.id, body.vars ?? {});
    recordTriggerFire(spec.id, 'manual', { triggeredBy: ctx.user!.id }, String(workflow.id));
    audit(ctx, 'session.start' as AuditAction, `workflow:${workflow.id}`, { projectId: project.id, specId: spec.id });
    return { workflow };
  });

  // Trigger history for a spec
  get('/api/projects/:pid/loop-specs/:sid/trigger-history', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.project_id !== project.id) throw notFound('Loop spec not found');
    const limit = Math.min(100, Number(ctx.query.get('limit') || 20));
    const rows = all<Row>(
      'SELECT * FROM trigger_history WHERE spec_id = ? ORDER BY fired_at DESC LIMIT ?',
      spec.id, limit,
    );
    return { history: rows };
  });

  // Per-spec metrics
  get('/api/projects/:pid/loop-specs/:sid/metrics', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const spec = getLoopSpec(ctx.params.sid);
    if (spec.project_id !== project.id) throw notFound('Loop spec not found');
    const window = Math.min(365, Math.max(1, Number(ctx.query.get('window') ?? '30')));
    return getSpecMetrics(spec.id, window);
  });

  // Save a session as a new spec
  post('/api/workflows/:id/save-as-spec', async (ctx) => {
    const { id } = ctx.params;
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
    if (!w) throw notFound('Session not found');
    requireProject(ctx, w.project_id, 'editor');
    const body = await ctx.json();
    const name = str(body.name, 'Name', { max: 80 }).trim();
    const description = str(body.description ?? '', 'Description', { max: 500, optional: true }).trim();
    const spec = saveSessionAsSpec(id, ctx.user!.id, name, description);
    notifyProject(w.project_id, 'loop_spec.created', { id: spec.id });
    return { spec };
  });

  // Per-project aggregate metrics (leaderboard)
  get('/api/projects/:pid/loop-metrics', (ctx) => {
    const { project } = requireProject(ctx, ctx.params.pid);
    const window = Math.min(365, Math.max(1, Number(ctx.query.get('window') ?? '30')));
    return getProjectMetrics(project.id, window);
  });

  // Prometheus endpoint (admin or API token with read scope)
  get('/api/metrics', (ctx) => {
    // Allow API tokens (already checked by token policy) or admin users
    if (!ctx.user?.is_admin && !ctx.apiToken) {
      throw new HttpError(403, 'Only admins or API tokens can access metrics');
    }
    const text = prometheusMetrics();
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
    });
    ctx.res.end(text);
    // res.headersSent is now true; the framework skips JSON wrapping when res.headersSent.
  });
}
