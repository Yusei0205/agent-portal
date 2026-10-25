/**
 * The session options of the features that start an unattended session of their own (diagrams, generated documents,
 * presentations): which lead agent runs it and whether the agent may use tools freely ("trust all tools").
 *
 * They are the same two settings the normal session launcher has (`leadAgent`, validated by checkLead against the
 * session's engine, and `trustTools`, stored as workflows.trust_tools). Trusting tools lifts only what FR-GUARD-2 lists as
 * "blocked unless trusted"; FR-GUARD-1 commands stay blocked, and a playground session has no repository, so the trusted
 * push path never applies to it.
 *
 * A request may name both. A refresh or regenerate without them reuses what the diagram, document or presentation stored
 * the last time they were given; a loop spec that drives a refresh uses its own lead agent / trust fields.
 */
import { type Row, update } from './db.ts';
import { type Project } from './projects.ts';
import { badRequest } from './util.ts';
import { leadChoices, type LeadChoice } from './kiro-agents.ts';
import { checkLead, isKiro } from './workflows/validation.ts';
import { getLoopSpec } from './loop-specs.ts';

/** What a request said; undefined means "not given" (reuse the stored value). */
export interface RunOptionsRequest {
  leadAgent?: string;
  trustTools?: boolean;
}

export interface RunOptions {
  leadAgent: string;
  trustTools: boolean;
  /** Why a stored or default choice was replaced (the lead agent is not available any more). */
  warnings: string[];
}

/** The pickers' data for a project's list responses. */
export function runOptionChoices(project: Project) {
  const kiro = isKiro(project.id, null);
  const leadAgents: LeadChoice[] = leadChoices(project, kiro);
  const configured = project.default_lead_agent || '';
  return {
    engine: kiro ? 'kiro' : 'claude',
    leadAgents,
    defaultLeadAgent: leadAgents.some((c) => c.name === configured) ? configured : '',
    trustAllTools: false,
  };
}

/** Read and check the two fields of a request body. A lead agent that cannot lead on the engine is a 400, as in the launcher. */
export function readRunOptionsRequest(project: Project, body: any): RunOptionsRequest {
  const out: RunOptionsRequest = {};
  const b = body && typeof body === 'object' ? body : {};
  if (b.leadAgent !== undefined && b.leadAgent !== null) {
    if (typeof b.leadAgent !== 'string') throw badRequest('leadAgent must be text');
    out.leadAgent = checkLead(project, b.leadAgent, null);
  }
  const trust = b.trustAllTools !== undefined ? b.trustAllTools : b.trustTools;
  if (trust !== undefined && trust !== null) {
    if (typeof trust !== 'boolean') throw badRequest('trustAllTools must be true or false');
    out.trustTools = trust;
  }
  return out;
}

function usable(project: Project, name: string): boolean {
  return Boolean(name) && leadChoices(project, isKiro(project.id, null)).some((c) => c.name === name);
}

/**
 * Decide the lead agent and trust flag of a new session. Precedence: the request, then the loop spec that drives it,
 * then what the record stored, then the project's default lead agent (lead agent) or off (trust). A spec, stored or
 * project default lead agent that is not available any more is skipped with a warning; the session still starts.
 */
export function resolveRunOptions(project: Project, i: { request?: RunOptionsRequest; specId?: string | null; stored?: Row | null }): RunOptions {
  const warnings: string[] = [];
  let spec: { lead_agent: string | null; trust_tools: number | null } | null = null;
  if (i.specId) {
    try {
      spec = getLoopSpec(i.specId);
    } catch {
      spec = null;
    }
  }
  let leadAgent = '';
  if (i.request?.leadAgent !== undefined) leadAgent = i.request.leadAgent;
  else {
    const candidates: { name: string; from: string }[] = [
      { name: String(spec?.lead_agent ?? ''), from: 'the loop spec' },
      { name: String(i.stored?.lead_agent ?? ''), from: 'this item' },
    ];
    let settled = false;
    for (const c of candidates) {
      if (!c.name) continue;
      if (usable(project, c.name)) {
        leadAgent = c.name;
        settled = true;
        break;
      }
      warnings.push(`The lead agent "${c.name}" chosen on ${c.from} is not available any more, so the default agent leads.`);
    }
    if (!settled) {
      const def = project.default_lead_agent || '';
      leadAgent = usable(project, def) ? def : '';
    }
  }
  let trustTools = false;
  if (i.request?.trustTools !== undefined) trustTools = i.request.trustTools;
  else if (spec && spec.trust_tools !== null && spec.trust_tools !== undefined) trustTools = Boolean(spec.trust_tools);
  else trustTools = Boolean(i.stored?.trust_tools);
  return { leadAgent, trustTools, warnings };
}

/** Remember what a request chose on the record, so later refreshes reuse it. Does nothing when the request gave neither. */
export function storeRunOptions(table: 'diagrams' | 'generated_docs' | 'presentations', id: string, request: RunOptionsRequest | undefined): void {
  if (!request || (request.leadAgent === undefined && request.trustTools === undefined)) return;
  const patch: Record<string, string | number> = {};
  if (request.leadAgent !== undefined) patch.lead_agent = request.leadAgent;
  if (request.trustTools !== undefined) patch.trust_tools = request.trustTools ? 1 : 0;
  update(table, id, patch);
}

/** The fields every diagram, document and presentation view carries. */
export function runOptionsView(row: Row) {
  return { lead_agent: String(row.lead_agent ?? ''), trust_all_tools: Boolean(row.trust_tools) };
}
