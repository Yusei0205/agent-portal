/** Reading and checking the settings a request sets on a session. */
import { type Row } from '../db.ts';
import type { Ctx } from '../http.ts';
import { getProject } from '../projects.ts';
import { requireModel } from '../models.ts';
import { HttpError, badRequest, str } from '../util.ts';
import { leadChoices } from '../kiro-agents.ts';
import { engineProvider } from '../project-aws.ts';
import { addContext } from '../session-context.ts';
import { getSettings } from '../settings.ts';
import { blockedCommand } from '../guardrails.ts';
import { readPermissionMode, log } from './store.ts';

/**
 * A check command runs on the portal server without approval and outside the agents' guard, so it may not be one the
 * guard would block for an agent (deploys, AWS writes, git push, sudo, deletes outside the work folder, curl | sh).
 */
export function checkCommandAllowed(cmd: string, label = 'Check command'): string {
  const why = cmd ? blockedCommand(cmd) : null;
  if (why) throw badRequest(`${label} is not allowed: ${why}`);
  return cmd;
}

/** The settings of a session that take a human check away from it. */
export interface SafetySettings {
  trust_tools?: number | null;
  push_mode?: string | null;
  permission_mode?: string | null;
  verify_command?: string | null;
}

/**
 * What a change turns on that removes a human check. `tokenMay` marks what an API token may still do: start or switch a
 * session to unattended (the CI use; the blocked-command lists still apply), but not trust all tools, push without
 * asking, or set a check command (a shell command the server runs without approval). A new session is compared with
 * a plain attended one using the default push mode.
 */
export function safetyRaised(before: SafetySettings | null, after: SafetySettings): { label: string; tokenMay: boolean }[] {
  const was = before ?? { trust_tools: 0, push_mode: getSettings().agents.defaultPushMode || 'never', permission_mode: 'default', verify_command: '' };
  const raised: { label: string; tokenMay: boolean }[] = [];
  if (Number(after.trust_tools ?? 0) === 1 && Number(was.trust_tools ?? 0) !== 1) raised.push({ label: '"trust all tools"', tokenMay: false });
  if (after.push_mode === 'auto' && was.push_mode !== 'auto') raised.push({ label: 'agent pushes without asking', tokenMay: false });
  if (after.permission_mode === '' && (was.permission_mode ?? '') !== '') raised.push({ label: 'running unattended', tokenMay: true });
  if (after.verify_command && after.verify_command !== (was.verify_command ?? '')) raised.push({ label: 'a check command', tokenMay: false });
  return raised;
}

/**
 * Only the person a session runs as may take a human check away from it: a session acts with its creator's identity,
 * budget and vault, so another editor must not turn on "trust all tools" for it. And a leaked API token must not be able
 * to start agents that run any command or push code without asking. Anyone with edit access may make a session safer.
 */
export function checkSafetyChange(ctx: Ctx, before: (SafetySettings & { created_by?: string }) | null, after: SafetySettings): void {
  const raised = safetyRaised(before, after);
  if (!raised.length) return;
  const notByToken = raised.filter((r) => !r.tokenMay).map((r) => r.label);
  if (ctx.apiToken && notByToken.length) throw new HttpError(403, `API tokens cannot turn on ${notByToken.join(', ')}. Do this from a signed-in browser.`);
  if (before?.created_by && before.created_by !== ctx.user!.id) {
    throw new HttpError(403, `Only the person who started this session can turn on ${raised.map((r) => r.label).join(', ')}: the session runs as them.`);
  }
}

export function readSettings(body: any, current?: Row, ctx?: { hasRepos?: boolean; isPlayground?: boolean }) {
  const num = (v: unknown, name: string, min: number, max: number, fallback: number) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
    return n;
  };
  const model = body.model === undefined || body.model === '' ? current?.model ?? 'sonnet' : requireModel(body.model);
  return {
    model,
    budget_usd: num(body.budgetUsd, 'Budget', 0.1, 1000, current?.budget_usd ?? 5),
    budget_credits: num(body.budgetCredits, 'Credit budget', 0.1, 100000, current?.budget_credits ?? 20),
    max_iterations: Math.round(num(body.maxIterations, 'Iterations', 1, 50, current?.max_iterations ?? 8)),
    verify_command: body.verifyCommand === undefined ? current?.verify_command ?? '' : checkCommandAllowed(str(body.verifyCommand, 'Check command', { max: 500, optional: true }).trim()),
    rules: body.rules === undefined ? current?.rules ?? '' : str(body.rules, 'Rules', { max: 4000, optional: true }).trim(),
    push_mode: effectivePushMode(body.pushMode, current?.push_mode, ctx?.hasRepos ?? false, ctx?.isPlayground ?? false),
    trust_tools: body.trustTools === undefined ? (current?.trust_tools ?? 0) : body.trustTools ? 1 : 0,
    permission_mode: body.permissionMode === undefined ? current?.permission_mode ?? '' : readPermissionMode(body.permissionMode),
  };
}

function readPushMode(raw: unknown, current?: string): string {
  if (raw === undefined || raw === null || raw === '') return current || getSettings().agents.defaultPushMode || 'never';
  if (!['never', 'ask', 'auto'].includes(String(raw))) throw badRequest('Agent pushes must be never, ask or auto');
  return String(raw);
}

/**
 * Determine the push mode for a new or updated session.
 * - Explicit values always win if valid.
 * - Playground sessions without an explicit value stay 'never'.
 * - On update (current defined): keep the current value exactly — never escalate.
 * - On create (current undefined): use settings default; else 'ask' if repos; else 'never'.
 */
function effectivePushMode(raw: unknown, current: string | undefined, hasRepos: boolean, isPlayground: boolean): string {
  const explicit = raw !== undefined && raw !== null && raw !== '';
  if (explicit) {
    if (!['never', 'ask', 'auto'].includes(String(raw))) throw badRequest('Agent pushes must be never, ask or auto');
    return String(raw);
  }
  // No explicit value: playground sessions stay never.
  if (isPlayground) return 'never';
  // On update (current is the existing stored value): keep it exactly — never escalate.
  if (current !== undefined) return current || 'never';
  // On create: use settings default, then repo-presence heuristic.
  const settingsDefault = getSettings().agents.defaultPushMode;
  if (settingsDefault) return settingsDefault;
  return hasRepos ? 'ask' : 'never';
}

/** True when a session on this engine runs on Kiro. */
export function isKiro(projectId: string, engine: string | null | undefined): boolean {
  try {
    return engineProvider(projectId, engine || null) === 'kiro';
  } catch {
    return false;
  }
}

/**
 * The lead agent named in a request must be able to lead on the session's engine: one of the project's enabled Kiro
 * agents on Kiro, one of its enabled .claude agents on Claude. Empty means the default.
 */
export function checkLead(project: ReturnType<typeof getProject>, raw: unknown, engine?: string | null): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return '';
  const kiro = isKiro(project.id, engine);
  const choices = leadChoices(project, kiro);
  if (!choices.some((c) => c.name === name)) {
    throw badRequest(
      kiro
        ? `"${name}" is not an enabled Kiro agent in this project. Add or enable it under Agents and skills › Kiro.`
        : `"${name}" is not an enabled agent in this project. Add or enable it under Agents and skills.`,
    );
  }
  return name;
}

/**
 * Context items sent along with a new session or an instruction (documents, notes, links, earlier results; files are
 * uploaded separately). All are checked before anything is saved, so a bad item leaves nothing half-added.
 */
export function readContextItems(raw: unknown): any[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Context must be a list');
  if (raw.length > 20) throw badRequest('Add at most 20 context items at once');
  return raw;
}

export function addContextItems(workflowId: string, user: { id: string; name: string }, items: any[]): void {
  for (const item of items) {
    const c = addContext(workflowId, user, item);
    log(workflowId, 'context', `${user.name} added “${c.title}” as context`);
  }
}

/** '' (the project's connection), 'claude' or 'kiro'; checked to be usable now. */
export function readEngine(projectId: string, raw: unknown): string {
  const engine = raw === undefined || raw === null || raw === '' ? '' : String(raw);
  if (engine) engineProvider(projectId, engine);
  return engine;
}
