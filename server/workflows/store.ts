/** Shared state and helpers of workflow sessions: the row, its history log, the check command and the budget test. */
import { spawn } from 'node:child_process';
import { one, run as exec, update, type Row } from '../db.ts';
import { notifyProject } from '../projects.ts';
import { badRequest, notFound, now } from '../util.ts';
import { view } from './views.ts';

export const OPEN = ['running'];

/** Budget of a single run, whose follow-ups are held to it (a session's own default is $5). */
export const SINGLE_RUN_BUDGET_USD = 25;

export const REOPENABLE = ['done', 'blocked', 'paused', 'stopped', 'failed'];

/** Workflow ids with a driver loop in this process, and the run each is waiting on. */
export const driving = new Map<string, { runId: string | null }>();

export function getWorkflow(id: string): Row {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  if (!w) throw notFound();
  return w;
}

/** A single run is a session limited to one iteration. */
export function isSingleRun(w: Row): boolean {
  return Number(w.max_iterations) === 1;
}

/** '' (autonomous: tools are allowed except the blocked commands) or a mode in which a person approves tools. */
export function readPermissionMode(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (!['default', 'acceptEdits', 'plan'].includes(String(raw))) throw badRequest('Permission mode must be default, acceptEdits or plan');
  return String(raw);
}

export function patch(id: string, p: Record<string, string | number | null>): Row {
  update('workflows', id, { ...p, updated_at: now() });
  const w = getWorkflow(id);
  notifyProject(w.project_id, 'workflow.updated', view(w));
  return w;
}

export function log(workflowId: string, kind: string, body: string, extra: { runId?: string | null; data?: unknown; consumed?: boolean } = {}): void {
  exec(
    'INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    workflowId,
    kind,
    extra.runId ?? null,
    body,
    JSON.stringify(extra.data ?? {}),
    extra.consumed ? 1 : 0,
    now(),
  );
  const w = getWorkflow(workflowId);
  notifyProject(w.project_id, 'workflow.updated', view(w));
}

function runCheck(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Only the basics of the environment: a check must not see the portal's keys.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AWS_|ANTHROPIC_|PORTAL_|GITHUB_|GH_)/i.test(k)) env[k] = v;
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-6000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      out += '\n[the check took longer than 5 minutes and was stopped]';
      child.kill();
    }, 5 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not start the check: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().slice(-4000) });
    });
  });
}

/**
 * Why a session may not start another iteration, or ''. Dollars and Kiro credits are capped separately: a project can
 * switch providers mid-session, and each budget only counts what was billed in its own unit.
 */
export function overBudget(w: Row): string {
  if (w.spent_usd >= w.budget_usd) return `Reached the budget of $${Number(w.budget_usd).toFixed(2)}. Raise the budget to go on.`;
  if (w.budget_credits > 0 && w.spent_credits >= w.budget_credits) return `Reached the budget of ${w.budget_credits} Kiro credits (${Number(w.spent_credits).toFixed(2)} used). Raise the credit budget to go on.`;
  return '';
}
