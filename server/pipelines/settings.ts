/**
 * Pipeline monitor settings: one JSON document per project under the settings key `pipelines.settings.<projectId>`.
 * Every change is written to the audit log.
 */

import { getDb } from '../db.ts';
import { getSetting, setSetting } from '../settings.ts';
import { getAuditRepository } from '../repositories/audit.ts';
import { badRequest } from '../util.ts';

export interface PipelineSettings { deploy_workflows: string[]; alert_branches: string[] }
export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = { deploy_workflows: [], alert_branches: [] };

const MAX_ENTRIES = 50;
const MAX_CHARS = 100;
const FIELDS = ['deploy_workflows', 'alert_branches'] as const;

const settingsKey = (projectId: string) => `pipelines.settings.${projectId}`;

function list(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest(`${name} must be a list of strings`);
  const out = [...new Set((v as string[]).map((s) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()).filter(Boolean))];
  if (out.length > MAX_ENTRIES) throw badRequest(`${name} can have at most ${MAX_ENTRIES} entries`);
  if (out.some((s) => s.length > MAX_CHARS)) throw badRequest(`${name} entries can have at most ${MAX_CHARS} characters`);
  return out;
}

export async function getPipelineSettings(projectId: string): Promise<PipelineSettings> {
  const out: PipelineSettings = { deploy_workflows: [], alert_branches: [] };
  const raw = getSetting(getDb(), settingsKey(projectId));
  if (!raw) return out;
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    for (const f of FIELDS) if (doc[f] !== undefined) out[f] = list(doc[f], f);
    return out;
  } catch {
    return { deploy_workflows: [], alert_branches: [] }; // a corrupt document falls back to the defaults
  }
}

export async function savePipelineSettings(
  projectId: string,
  patch: Partial<PipelineSettings>,
  actor: { actorId: string | null; ip: string | null },
): Promise<PipelineSettings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw badRequest('Settings must be an object');
  const current = await getPipelineSettings(projectId);
  const next: PipelineSettings = { ...current };
  const p = patch as Record<string, unknown>;
  for (const f of FIELDS) if (p[f] !== undefined) next[f] = list(p[f], f);
  await setSetting(getDb(), settingsKey(projectId), JSON.stringify(next));
  await getAuditRepository().append({
    actorId: actor.actorId,
    action: 'pipelines.settings.update',
    target: projectId,
    detail: { fields: FIELDS.filter((f) => p[f] !== undefined) },
    ip: actor.ip,
  });
  return next;
}

export function isDeployWorkflow(s: PipelineSettings, workflowName: string): boolean {
  const name = workflowName.toLowerCase();
  if (s.deploy_workflows.length === 0) return name.includes('deploy');
  return s.deploy_workflows.some((w) => w.toLowerCase() === name);
}

export function isAlertingBranch(s: PipelineSettings, branch: string, defaultBranch: string | null): boolean {
  return (defaultBranch !== null && branch === defaultBranch) || s.alert_branches.includes(branch);
}
