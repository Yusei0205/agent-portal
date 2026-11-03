/**
 * Loop triggers: start a loop session from a loop spec without a person pressing a button.
 *
 * Kinds handled here:
 *  - manual:   "Run now" (a signed-in person).
 *  - cron:     a 5-field cron expression, in UTC.
 *  - interval: every N minutes (at least 5).
 *  - webhook:  a POST signed with the spec's webhook secret (HMAC-SHA256 of the body).
 *
 * Time triggers are checked once a minute by the `loop-triggers` job (scheduled-jobs.ts: EventBridge Scheduler on
 * AWS, a timer locally). Nothing is kept between ticks except the runs recorded for the spec, so a missed tick only
 * delays a firing by a minute.
 *
 * Safety rules for sessions started this way (nobody is watching when they start):
 *  - They run as the person who set the trigger up (`runAs` in the trigger config), and only while that person is
 *    still an editor or owner of the project. If not, the trigger does nothing.
 *  - "Trust all tools" is never on, so a tool that needs approval waits in the inbox instead of running.
 *  - A spec fires at most `maxPerHour` times an hour (default 3) and never while its previous session is still going.
 */
import crypto from 'node:crypto';
import { getLoopSpecsRepository } from './repositories/loop-specs.ts';
import type { LoopSpecRecord, LoopRunRecord } from './repositories/loop-specs.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getProjectRepository } from './repositories/projects.ts';
import { getGitReposRepository } from './repositories/git-repos.ts';
import { newLoopState } from './workflows/loop.ts';
import { startRun } from './workflows/driver.ts';
import { requestRepoPrep } from './agent/repo-prep.ts';
import { emit } from './events.ts';
import { generateId, now, parseJson } from './util.ts';

const GOAL_MAX_CHARS = 8_000;
const MIN_INTERVAL_MINUTES = 5;
const DEFAULT_MAX_PER_HOUR = 3;
const ENGINES = ['demo', 'claude-code', 'kiro'];

// ── Cron ─────────────────────────────────────────────────────────────────────

function parseCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a valid cron value`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error('A cron step must be at least 1');
    let lo: number; let hi: number;
    if (m[1] === '*') { lo = min; hi = max; }
    else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); }
    else { lo = Number(m[1]); hi = m[2] ? max : lo; }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** A matcher for a 5-field cron expression (minute hour day-of-month month day-of-week; Sunday is 0), in UTC. */
export function parseCron(expr: string): (d: Date) => boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has 5 fields: minute hour day-of-month month day-of-week');
  const [mi, ho, dom, mo, dow] = parts;
  const mins = parseCronField(mi, 0, 59);
  const hours = parseCronField(ho, 0, 23);
  const doms = parseCronField(dom, 1, 31);
  const months = parseCronField(mo, 1, 12);
  const dows = parseCronField(dow.replace(/\b7\b/g, '0'), 0, 6);
  const domAny = dom === '*';
  const dowAny = dow === '*';
  return (d: Date) => {
    if (!mins.has(d.getUTCMinutes()) || !hours.has(d.getUTCHours()) || !months.has(d.getUTCMonth() + 1)) return false;
    const domOk = doms.has(d.getUTCDate());
    const dowOk = dows.has(d.getUTCDay());
    // Like classic cron: when both day fields are restricted, either one matching is enough.
    if (!domAny && !dowAny) return domOk || dowOk;
    return domOk && dowOk;
  };
}

/** Null when the trigger setup is fine; otherwise the reason to show. */
export function triggerProblem(type: string, config: Record<string, unknown>): string | null {
  if (type === 'cron') {
    const expr = typeof config.cron === 'string' ? config.cron : '';
    if (!expr.trim()) return 'Give a cron expression (for example "0 9 * * 1-5" for 09:00 UTC on weekdays).';
    try {
      parseCron(expr);
      // Firing every minute is almost certainly a mistake for an agent run.
      if (/^\*(\/1)?\s/.test(expr.trim())) return 'A cron trigger cannot fire every minute. Use a longer gap.';
    } catch (e) { return (e as Error).message; }
  }
  if (type === 'interval') {
    const n = Number(config.everyMinutes);
    if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES) return `An interval trigger needs "everyMinutes" of at least ${MIN_INTERVAL_MINUTES}.`;
  }
  const per = config.maxPerHour;
  if (per !== undefined && (!Number.isFinite(Number(per)) || Number(per) < 1 || Number(per) > 60)) return '"maxPerHour" must be between 1 and 60.';
  if (config.engine !== undefined && !ENGINES.includes(String(config.engine))) return `"engine" must be one of ${ENGINES.join(', ')}.`;
  return null;
}

// ── Webhook ──────────────────────────────────────────────────────────────────

export function newWebhookSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** True when `signature` ("sha256=<hex>") is the HMAC-SHA256 of the raw body under the secret. */
export function webhookSignatureOk(rawBody: Buffer | undefined, signature: string | undefined, secret: string): boolean {
  if (!rawBody || !signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Reads a webhook request body (at most 64 KB): the raw bytes that were signed, and the JSON in them (undefined if not JSON). */
export function readWebhookBody(req: NodeJS.ReadableStream, limit = 65_536): Promise<{ raw: Buffer; json: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let json: unknown;
      try { json = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { json = undefined; }
      resolve({ raw, json });
    });
    req.on('error', reject);
  });
}

/** The values in a webhook body that goal templates can use as {{name}} (top level and one level down; short text only). */
export function webhookVars(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown): void => {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v).slice(0, 500);
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_]{1,40}$/.test(k2)) put(`${k}.${k2}`, v2);
      }
    } else put(k, v);
  }
  return out;
}

// ── Firing ───────────────────────────────────────────────────────────────────

export function fillGoal(template: string, vars: Record<string, string>): string {
  const all: Record<string, string> = { date: now().slice(0, 10), ...vars };
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, k: string) => (k in all ? all[k] : m));
}

export type FireResult =
  | { ok: true; workflowId: string; runId: string; goal: string; run: LoopRunRecord }
  | { ok: false; reason: string; status: number };

export interface FireOptions {
  source: 'manual' | 'cron' | 'interval' | 'webhook';
  vars?: Record<string, string>;
  /** Who the session runs as, for a manual run (a time or webhook trigger uses the person who set it up). */
  userId?: string;
  /** The project to run in, for a built-in spec (a project's own spec runs in its project). */
  projectId?: string;
}

const ACTIVE = new Set(['pending', 'running']);

/** Starts a loop session from the spec, unless a rule says not to. */
export async function fireLoopSpec(spec: LoopSpecRecord, opts: FireOptions): Promise<FireResult> {
  const projectId = spec.project_id ?? opts.projectId;
  if (!projectId) return { ok: false, status: 400, reason: 'A built-in spec needs a project to run in.' };
  if (!spec.enabled) return { ok: false, status: 400, reason: 'This loop spec is disabled.' };
  const config = parseJson<Record<string, unknown>>(spec.trigger_config, {});
  const stop = parseJson<Record<string, unknown>>(spec.stop_config, {});
  const specs = getLoopSpecsRepository();

  const runAs = opts.source === 'manual' ? opts.userId : typeof config.runAs === 'string' ? config.runAs : undefined;
  if (!runAs) return { ok: false, status: 409, reason: 'This trigger has no owner. Save the spec again from a signed-in browser to set one.' };
  const role = await getProjectRepository().roleOf(projectId, runAs);
  if (role !== 'owner' && role !== 'editor') {
    return { ok: false, status: 403, reason: 'The person who set this trigger up no longer has edit access to the project.' };
  }

  const sessions = getSessionsRepository();
  // A trigger (nobody watching) does not start while the previous session of the spec is still going, and not more
  // often than the hourly limit. A person pressing "Run now" is not held back by either.
  if (opts.source !== 'manual') {
    const recent = await specs.listRunsBySpec(spec.id, 100);
    const last = recent[0];
    if (last?.last_workflow_id) {
      const prev = await sessions.getWorkflowById(last.last_workflow_id);
      if (prev && ACTIVE.has(String(prev.status))) return { ok: false, status: 409, reason: 'The previous session of this spec is still running.' };
    }
    const maxPerHour = Math.min(60, Math.max(1, Number(config.maxPerHour ?? DEFAULT_MAX_PER_HOUR) || DEFAULT_MAX_PER_HOUR));
    const hourAgo = Date.now() - 3_600_000;
    if (recent.filter((r) => Date.parse(r.started_at) >= hourAgo).length >= maxPerHour) {
      return { ok: false, status: 429, reason: `This spec already started ${maxPerHour} session(s) in the last hour.` };
    }
  }

  // The goal: the template (with the trigger's values filled in) and the spec's rules.
  let goal = fillGoal(spec.goal_template || spec.name, opts.vars ?? {});
  if (spec.rules?.trim()) goal += `\n\nRules for this session:\n${spec.rules.trim()}`;
  goal = goal.slice(0, GOAL_MAX_CHARS);

  let loopState: string;
  try {
    loopState = newLoopState(stop.stopRules ?? stop, { checks: stop.checks });
  } catch (e) {
    return { ok: false, status: 400, reason: `The spec's checks are not allowed: ${(e as Error).message}` };
  }

  // Only repositories that belong to the project.
  const wanted = Array.isArray(config.repoIds) ? config.repoIds.map(String) : [];
  let repoIds: string[] = [];
  if (wanted.length) {
    const valid = new Set((await getGitReposRepository().listByProject(projectId)).map((r) => r.id));
    repoIds = wanted.filter((id) => valid.has(id));
  }

  const id = generateId();
  const ts = now();
  const engine = ENGINES.includes(String(config.engine)) ? String(config.engine) : 'demo';
  await sessions.createWorkflow({
    id, project_id: projectId, goal, status: 'pending', engine,
    trust_tools: 0,
    lead_agent: typeof config.leadAgent === 'string' ? config.leadAgent : null,
    workspace_id: typeof config.workspaceId === 'string' ? config.workspaceId : null,
    output_files_enabled: 0, repo_ids: JSON.stringify(repoIds),
    iteration_count: 0, max_iterations: spec.max_iterations,
    credential_id: typeof config.credentialId === 'string' ? config.credentialId : null,
    model: typeof config.model === 'string' ? config.model : '',
    created_by: runAs, created_at: ts, updated_at: ts,
  });
  await sessions.updateWorkflow(id, { loop_state: loopState, updated_at: ts });

  const runId = generateId();
  const loopRun = await specs.createRun({
    id: runId, spec_id: spec.id, status: 'running', iteration: 0,
    last_workflow_id: id, started_at: ts, finished_at: null,
  });
  emit(projectId, { type: 'workflow.created', workflowId: id });
  if (repoIds.length) await requestRepoPrep(id).catch((e) => console.error('[loop-trigger] repo prep failed:', e));

  try {
    await startRun(id);
  } catch (e) {
    const reason = `The loop trigger could not start the session: ${String((e as { message?: string })?.message ?? e).slice(0, 300)}`;
    await sessions.updateWorkflow(id, { status: 'paused', stop_reason: reason, updated_at: now() });
    emit(projectId, { type: 'workflow.updated', workflowId: id, status: 'paused' });
    return { ok: false, status: 409, reason };
  }
  return { ok: true, workflowId: id, runId, goal, run: loopRun };
}

// ── Time triggers ────────────────────────────────────────────────────────────

/** True when a spec with a time trigger is due at `at`, given when it last started a session (ms; 0 for never). */
export function timeTriggerDue(spec: Pick<LoopSpecRecord, 'trigger_type' | 'trigger_config' | 'created_at'>, at: Date, lastStartedMs: number): boolean {
  const config = parseJson<Record<string, unknown>>(spec.trigger_config, {});
  if (spec.trigger_type === 'interval') {
    const every = Number(config.everyMinutes) * 60_000;
    if (!Number.isFinite(every) || every < MIN_INTERVAL_MINUTES * 60_000) return false;
    return at.getTime() - (lastStartedMs || Date.parse(spec.created_at) || 0) >= every;
  }
  if (spec.trigger_type === 'cron') {
    let matches: (d: Date) => boolean;
    try { matches = parseCron(String(config.cron ?? '')); } catch { return false; }
    // This minute and the one before it, so a tick that ran a little late does not skip a firing.
    for (const back of [0, 1]) {
      const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000 - back * 60_000);
      if (matches(minute) && lastStartedMs < minute.getTime()) return true;
    }
  }
  return false;
}

/** Fires every enabled cron/interval spec that is due. Called once a minute. Returns what it started. */
export async function runDueTriggers(at: Date = new Date()): Promise<Array<{ specId: string; result: FireResult }>> {
  const fired: Array<{ specId: string; result: FireResult }> = [];
  const specs = getLoopSpecsRepository();
  for (const project of await getProjectRepository().listProjects()) {
    let list: LoopSpecRecord[];
    try { list = await specs.listSpecsByProject(project.id); } catch (e) { console.error('[loop-trigger] list failed:', e); continue; }
    for (const spec of list) {
      if (!spec.enabled || spec.is_builtin || spec.project_id !== project.id) continue;
      if (spec.trigger_type !== 'cron' && spec.trigger_type !== 'interval') continue;
      try {
        const lastRun = await specs.getLastRunBySpec(spec.id);
        if (!timeTriggerDue(spec, at, lastRun ? Date.parse(lastRun.started_at) : 0)) continue;
        const result = await fireLoopSpec(spec, { source: spec.trigger_type });
        if (!result.ok) console.warn(`[loop-trigger] ${spec.name}: ${result.reason}`);
        fired.push({ specId: spec.id, result });
      } catch (e) {
        console.error(`[loop-trigger] ${spec.id} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
  return fired;
}
