/** Auto-fix triage: decides whether a finding may proceed to a fix attempt. Pure, no I/O. */

import path from 'node:path';
import type { AutofixFinding } from '../repositories/autofix-findings.ts';
import type { AutofixPolicy } from './policy.ts';

export interface TriageContext {
  paused: boolean;
  openPrCount: number;
  costTodayUsd: number;
  defaultBranch: string | null;
  portalPrBranches: string[];
  now: Date;
}

/** deferred = stays `new` and is picked up later; suppressed = a policy decision that will not change on its own. */
export type TriageDecision =
  | { decision: 'triaged' }
  | { decision: 'deferred'; reason: string }
  | { decision: 'suppressed'; reason: string }
  | { decision: 'needs_human'; reason: string };

function branchEligible(f: AutofixFinding, p: AutofixPolicy, ctx: TriageContext): boolean {
  // A finding with no branch is treated as being on the default branch.
  if (f.branch === null) return p.branches.default_branch;
  if (p.branches.extra.some(g => path.posix.matchesGlob(f.branch as string, g))) return true;
  if (ctx.defaultBranch !== null && f.branch === ctx.defaultBranch) return p.branches.default_branch;
  if (ctx.portalPrBranches.includes(f.branch)) return p.branches.portal_prs;
  return false;
}

export function triage(f: AutofixFinding, p: AutofixPolicy, ctx: TriageContext): TriageDecision {
  if (p.mode === 'off') return { decision: 'suppressed', reason: 'auto-fix mode is off' };
  if (ctx.paused) return { decision: 'deferred', reason: 'auto-fix is paused' };
  if (!p.classes.includes(f.kind)) return { decision: 'suppressed', reason: `class '${f.kind}' is not allowed by policy` };
  if (!branchEligible(f, p, ctx)) return { decision: 'suppressed', reason: f.branch === null ? 'no branch recorded and the default branch is not eligible' : `branch '${f.branch}' is not eligible` };
  if (f.cooldown_until && new Date(f.cooldown_until).getTime() > ctx.now.getTime()) {
    return { decision: 'deferred', reason: `cooldown until ${f.cooldown_until}` };
  }
  if (f.attempts >= p.limits.max_attempts) return { decision: 'needs_human', reason: `${f.attempts} attempts reached the limit of ${p.limits.max_attempts}` };
  if (ctx.openPrCount >= p.limits.max_open_prs) return { decision: 'deferred', reason: `open PR cap of ${p.limits.max_open_prs} reached` };
  if (ctx.costTodayUsd >= p.limits.max_cost_per_day_usd) return { decision: 'deferred', reason: 'daily cost cap reached' };
  if (f.cost_usd >= p.limits.max_cost_per_finding_usd) return { decision: 'deferred', reason: 'per-finding cost cap reached' };
  return { decision: 'triaged' };
}
