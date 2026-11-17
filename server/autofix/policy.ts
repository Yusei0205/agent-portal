/**
 * Auto-fix autonomy policy and kill switch.
 *
 * The policy is one JSON document per project under the settings key
 * `autofix.policy.<projectId>`; pause flags live under `autofix.paused.global`
 * and `autofix.paused.<projectId>`. Every change is written to the audit log.
 */

import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getAuditRepository } from '../repositories/audit.ts';
import { badRequest } from '../util.ts';

export type AutofixMode = 'off' | 'propose' | 'draft_pr';

export interface AutofixPolicy {
  mode: AutofixMode;
  classes: string[];
  branches: { default_branch: boolean; portal_prs: boolean; extra: string[] };
  protected_paths: string[];
  limits: {
    max_open_prs: number;
    max_attempts: number;
    max_cost_per_finding_usd: number;
    max_cost_per_day_usd: number;
    cooldown_minutes: number;
    max_files: number;
    max_lines: number;
  };
  verify: { command: string; quick_commands: string[] };
  /** User id the fix sessions run as; set to the enabling admin on first enable. */
  run_as: string;
  engine: string;
}

export interface AuditActor { actorId?: string | null; ip?: string | null }

const MODES: AutofixMode[] = ['off', 'propose', 'draft_pr'];
export const AUTOFIX_ENGINES = ['demo', 'claude-code', 'kiro', 'codex'];

const REQUIRED_PROTECTED_PATHS = [
  '.github/workflows/**',
  'infra/**',
  '**/.env*',
  '**/*.pem',
  'package-lock.json',
  '**/package-lock.json',
];

export const DEFAULT_POLICY: AutofixPolicy = {
  mode: 'off',
  classes: ['lint', 'tests', 'types', 'build'],
  branches: { default_branch: true, portal_prs: true, extra: [] },
  protected_paths: [...REQUIRED_PROTECTED_PATHS],
  limits: {
    max_open_prs: 3,
    max_attempts: 2,
    max_cost_per_finding_usd: 2,
    max_cost_per_day_usd: 10,
    cooldown_minutes: 60,
    max_files: 10,
    max_lines: 300,
  },
  verify: { command: '', quick_commands: [] },
  run_as: '',
  engine: 'claude-code',
};

const policyKey = (projectId: string) => `autofix.policy.${projectId}`;
const pausedKey = (scope: string) => `autofix.paused.${scope}`;

function clone(p: AutofixPolicy): AutofixPolicy {
  return JSON.parse(JSON.stringify(p)) as AutofixPolicy;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > 500)) throw badRequest(`${name} must be a list of strings`);
  return [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))];
}

function posInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw badRequest(`${name} must be a positive integer`);
  return v;
}

function posNum(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw badRequest(`${name} must be a positive number`);
  return v;
}

/** Merge a validated patch onto a policy; throws a 400 on bad input. */
function applyPatch(base: AutofixPolicy, patch: Partial<AutofixPolicy>): AutofixPolicy {
  const out = clone(base);
  const p = patch as Record<string, unknown>;
  if (p.mode !== undefined) {
    if (!MODES.includes(p.mode as AutofixMode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);
    out.mode = p.mode as AutofixMode;
  }
  if (p.classes !== undefined) out.classes = strList(p.classes, 'classes');
  if (p.branches !== undefined) {
    if (!isObj(p.branches)) throw badRequest('branches must be an object');
    const b = p.branches;
    if (b.default_branch !== undefined) {
      if (typeof b.default_branch !== 'boolean') throw badRequest('branches.default_branch must be a boolean');
      out.branches.default_branch = b.default_branch;
    }
    if (b.portal_prs !== undefined) {
      if (typeof b.portal_prs !== 'boolean') throw badRequest('branches.portal_prs must be a boolean');
      out.branches.portal_prs = b.portal_prs;
    }
    if (b.extra !== undefined) out.branches.extra = strList(b.extra, 'branches.extra');
  }
  if (p.protected_paths !== undefined) out.protected_paths = strList(p.protected_paths, 'protected_paths');
  out.protected_paths = [...new Set([...REQUIRED_PROTECTED_PATHS, ...out.protected_paths])];
  if (p.limits !== undefined) {
    if (!isObj(p.limits)) throw badRequest('limits must be an object');
    const l = p.limits;
    for (const k of Object.keys(l)) {
      if (!(k in DEFAULT_POLICY.limits)) throw badRequest(`Unknown limit ${k}`);
    }
    for (const k of ['max_open_prs', 'max_attempts', 'cooldown_minutes', 'max_files', 'max_lines'] as const) {
      if (l[k] !== undefined) out.limits[k] = posInt(l[k], `limits.${k}`);
    }
    for (const k of ['max_cost_per_finding_usd', 'max_cost_per_day_usd'] as const) {
      if (l[k] !== undefined) out.limits[k] = posNum(l[k], `limits.${k}`);
    }
  }
  if (p.verify !== undefined) {
    if (!isObj(p.verify)) throw badRequest('verify must be an object');
    if (p.verify.command !== undefined) {
      if (typeof p.verify.command !== 'string' || p.verify.command.length > 1000) throw badRequest('verify.command must be a string');
      out.verify.command = p.verify.command;
    }
    if (p.verify.quick_commands !== undefined) out.verify.quick_commands = strList(p.verify.quick_commands, 'verify.quick_commands');
  }
  if (p.run_as !== undefined) {
    if (typeof p.run_as !== 'string' || p.run_as.length > 100) throw badRequest('run_as must be a user id');
    out.run_as = p.run_as;
  }
  if (p.engine !== undefined) {
    if (typeof p.engine !== 'string' || !AUTOFIX_ENGINES.includes(p.engine)) throw badRequest(`engine must be one of ${AUTOFIX_ENGINES.join(', ')}`);
    out.engine = p.engine;
  }
  return out;
}

export async function getAutofixPolicy(projectId: string): Promise<AutofixPolicy> {
  const raw = getSetting(getDb(), policyKey(projectId));
  if (!raw) return clone(DEFAULT_POLICY);
  try {
    return applyPatch(DEFAULT_POLICY, JSON.parse(raw) as Partial<AutofixPolicy>);
  } catch {
    return clone(DEFAULT_POLICY); // a corrupt document must never enable anything
  }
}

export async function saveAutofixPolicy(
  projectId: string,
  patch: Partial<AutofixPolicy>,
  actor: AuditActor = {},
): Promise<AutofixPolicy> {
  const current = await getAutofixPolicy(projectId);
  const next = applyPatch(current, patch);
  // The first time an admin turns auto-fix on, fix sessions run as that admin.
  if (next.mode !== 'off' && !next.run_as && actor.actorId) next.run_as = actor.actorId;
  await setSetting(getDb(), policyKey(projectId), JSON.stringify(next));
  await getAuditRepository().append({
    actorId: actor.actorId ?? null,
    action: 'autofix.policy.update',
    target: projectId,
    detail: { mode: next.mode, previous_mode: current.mode, fields: Object.keys(patch) },
    ip: actor.ip ?? null,
  });
  return next;
}

export async function isPaused(projectId: string): Promise<boolean> {
  const db = getDb();
  return getSetting(db, pausedKey('global')) === '1' || getSetting(db, pausedKey(projectId)) === '1';
}

export async function setPaused(scope: 'global' | string, paused: boolean, actor: AuditActor = {}): Promise<void> {
  await setSetting(getDb(), pausedKey(scope), paused ? '1' : '0');
  await getAuditRepository().append({
    actorId: actor.actorId ?? null,
    action: 'autofix.pause',
    target: scope,
    detail: { paused },
    ip: actor.ip ?? null,
  });
}
