/**
 * Session quality scores from AgentCore Evaluations.
 *
 * AgentCore's Evaluate API scores an agent session from OpenTelemetry spans (Strands format). The runners wrap CLIs (Claude Code,
 * Codex, Kiro, Cursor) and do not emit spans, so the portal builds them from the saved transcript: each turn becomes a trace with
 * the person's message, the agent's tool calls and results, and its final answer. The evaluators then judge the whole session.
 *
 *   POST /api/agentcore/evals  { workflowId } | { recent: n }   score one session, or the n latest finished ones   (admin)
 *   GET  /api/agentcore/evals                                    the scored sessions, newest first                  (admin)
 *   PUT  /api/agentcore/evals  { samplePercent }                  share of finished sessions scored automatically   (admin)
 *
 * Cost: a few built-in evaluators per session (priced per token, see the AgentCore pricing page). Automatic scoring is off (0%)
 * until an admin sets a percentage, and at most MAX_AUTO_PER_PASS sessions are scored per minute.
 */

import { createHash } from 'node:crypto';
import { router, sendJson, requireAuth } from './http.ts';
import type { PortalRequest, PortalResponse } from './http.ts';
import { getDb } from './db.ts';
import { getSetting, setSetting } from './settings.ts';
import { getSessionsRepository } from './repositories/sessions.ts';
import { getStatsRepository } from './repositories/stats.ts';
import type { TranscriptRow } from './repositories/sessions.ts';

/** Built-in evaluators that fit a coding agent: did it reach the goal, did it pick and fill in tools correctly, was it helpful. */
export const EVALUATORS = ['Builtin.GoalSuccessRate', 'Builtin.ToolSelectionAccuracy', 'Builtin.ToolParameterAccuracy', 'Builtin.Helpfulness'] as const;
/** A long session is scored on its first and last calls: every chat span repeats its history, so the cost grows with the square. */
const MAX_TOOL_CALLS = 30;
const MAX_TEXT = 3000;
const MAX_TOOL_OUTPUT = 500;
/** How many earlier events each chat span carries. */
const HISTORY_WINDOW = 6;
const MAX_AUTO_PER_PASS = 2;
const INDEX_KEY = 'agentcore.eval.index';
const SAMPLE_KEY = 'agentcore.eval.sample_percent';
const MIN_IDLE_MIN = 5;

type Span = Record<string, unknown>;

export interface SpanBuild { spans: Span[]; turns: number; toolCalls: number }

const hex = (s: string, n: number): string => createHash('sha256').update(s).digest('hex').slice(0, n);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [cut]` : s);
const nano = (iso: string): number => (Date.parse(iso) || Date.now()) * 1e6;
const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; } };

interface Turn { runId: string; user: string; startedAt: string; calls: Array<{ id: string; name: string; input: string; output: string | null; at: string; endAt: string }>; text: string; result: string | null; endedAt: string }

/** Rows (oldest first) -> one turn per run: the message that started it, the tool calls, and what the agent answered. */
export function groupTurns(rows: TranscriptRow[]): Turn[] {
  const turns: Turn[] = [];
  let pendingUser = '';
  let cur: Turn | null = null;
  for (const r of rows) {
    if (r.src === 'w') { if (r.kind === 'human' && r.body) pendingUser = r.body; continue; }
    const runId = r.run_id ?? 'run';
    if (!cur || cur.runId !== runId) {
      cur = { runId, user: pendingUser, startedAt: r.created_at, calls: [], text: '', result: null, endedAt: r.created_at };
      pendingUser = '';
      turns.push(cur);
    }
    cur.endedAt = r.created_at;
    const p = parse(r.body);
    if (r.kind === 'assistant-text') cur.text += String(p.text ?? '');
    else if (r.kind === 'tool-start') cur.calls.push({ id: String(p.toolCallId ?? `c${cur.calls.length}`), name: String(p.toolName ?? 'tool'), input: String(p.toolInput ?? ''), output: null, at: r.created_at, endAt: r.created_at });
    else if (r.kind === 'tool-end') {
      const c = cur.calls.find((x) => x.id === String(p.toolCallId ?? ''));
      if (c) { c.output = String(p.output ?? ''); c.endAt = r.created_at; }
    } else if (r.kind === 'run-complete') cur.result = String(p.result ?? '');
  }
  return turns;
}

/** The turns as Strands-format spans: invoke_agent > chat (tool use) + execute_tool ... > chat (answer). */
export function buildSessionSpans(rows: TranscriptRow[], sessionId: string): SpanBuild {
  const turns = groupTurns(rows).filter((t) => t.user || t.text || t.result || t.calls.length);
  const spans: Span[] = [];
  let toolCalls = 0;
  const base = (traceId: string, spanId: string, parent: string, name: string, start: string, end: string, attributes: Record<string, unknown>, events: Span[]): Span => {
    const s = nano(start);
    const e = Math.max(nano(end), s + 1e6);
    return {
      traceId, spanId, parentSpanId: parent, name, kind: 'INTERNAL', startTimeUnixNano: s, endTimeUnixNano: e, durationNano: e - s,
      status: { code: 'OK' }, attributes: { 'session.id': sessionId, ...attributes }, events,
      resource: { attributes: { 'service.name': 'agent-portal' } }, scope: { name: 'strands.telemetry.tracer', version: '' },
    };
  };
  const text = (t: string): string => JSON.stringify([{ text: clip(t, MAX_TEXT) }]);
  const ev = (at: string, name: string, attributes: Record<string, unknown>): Span => ({ timeUnixNano: nano(at), name, attributes });

  turns.forEach((t, ti) => {
    const traceId = hex(`${sessionId}|${t.runId}|${ti}`, 32);
    const agentId = hex(`${traceId}|agent`, 16);
    const answer = t.result ?? t.text;
    const calls = t.calls.length <= MAX_TOOL_CALLS ? t.calls : [...t.calls.slice(0, MAX_TOOL_CALLS / 2), ...t.calls.slice(-MAX_TOOL_CALLS / 2)];
    toolCalls += calls.length;
    const user = t.user || '(no message recorded)';
    spans.push(base(traceId, agentId, '', 'invoke_agent Portal', t.startedAt, t.endedAt,
      { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'Portal', 'gen_ai.system': 'strands-agents', 'gen_ai.agent.tools': JSON.stringify([...new Set(calls.map((c) => c.name))]) },
      [ev(t.startedAt, 'gen_ai.user.message', { content: text(user) }), ev(t.endedAt, 'gen_ai.choice', { message: clip(answer, MAX_TEXT), finish_reason: 'end_turn' })]));

    const history: Span[] = [ev(t.startedAt, 'gen_ai.user.message', { content: text(user) })];
    calls.forEach((c, i) => {
      const toolUse = JSON.stringify([{ toolUse: { toolUseId: c.id, name: c.name, input: parse(c.input) } }]);
      spans.push(base(traceId, hex(`${traceId}|chat|${i}`, 16), agentId, 'chat', c.at, c.at,
        { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'strands-agents' },
        [...history.slice(-HISTORY_WINDOW), ev(c.at, 'gen_ai.choice', { message: toolUse, finish_reason: 'tool_use' })]));
      const out = clip(c.output ?? '(no result recorded)', MAX_TOOL_OUTPUT);
      spans.push(base(traceId, hex(`${traceId}|tool|${i}`, 16), agentId, `execute_tool ${c.name}`, c.at, c.endAt,
        { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.system': 'strands-agents', 'gen_ai.tool.name': c.name, 'gen_ai.tool.call.id': c.id },
        [ev(c.at, 'gen_ai.tool.message', { role: 'tool', content: JSON.stringify(parse(c.input)), id: c.id }), ev(c.endAt, 'gen_ai.choice', { message: JSON.stringify([{ text: out }]), id: c.id })]));
      history.push(ev(c.at, 'gen_ai.choice', { message: toolUse, finish_reason: 'tool_use' }));
      history.push(ev(c.endAt, 'gen_ai.tool.message', { role: 'tool', content: JSON.stringify([{ toolResult: { toolUseId: c.id, status: 'success', content: [{ text: out }] } }]), id: c.id }));
    });
    spans.push(base(traceId, hex(`${traceId}|final`, 16), agentId, 'chat', t.endedAt, t.endedAt,
      { 'gen_ai.operation.name': 'chat', 'gen_ai.system': 'strands-agents' },
      [...history.slice(-HISTORY_WINDOW), ev(t.endedAt, 'gen_ai.choice', { message: text(answer), finish_reason: 'end_turn' })]));
  });
  return { spans, turns: turns.length, toolCalls };
}

// ── Evaluate ──────────────────────────────────────────────────────────────────

export interface Score { evaluator: string; value: number | null; label: string | null; explanation: string | null; error: string | null }
export interface EvalRecord {
  workflowId: string; title: string; engine: string; at: string; turns: number; toolCalls: number;
  scores: Score[]; inputTokens: number; outputTokens: number;
}

type EvalClient = { send(cmd: unknown): Promise<any> };
let clientOverride: { client: EvalClient; Cmd: new (input: any) => unknown } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Tests supply a fake Evaluate client. */
export function _setEvalClient(c: typeof clientOverride): void { clientOverride = c; }

async function evaluate(spans: Span[]): Promise<{ scores: Score[]; inputTokens: number; outputTokens: number }> {
  let client: EvalClient; let Cmd: new (input: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (clientOverride) ({ client, Cmd } = clientOverride);
  else {
    const sdk = await import('@aws-sdk/client-bedrock-agentcore');
    client = new sdk.BedrockAgentCoreClient({ region: process.env.AWS_REGION || 'ap-southeast-1' });
    Cmd = sdk.EvaluateCommand as unknown as new (input: unknown) => unknown;
  }
  const scores: Score[] = [];
  let inputTokens = 0; let outputTokens = 0;
  for (const evaluator of EVALUATORS) {
    try {
      const out = await client.send(new Cmd({ evaluatorId: evaluator, evaluationInput: { sessionSpans: spans } }));
      const r = (out.evaluationResults ?? [])[0];
      if (!r) scores.push({ evaluator: evaluator.replace('Builtin.', ''), value: null, label: null, explanation: 'Nothing to score in this session (no tool calls).', error: null });
      else {
        inputTokens += Number(r.tokenUsage?.inputTokens ?? 0); outputTokens += Number(r.tokenUsage?.outputTokens ?? 0);
        scores.push({ evaluator: evaluator.replace('Builtin.', ''), value: r.value ?? null, label: r.label ?? null, explanation: r.explanation ? clip(String(r.explanation), 600) : null, error: r.errorMessage ?? null });
      }
    } catch (e) {
      // ToolSelection / ToolParameter have nothing to score in a session with no tool calls: record why instead of failing the rest.
      scores.push({ evaluator: evaluator.replace('Builtin.', ''), value: null, label: null, explanation: null, error: e instanceof Error ? clip(e.message, 200) : 'failed' });
    }
  }
  return { scores, inputTokens, outputTokens };
}

async function loadRows(workflowId: string): Promise<TranscriptRow[]> {
  const repo = getSessionsRepository();
  const all: TranscriptRow[] = [];
  let cursor = null as Awaited<ReturnType<typeof repo.listTranscript>>['nextCursor'];
  for (let page = 0; page < 40; page++) {
    const r = await repo.listTranscript(workflowId, cursor, 200);
    all.push(...r.rows);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return all.reverse();
}

const recordKey = (wid: string): string => `agentcore.eval.${wid}`;
function readIndex(): string[] {
  try { const v = JSON.parse(getSetting(getDb(), INDEX_KEY) ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export function listEvaluations(limit = 50): EvalRecord[] {
  const out: EvalRecord[] = [];
  for (const wid of readIndex().slice(0, limit)) {
    try { const raw = getSetting(getDb(), recordKey(wid)); if (raw) out.push(JSON.parse(raw) as EvalRecord); } catch { /* skip */ }
  }
  return out;
}

/** Scores one session and stores the result. Throws when the session is unknown or has nothing to score. */
export async function evaluateWorkflow(workflowId: string): Promise<EvalRecord> {
  const w = await getSessionsRepository().getWorkflowById(workflowId);
  if (!w) throw Object.assign(new Error('Session not found'), { status: 404 });
  const built = buildSessionSpans(await loadRows(workflowId), workflowId);
  if (built.spans.length === 0) throw Object.assign(new Error('This session has no turns to score yet'), { status: 400 });
  const { scores, inputTokens, outputTokens } = await evaluate(built.spans);
  const rec: EvalRecord = {
    workflowId, title: String(w.title || w.goal || '').slice(0, 120), engine: String(w.engine), at: new Date().toISOString(),
    turns: built.turns, toolCalls: built.toolCalls, scores, inputTokens, outputTokens,
  };
  await setSetting(getDb(), recordKey(workflowId), JSON.stringify(rec));
  await setSetting(getDb(), INDEX_KEY, JSON.stringify([workflowId, ...readIndex().filter((x) => x !== workflowId)].slice(0, 100)));
  return rec;
}

// ── Automatic sampling ────────────────────────────────────────────────────────

export function getSamplePercent(): number {
  const v = parseInt(getSetting(getDb(), SAMPLE_KEY) ?? '0', 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

/** Stable share of sessions: the same session and turn always land on the same side of the percentage. */
export function isSampled(workflowId: string, lastTurnAt: string, percent: number): boolean {
  if (percent <= 0) return false;
  return parseInt(hex(`${workflowId}|${lastTurnAt}`, 6), 16) % 100 < percent;
}

/** One pass from the per-minute job: score finished sessions that went quiet, are in the sample, and have no score for that turn. */
export async function sweepEvaluations(nowMs = Date.now()): Promise<number> {
  const percent = getSamplePercent();
  if (percent <= 0) return 0;
  const cutoff = new Date(nowMs - MIN_IDLE_MIN * 60_000).toISOString();
  const idle = await getSessionsRepository().listIdleWorkflows(cutoff);
  let done = 0;
  for (const w of idle) {
    if (done >= MAX_AUTO_PER_PASS) break;
    const wid = String(w.id); const last = String(w.last_turn_at ?? '');
    if (!last || !isSampled(wid, last, percent)) continue;
    let prior: EvalRecord | null = null;
    try { const raw = getSetting(getDb(), recordKey(wid)); prior = raw ? JSON.parse(raw) as EvalRecord : null; } catch { prior = null; }
    if (prior && prior.at >= last) continue;
    try { await evaluateWorkflow(wid); done++; } catch (e) { console.error(`[agentcore-eval] could not score ${wid}:`, e instanceof Error ? e.message : e); }
  }
  return done;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerAgentCoreEvalRoutes(): void {
  const admin = (req: PortalRequest, res: PortalResponse): boolean => {
    if (req.user?.is_admin) return true;
    sendJson(res, 403, { error: 'Admins only' });
    return false;
  };

  router.get('/api/agentcore/evals', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!admin(req, res)) return;
    sendJson(res, 200, { samplePercent: getSamplePercent(), evaluators: EVALUATORS.map((e) => e.replace('Builtin.', '')), evaluations: listEvaluations() });
  }));

  router.post('/api/agentcore/evals', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!admin(req, res)) return;
    const body = (req.body ?? {}) as { workflowId?: unknown; recent?: unknown };
    try {
      if (typeof body.workflowId === 'string' && body.workflowId) {
        sendJson(res, 200, { evaluations: [await evaluateWorkflow(body.workflowId)] });
        return;
      }
      const n = Number(body.recent);
      if (!Number.isInteger(n) || n < 1 || n > 10) { sendJson(res, 400, { error: 'Give a workflowId, or recent: a number from 1 to 10' }); return; }
      // The latest sessions across the portal (admin scope), newest first; a session that is still running is skipped.
      const recent = (await getStatsRepository().getRecentSessions(n * 3, null, req.user!.id, true)).filter((s) => s.status !== 'running').slice(0, n);
      const out: EvalRecord[] = [];
      for (const s of recent) { try { out.push(await evaluateWorkflow(s.id)); } catch { /* nothing to score */ } }
      sendJson(res, 200, { evaluations: out });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      sendJson(res, status, { error: e instanceof Error ? e.message : 'Evaluation failed' });
    }
  }));

  router.put('/api/agentcore/evals', requireAuth(async (req: PortalRequest, res: PortalResponse) => {
    if (!admin(req, res)) return;
    const p = (req.body as { samplePercent?: unknown } | undefined)?.samplePercent;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 100) { sendJson(res, 400, { error: 'samplePercent must be a whole number from 0 to 100' }); return; }
    await setSetting(getDb(), SAMPLE_KEY, String(p));
    sendJson(res, 200, { samplePercent: p });
  }));
}
