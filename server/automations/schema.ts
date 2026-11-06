import { badRequest, str } from '../util.ts';
import { validateCheckSteps, type CheckStep } from '../agent/runner-checks.ts';

export type NodeKind = 'start' | 'agent' | 'condition' | 'approval' | 'end';
export interface AutomationNode {
  id: string; kind: NodeKind; label: string; position: { x: number; y: number };
  prompt: string; model: string; agent: string; checks: CheckStep[]; maxVisits: number;
}
export interface AutomationEdge { id: string; source: string; target: string; branch: 'next' | 'yes' | 'no' }
export interface AutomationGraph {
  schemaVersion: 1; engine: 'demo' | 'codex' | 'claude-code' | 'kiro'; repoIds: string[];
  maxSteps: number; timeoutMinutes: number; budgetUsd: number | null;
  nodes: AutomationNode[]; edges: AutomationEdge[];
}
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest('Expected an object');
  return v as Record<string, unknown>;
}
function integer(v: unknown, fallback: number, min: number, max: number): number {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw badRequest(`Expected a number between ${min} and ${max}`);
  return n;
}
function id(v: unknown): string {
  if (typeof v !== 'string' || !idPattern.test(v) || ['__proto__', 'prototype', 'constructor'].includes(v)) throw badRequest('Invalid workflow node or edge ID');
  return v;
}
function checks(raw: unknown): CheckStep[] {
  try {
    const steps = validateCheckSteps(raw);
    if (steps.reduce((seconds, step) => seconds + (step.timeout ?? 300), 0) > 600) throw new Error('Checks in one task must total at most 10 minutes');
    return steps;
  } catch (e) { throw badRequest((e as Error).message); }
}

/** An allowlisted, bounded graph. Drafts may be disconnected; published versions must be executable. */
export function parseGraph(raw: unknown, publish = false): AutomationGraph {
  const g = record(raw);
  if (g.schemaVersion !== 1) throw badRequest('Unsupported workflow schema version');
  if (!['demo', 'codex', 'claude-code', 'kiro'].includes(String(g.engine))) throw badRequest('Choose a supported engine');
  if (!Array.isArray(g.nodes) || g.nodes.length > 40 || !Array.isArray(g.edges) || g.edges.length > 80) throw badRequest('A workflow supports up to 40 steps and 80 connections');
  if (Buffer.byteLength(JSON.stringify(raw)) > 140_000) throw badRequest('Workflow definition exceeds 140 KB');
  const nodes = g.nodes.map((rawNode) => {
    const n = record(rawNode); const p = record(n.position ?? { x: 0, y: 0 });
    if (!['start', 'agent', 'condition', 'approval', 'end'].includes(String(n.kind))) throw badRequest('Unsupported step type');
    if (![p.x, p.y].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000)) throw badRequest('Invalid step position');
    return {
      id: id(n.id), kind: n.kind as NodeKind, label: str(n.label, 'Step name', { max: 100 }).trim(),
      position: { x: p.x as number, y: p.y as number },
      prompt: str(n.prompt, 'Instructions', { max: 6000, optional: true }),
      model: str(n.model, 'Model', { max: 200, optional: true }),
      agent: str(n.agent, 'Agent', { max: 100, optional: true }),
      checks: checks(n.checks), maxVisits: integer(n.maxVisits, 3, 1, 10),
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  if (nodes.some((n) => !n.label)) throw badRequest('Enter a name for every step');
  if (ids.size !== nodes.length) throw badRequest('Step IDs must be unique');
  const edges = g.edges.map((rawEdge) => {
    const e = record(rawEdge);
    if (!ids.has(String(e.source)) || !ids.has(String(e.target))) throw badRequest('A connection references a missing step');
    if (!['next', 'yes', 'no'].includes(String(e.branch))) throw badRequest('Choose next, yes, or no for a connection');
    return { id: id(e.id), source: id(e.source), target: id(e.target), branch: e.branch as AutomationEdge['branch'] };
  });
  if (new Set(edges.map((e) => e.id)).size !== edges.length) throw badRequest('Connection IDs must be unique');
  if (!Array.isArray(g.repoIds) || g.repoIds.length > 20 || !g.repoIds.every((v) => typeof v === 'string' && v.length <= 100)) throw badRequest('Invalid repository selection');
  const budget = g.budgetUsd ?? null;
  if (budget !== null && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > 1000)) throw badRequest('Budget must be between 0 and 1000 USD');
  if (budget !== null && ['codex', 'kiro'].includes(String(g.engine))) throw badRequest('This engine does not report dollar cost. Use step and time limits instead.');
  const graph: AutomationGraph = {
    schemaVersion: 1, engine: g.engine as AutomationGraph['engine'], repoIds: [...new Set(g.repoIds as string[])],
    maxSteps: integer(g.maxSteps, 30, 1, 100), timeoutMinutes: integer(g.timeoutMinutes, 120, 1, 1440), budgetUsd: budget as number | null,
    nodes, edges,
  };
  if (publish) validateExecutable(graph);
  return graph;
}

export function validateExecutable(g: AutomationGraph): void {
  const starts = g.nodes.filter((n) => n.kind === 'start');
  if (starts.length !== 1 || !g.nodes.some((n) => n.kind === 'end')) throw badRequest('Add exactly one Start step and at least one End step');
  for (const n of g.nodes) {
    const out = g.edges.filter((e) => e.source === n.id);
    const branches = out.map((e) => e.branch).sort().join(',');
    const expected = n.kind === 'condition' ? 'no,yes' : n.kind === 'end' ? '' : 'next';
    if (branches !== expected) throw badRequest(`${n.label}: ${n.kind === 'condition' ? 'connect one Yes and one No path' : n.kind === 'end' ? 'End cannot have outgoing connections' : 'connect exactly one Next path'}`);
    if (n.kind === 'agent' && !n.prompt.trim()) throw badRequest(`${n.label}: enter instructions`);
    if (n.kind === 'start' && g.edges.some((e) => e.target === n.id)) throw badRequest('Start cannot have incoming connections');
  }
  const walk = (initial: string, reverse = false): Set<string> => {
    const seen = new Set<string>(); const todo = [initial];
    while (todo.length) {
      const v = todo.pop()!; if (seen.has(v)) continue; seen.add(v);
      for (const e of g.edges) if ((reverse ? e.target : e.source) === v) todo.push(reverse ? e.source : e.target);
    }
    return seen;
  };
  const reachable = walk(starts[0].id);
  const canEnd = new Set(g.nodes.filter((n) => n.kind === 'end').flatMap((n) => [...walk(n.id, true)]));
  for (const n of g.nodes) if (!reachable.has(n.id) || !canEnd.has(n.id)) throw badRequest(`${n.label}: every step must be reachable from Start and have a path to End`);
}

export function sdlcTemplate(): AutomationGraph {
  const steps: [string, NodeKind, string, string][] = [
    ['start', 'start', 'Start', ''],
    ['requirements', 'agent', 'Analyze requirements', 'Analyze {{input}}. Record requirements and acceptance criteria in artifacts/requirements.md.'],
    ['design', 'agent', 'Design solution', 'Read artifacts/requirements.md and document the implementation design in artifacts/design.md.'],
    ['code', 'agent', 'Generate code', 'Implement the requirements using artifacts/design.md. If tests previously failed, fix the failures. Do not push or deploy.'],
    ['tests', 'agent', 'Run tests', 'Inspect the implementation and run the configured verification checks. Report failures clearly. Do not push or deploy.'],
    ['passed', 'condition', 'Tests passed?', ''],
    ['review', 'agent', 'Code review', 'Review the changes against requirements and design. Fix issues and record a review in artifacts/review.md. Do not push or deploy.'],
    ['approve', 'approval', 'Approve publication', 'Review the session changes before allowing the PR step.'],
    ['pr', 'agent', 'Create pull request', 'Use portal_pr.create_pull_request to open a PR for the changes against main_v3. Never merge or deploy. Report the PR link.'],
    ['end', 'end', 'End', ''],
  ];
  const nodes = steps.map(([id, kind, label, prompt], i) => ({ id, kind, label, prompt, model: '', agent: '', checks: [], maxVisits: 3, position: { x: (i % 5) * 240, y: Math.floor(i / 5) * 200 } }));
  (nodes.find((n) => n.id === 'tests')!.checks as CheckStep[]).push({ step: 'Tests', cmd: 'npm test', timeout: 300 });
  const links: [string, string, AutomationEdge['branch']][] = [
    ['start', 'requirements', 'next'], ['requirements', 'design', 'next'], ['design', 'code', 'next'], ['code', 'tests', 'next'], ['tests', 'passed', 'next'],
    ['passed', 'review', 'yes'], ['passed', 'code', 'no'], ['review', 'approve', 'next'], ['approve', 'pr', 'next'], ['pr', 'end', 'next'],
  ];
  return { schemaVersion: 1, engine: 'codex', repoIds: [], maxSteps: 30, timeoutMinutes: 120, budgetUsd: null, nodes, edges: links.map(([source, target, branch], i) => ({ id: `edge-${i}`, source, target, branch })) };
}
