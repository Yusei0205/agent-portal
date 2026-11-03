/**
 * claude-agentcore.ts — Claude Code runs inside an AgentCore microVM (agent-runner/).
 *
 * Used by runClaudeCode() when PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN is set. The runner
 * applies the same harness as the local engine, from the same source files:
 *   - every tool call through decideToolCall() (working folder, guard, the run's rules),
 *   - calls that need a person relayed here as approval-request events and answered
 *     through the portal's approval flow (fingerprint, expiry, one answer wins),
 *   - the run's spend cap (maxBudgetUsd) and time limit, with the stop reason recorded,
 *   - a cancel from the portal stops the run in the microVM.
 * Model calls go to Bedrock with the runtime's execution role; no portal credential
 * is sent to the microVM.
 */

import { randomUUID } from 'node:crypto';
import { HttpError, now } from '../util.ts';
import { getSettings } from '../settings.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { toPolicyRules } from './tool-policy.ts';
import { ApprovalRelay, isApprovalRequest } from './agentcore-bridge.ts';
import { invokeAgentCore, agentCoreControlSender, runnerApprovals } from './kiro-agentcore.ts';
import type { RunContext } from './types.ts';

/** Bedrock model ID for the runner: a Bedrock ID as given, otherwise the matching global profile. */
export function bedrockModelFor(model: string | null | undefined): string | undefined {
  const m = (model ?? '').trim();
  if (!m) return undefined;
  if (/^((us|eu|apac|au|jp|in|global)\.)?anthropic\./.test(m)) return m;
  const lower = m.toLowerCase();
  if (lower.includes('haiku')) return 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
  if (lower.includes('opus')) return 'global.anthropic.claude-opus-4-5-20251101-v1:0';
  if (lower.includes('sonnet')) return 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
  return undefined;
}

interface RunnerResult {
  stop_reason?: string;
  subtype?: string | null;
  costUsd?: number;
  costEstimated?: boolean;
  sessionId?: string | null;
  model?: string;
  metrics?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

export async function runClaudeViaAgentCore(ctx: RunContext, runtimeArn: string): Promise<string> {
  const { run, emit, signal } = ctx;
  const repo = getSessionsRepository();
  const settings = getSettings();
  const wf = (await repo.getWorkflowById(run.workflowId)) as Record<string, unknown> | null;

  // Limits: the workflow's own, else the portal's (same as the local engine and runner.ts).
  const budget = wf?.['budget_usd'] != null ? Number(wf['budget_usd']) : settings.agents.maxBudgetUsdPerRun;
  const minutes = wf?.['run_timeout_minutes'] != null ? Number(wf['run_timeout_minutes']) : settings.agents.runTimeoutMinutes;
  const model = bedrockModelFor(run.model) ?? bedrockModelFor(settings.defaultModel);

  const payload: Record<string, unknown> = {
    mode: 'run',
    runId: run.runId,
    prompt: run.goal,
    maxTurns: 200,
    ...(model ? { model } : {}),
    ...(budget != null && budget > 0 ? { maxBudgetUsd: Math.min(budget, 100) } : {}),
    ...(minutes != null && minutes > 0 ? { maxMinutes: Math.min(minutes, 480) } : {}),
    policy: { trusted: run.trusted, rules: toPolicyRules(run.permissions.rules) },
    approvals: runnerApprovals(),
  };

  // One session per run: AgentCore gives it its own microVM, and answers reach the same one.
  const sessionId = `${run.runId}-${randomUUID()}`;
  const send = agentCoreControlSender(runtimeArn, sessionId);
  const relay = new ApprovalRelay(ctx, send, run.permissions.rules);
  const onCancel = (): void => {
    void send({ mode: 'cancel', runId: run.runId }).catch(() => { /* the stream is closing anyway */ });
  };
  signal?.addEventListener('abort', onCancel, { once: true });

  emit('status', { state: 'thinking' });
  emit('status', { text: 'Running in an AgentCore microVM…' });

  const textParts: string[] = [];
  let result: RunnerResult | null = null;
  try {
    for await (const raw of invokeAgentCore(runtimeArn, sessionId, payload, signal ?? undefined)) {
      const ev = raw as unknown as Record<string, unknown>;
      switch (ev.type) {
        case 'assistant-text': {
          const text = String(ev.text ?? '');
          if (text) {
            textParts.push(text);
            emit('assistant-text', { text });
          }
          break;
        }
        case 'tool-start':
          emit('tool-start', { toolName: String(ev.toolName ?? ''), toolInput: String(ev.toolInput ?? '') });
          break;
        case 'tool-result':
          emit('tool-end', { toolName: String(ev.name ?? ''), output: String(ev.output ?? '') });
          break;
        case 'tool-blocked':
          emit('tool-blocked', { toolName: String(ev.toolName ?? ''), toolInput: String(ev.toolInput ?? ''), reason: String(ev.reason ?? '') });
          break;
        case 'approval-request':
          if (isApprovalRequest(ev)) relay.handle(ev);
          break;
        case 'status':
          if (ev.text) emit('status', { text: String(ev.text) });
          break;
        case 'error':
          throw new HttpError(502, `AgentCore run error: ${String(ev.message ?? 'unknown')}`);
        case 'result':
          result = ev as RunnerResult;
          break;
        default:
          break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onCancel);
  }

  if (signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
  if (!result) throw new HttpError(502, 'The AgentCore run ended without a result.');

  // ── Stop reasons (FR-GUARD-10) ─────────────────────────────────────────────
  const r = result as RunnerResult;
  if (r.stop_reason === 'budget') {
    const cap = payload.maxBudgetUsd != null ? ` ($${payload.maxBudgetUsd})` : '';
    await repo.updateRun(run.runId, { stop_reason: `spend cap reached${cap}` });
    emit('status', { text: `Spend cap reached${cap}. Run stopped cleanly.` });
  } else if (r.stop_reason === 'time_limit') {
    await repo.updateRun(run.runId, { stop_reason: `time limit reached (${payload.maxMinutes} minutes)` });
  } else if (r.stop_reason === 'max_turns') {
    await repo.updateRun(run.runId, { stop_reason: 'turn limit reached' });
  }

  // ── Spend ──────────────────────────────────────────────────────────────────
  const m = r.metrics ?? {};
  const cost = Number(r.costUsd ?? 0);
  const usedModel = r.model ?? model ?? 'bedrock-default';
  await repo.updateRun(run.runId, {
    cost_usd: cost,
    input_tokens: m.inputTokens ?? 0,
    output_tokens: m.outputTokens ?? 0,
    cache_write_tokens: m.cacheWriteTokens ?? 0,
    cache_read_tokens: m.cacheReadTokens ?? 0,
    model: usedModel,
  });
  if (cost > 0 || (m.inputTokens ?? 0) > 0) {
    const { getBudgetRepository } = await import('../repositories/budget.ts');
    await getBudgetRepository().record({
      user_id: (wf?.['created_by'] as string | null) ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: cost,
      input_tokens: m.inputTokens ?? 0,
      output_tokens: m.outputTokens ?? 0,
      provider: 'bedrock',
      model: usedModel,
      created_at: now(),
    });
  }

  const summary = textParts.join('\n').trim() || 'Run complete.';
  emit('run-complete', { result: summary, cost_usd: cost, ...(r.costEstimated ? { cost_estimated: true } : {}) });
  emit('status', { state: 'idle' });
  return summary;
}
