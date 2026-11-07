/**
 * claude-agentcore.ts — Claude Code runs inside an AgentCore microVM (agent-runner/).
 *
 * Used by runClaudeCode() when PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN is set. The runner
 * applies the same harness as the local engine, from the same source files:
 *   - every tool call through decideToolCall() (working folder, guard, the run's rules),
 *   - calls that need a person relayed here as approval-request events and answered
 *     through the portal's approval flow (fingerprint, expiry, one answer wins),
 *   - the run's spend cap (maxBudgetUsd) and time limit, with the stop reason recorded,
 *   - a cancel from the portal stops the run in the microVM, and the spend up to the stop
 *     is still recorded (the runner's final result arrives shortly after the cancel).
 *
 * Several agents and several sessions, decided by Claude from the prompt:
 *   - subagents: the project's agents (.claude/agents/*.md in the owner's config and in the
 *     project) go with the run, and Claude starts them with the Agent tool inside the microVM.
 *     Their progress arrives as subagent-started / -finished / -failed events.
 *   - child sessions: when delegation is on (Settings › Delegation), Claude has the
 *     delegate_session tool. The portal starts each child as a session of its own (its own
 *     run, so its own microVM), and posts the child's result back to this session.
 *   - each AgentCore run is a new engine session, so a run after the first starts with a
 *     recap of earlier turns (a parent resumed by its children's results keeps its context).
 * Model calls go to Bedrock with the runtime's execution role; no portal credential
 * is sent to the microVM.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HttpError, now } from '../util.ts';
import { getSettings } from '../settings.ts';
import { config } from '../config.ts';
import { one, type Row } from '../db.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getDelegationSettingsRepository } from '../repositories/delegation-settings.ts';
import { createChildSession } from '../delegation.ts';
import { getRunHomeDir } from '../user-config.ts';
import { toPolicyRules } from './tool-policy.ts';
import { type AgentDefinitionPayload } from './agent-defs.ts';
import { loadRunAgents, leadAgentFor } from './run-agents.ts';
import { buildConversationRecap } from './recap.ts';
import { ApprovalRelay, DelegationRelay, isApprovalRequest, isDelegateRequest } from './agentcore-bridge.ts';
import { invokeAgentCore, agentCoreControlSender, runnerApprovals } from './kiro-agentcore.ts';
import type { RunContext, AgentRun } from './types.ts';
import { snapshotAccess } from './runner-snapshot-access.ts';
import { finalizeCheckFor, submitRepoChanges } from './claude-agentcore.ts';
import type { RepoChange } from '../session-pr.ts';
import { RUNTIME_BEDROCK_MODELS, runApiError, explainModelError } from './runtime-models.ts';

/**
 * Bedrock IDs of the models the runtime's role may call (runtime-models.ts). They must match the role's list in
 * infra/lib/harness-stack.ts (a test checks it); runs call them through their global profile.
 */
export { RUNTIME_BEDROCK_MODELS };

/**
 * Bedrock model ID for the runner.
 * - A regional profile (us., apac., …) of a model the runtime's role may call: that model's global profile, which
 *   is the one the role allows (the portal's model lists used to offer the regional ones).
 * - Any other inference profile (global., or a model outside the role's list) as given.
 * - A bare model ID (anthropic.…) through its global profile: the runtime's role may call the global
 *   profiles, and newer Claude models cannot be called on demand by their bare model ID.
 * - A Claude name (claude-sonnet-5-5, claude-opus-4-5-20251101): that version's global profile, when the
 *   role allows it; otherwise the family's 4.5 profile.
 */
export function bedrockModelFor(model: string | null | undefined): string | undefined {
  const m = (model ?? '').trim();
  if (!m) return undefined;
  const regional = /^(?:us|eu|apac|au|jp|in)\.(anthropic\..+)$/.exec(m);
  if (regional && Object.values(RUNTIME_BEDROCK_MODELS).includes(regional[1])) return `global.${regional[1]}`;
  if (/^(us|eu|apac|au|jp|in|global)\.anthropic\./.test(m)) return m;
  if (/^anthropic\./.test(m)) return `global.${m}`;
  const lower = m.toLowerCase();
  const named = /claude-(haiku|sonnet|opus)-(\d+)-(\d)(?!\d)/.exec(lower);
  const known = named ? RUNTIME_BEDROCK_MODELS[`${named[1]}-${named[2]}-${named[3]}`] : undefined;
  if (known) return `global.${known}`;
  if (lower.includes('haiku')) return 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
  if (lower.includes('opus')) return 'global.anthropic.claude-opus-4-5-20251101-v1:0';
  if (lower.includes('sonnet')) return 'global.anthropic.claude-sonnet-4-5-20250929-v1:0';
  return undefined;
}

/** A subagent's model as the runner can use it: an alias it maps to Bedrock, or a Bedrock ID. */
export function agentModelFor(model: string): string | undefined {
  const m = model.trim().toLowerCase();
  if (m === 'inherit' || m === 'haiku' || m === 'sonnet' || m === 'opus') return m;
  return bedrockModelFor(model); // undefined: the agent uses the run's model
}

/**
 * The run's subagents: the owner's (or team's) Claude agents materialised into the run's home,
 * then the project's own .claude/agents/, which win on a name clash.
 */
export function runAgents(run: AgentRun): Record<string, AgentDefinitionPayload> {
  return loadRunAgents(run, agentModelFor);
}

interface RunnerResult {
  stop_reason?: string;
  subtype?: string | null;
  costUsd?: number;
  costEstimated?: boolean;
  sessionId?: string | null;
  model?: string;
  metrics?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** The error text when the turn ended on an API error (e.g. a model the account may not use), not a reply. */
  apiError?: string;
}

/** A run whose stream ended before the runner's final result (the machine stopped answering, or the connection broke). */
export const LOST_RUN_MESSAGE = 'The connection to the cloud machine was lost before the run finished, so it has no final answer. '
  + 'The steps above and the spend so far are kept. Send a follow-up message to pick up where it stopped.';

/** The runner's spend-so-far event, read as a result that carries only the spend (an estimate, priced per reply). */
function spendOf(ev: Record<string, unknown>): RunnerResult {
  const m = (ev.metrics ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    costUsd: n(ev.costUsd),
    costEstimated: true,
    ...(typeof ev.model === 'string' && ev.model ? { model: ev.model } : {}),
    metrics: { inputTokens: n(m.inputTokens), outputTokens: n(m.outputTokens), cacheReadTokens: n(m.cacheReadTokens), cacheWriteTokens: n(m.cacheWriteTokens) },
  };
}

/**
 * After a cancel, how long the portal keeps reading the runner's stream for its final result,
 * which carries the spend up to the stop. The runner answers a cancel within a second or two
 * (seen live: 6 s from run start to the end of a cancelled run).
 */
const CANCEL_GRACE_MS = 10_000;
let cancelGraceMs = CANCEL_GRACE_MS;

/** Tests only: shorten the wait for a runner that never sends its final result. */
export function _setCancelGraceMs(ms: number | null): void {
  cancelGraceMs = ms ?? CANCEL_GRACE_MS;
}

/** A subagent name from the microVM, or null. Names are short; anything else is not shown as one. */
function agentLabel(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null;
}

/** The fields of a subagent event the portal keeps, with their sizes bounded. */
function subagentEvent(ev: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: String(ev.id ?? '').slice(0, 128),
    name: agentLabel(ev.name) ?? 'subagent',
  };
  const text = (k: string, max: number) => { if (typeof ev[k] === 'string' && ev[k]) out[k] = (ev[k] as string).slice(0, max); };
  const num = (k: string) => { if (typeof ev[k] === 'number' && Number.isFinite(ev[k])) out[k] = ev[k]; };
  text('description', 300);
  text('status', 32);
  text('summary', 1000);
  text('parentId', 128);
  if (agentLabel(ev.parentName)) out.parentName = agentLabel(ev.parentName);
  if (typeof ev.background === 'boolean') out.background = ev.background;
  num('depth');
  num('tokens');
  num('toolUses');
  num('durationMs');
  return out;
}

export async function runClaudeViaAgentCore(ctx: RunContext, runtimeArn: string): Promise<string> {
  const { run, emit, signal } = ctx;
  if (signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
  const repo = getSessionsRepository();
  const settings = getSettings();
  const wf = await repo.getWorkflowById(run.workflowId);

  // Limits: the workflow's own, else the portal's (same as the local engine and runner.ts).
  const budget = wf?.budget_usd != null ? Number(wf.budget_usd) : settings.agents.maxBudgetUsdPerRun;
  const minutes = wf?.run_timeout_minutes != null ? Number(wf.run_timeout_minutes) : settings.agents.runTimeoutMinutes;
  const model = bedrockModelFor(run.model) ?? bedrockModelFor(settings.defaultModel);

  // Each AgentCore run is a new engine session: give it the earlier turns as a recap.
  let prompt = run.goal;
  const recap = await buildConversationRecap(run.workflowId, run.runId).catch(() => '');
  if (recap) {
    prompt = recap + prompt;
    emit('status', { text: 'Started with a recap of earlier turns' });
  }

  // Several agents: the project's subagents. Several sessions: delegate_session, when allowed.
  const agents = runAgents(run);
  const delegation = await getDelegationSettingsRepository().get().catch(() => null);
  const canDelegate = Boolean(delegation?.enabled && run.credentialOwnerId && (delegation.allowNested || !wf?.parent_id));

  const hasRepos = Boolean(run.runnerRepos?.length);
  const finalizeCheck = hasRepos && run.projectId ? await finalizeCheckFor(run.projectId, Boolean(wf?.jira_key)) : false;
  const changes: RepoChange[] = [];
  // The runner saves the workspace after the run; the pull request step later restores it in the session's own
  // AgentCore session (this run uses a per-run session id), so the repositories are found again to push.
  const snapshot = hasRepos && run.workflowId ? await snapshotAccess(run.workflowId) : null;

  const payload: Record<string, unknown> = {
    mode: 'run',
    runId: run.runId,
    prompt,
    maxTurns: 200,
    ...(model ? { model } : {}),
    ...(budget != null && budget > 0 ? { maxBudgetUsd: Math.min(budget, 100) } : {}),
    ...(minutes != null && minutes > 0 ? { maxMinutes: Math.min(minutes, 480) } : {}),
    policy: { trusted: run.trusted, rules: toPolicyRules(run.permissions.rules) },
    approvals: runnerApprovals(),
    ...(Object.keys(agents).length ? { agents } : {}),
    // The session's lead agent runs the main conversation (its prompt, tools and skills).
    ...(leadAgentFor(run, agents) ? { agent: leadAgentFor(run, agents) } : {}),
    ...(canDelegate ? { delegation: { via: 'portal' } } : {}),
    ...(hasRepos ? { repos: run.runnerRepos } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(finalizeCheck ? { finalizeCheck: true } : {}),
  };

  // Spend from the runner's final result: on the run and in the budget. Returns the cost.
  const recordSpend = async (r: RunnerResult): Promise<number> => {
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
        user_id: wf?.created_by ?? null,
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
    return cost;
  };

  // One session per run: AgentCore gives it its own microVM, and answers reach the same one.
  const sessionId = `${run.runId}-${randomUUID()}`;
  const send = agentCoreControlSender(runtimeArn, sessionId);
  const relay = new ApprovalRelay(ctx, send, run.permissions.rules);
  const delegations = new DelegationRelay(ctx, send, run.permissions.rules, canDelegate
    ? async (task, title, agent) => {
      // The child's lead agent: one this run has (the child loads the same owner and project agents).
      if (agent && !Object.prototype.hasOwnProperty.call(agents, agent)) {
        throw new Error(`there is no agent "${agent}" in this session (available: ${Object.keys(agents).join(', ') || 'none'})`);
      }
      const child = await createChildSession(run.workflowId, run.credentialOwnerId!, task, { title, ...(agent ? { leadAgent: agent } : {}) });
      return { id: String(child.id), title: String(child.title || task.slice(0, 60)) };
    }
    : null);

  // The stream has its own abort. A cancel tells the runner to stop; the portal then keeps
  // reading for a few seconds so the runner's final result, with the spend so far, arrives.
  const stream = new AbortController();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const onCancel = (): void => {
    void send({ mode: 'cancel', runId: run.runId }).catch(() => { /* the grace timer closes the stream anyway */ });
    graceTimer = setTimeout(() => stream.abort(), cancelGraceMs);
  };
  signal?.addEventListener('abort', onCancel, { once: true });

  emit('status', { state: 'thinking' });
  emit('status', { text: 'Running in an AgentCore microVM…' });

  const textParts: string[] = [];
  // The runner streams the main agent's replies as it writes them: pieces marked `stream`, often mid-word.
  // The pieces of one reply join into one part of the answer, until any other event (the reply's end, a
  // tool call, an agent's progress) closes it. The viewer joins the pieces the same way.
  let replyOpen = false;
  let result: RunnerResult | null = null;
  // The runner's spend so far (sent after every model reply): recorded when the run ends without its final result.
  let spendSoFar: RunnerResult | null = null;
  const recordSpendSoFar = async (): Promise<void> => {
    if (!spendSoFar) return;
    await recordSpend(spendSoFar).catch((err: unknown) => {
      console.warn(`[claude-agentcore] Could not record the spend of run ${run.runId}, which ended without a result:`, err);
    });
  };
  try {
    for await (const raw of invokeAgentCore(runtimeArn, sessionId, payload, stream.signal)) {
      const ev = raw as unknown as Record<string, unknown>;
      if (signal?.aborted) {
        // Stopped: only the final result still matters (its spend). Nothing else is relayed.
        if (ev.type === 'result') {
          result = ev as RunnerResult;
          break;
        }
        if (ev.type === 'spend') spendSoFar = spendOf(ev);
        continue;
      }
      const piece = ev.type === 'assistant-text' && ev.stream === true && !agentLabel(ev.agent);
      if (!piece) replyOpen = false;
      switch (ev.type) {
        case 'assistant-text': {
          const text = String(ev.text ?? '');
          const agent = agentLabel(ev.agent);
          if (text && agent) {
            // A subagent's text: shown under its name; the run's answer is the main agent's.
            emit('assistant-text', { text, agent });
          } else if (text && piece) {
            if (replyOpen) textParts[textParts.length - 1] += text;
            else textParts.push(text);
            replyOpen = true;
            emit('assistant-text', { text, stream: true });
          } else if (text) {
            textParts.push(text);
            emit('assistant-text', { text });
          }
          break;
        }
        case 'tool-start': {
          const agent = agentLabel(ev.agent);
          emit('tool-start', { toolName: String(ev.toolName ?? ''), toolInput: String(ev.toolInput ?? ''), ...(agent ? { agent } : {}) });
          break;
        }
        case 'tool-result':
          emit('tool-end', { toolName: String(ev.name ?? ''), output: String(ev.output ?? '') });
          break;
        case 'tool-blocked': {
          const agent = agentLabel(ev.agent);
          emit('tool-blocked', { toolName: String(ev.toolName ?? ''), toolInput: String(ev.toolInput ?? ''), reason: String(ev.reason ?? ''), ...(agent ? { agent } : {}) });
          break;
        }
        case 'approval-request':
          if (isApprovalRequest(ev)) relay.handle(ev);
          break;
        case 'delegate-request':
          if (isDelegateRequest(ev)) delegations.handle(ev);
          break;
        case 'subagent-started':
        case 'subagent-finished':
        case 'subagent-failed':
          emit(ev.type, subagentEvent(ev));
          break;
        case 'status':
          if (ev.text) emit('status', { text: String(ev.text) });
          break;
        case 'repo-changes':
          // Not a run event: handed to the pull request step once the run has finished.
          changes.push({ repo: String(ev.repo ?? ''), base: String(ev.base ?? ''), commits: Number(ev.commits) || 0, files: Number(ev.files) || 0 });
          break;
        case 'error':
          throw new HttpError(502, `AgentCore run error: ${String(ev.message ?? 'unknown')}`);
        case 'spend':
          spendSoFar = spendOf(ev);
          break;
        case 'result':
          result = ev as RunnerResult;
          break;
        default:
          break;
      }
    }
  } catch (e: unknown) {
    // After a cancel, a stream closed by the grace timer (or failing) just means no result came.
    if (!signal?.aborted) {
      if (!result) await recordSpendSoFar();
      throw e;
    }
  } finally {
    signal?.removeEventListener('abort', onCancel);
    clearTimeout(graceTimer);
    stream.abort(); // closes the connection if reading stopped before the runner's end
  }

  if (signal?.aborted) {
    if (result) {
      await recordSpend(result).catch((err: unknown) => {
        console.warn(`[claude-agentcore] Could not record the spend of cancelled run ${run.runId}:`, err);
      });
    } else {
      await recordSpendSoFar();
    }
    throw new DOMException('Run cancelled', 'AbortError');
  }
  if (!result) {
    await recordSpendSoFar();
    throw new HttpError(502, LOST_RUN_MESSAGE);
  }

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

  const cost = await recordSpend(r);

  // A turn that ended on an API error (Bedrock refused the model, say) is not an answer: fail the run and say why,
  // instead of completing it with Claude Code's "API Error: 403 …" text as the reply.
  const apiError = runApiError(r, textParts.join('\n'));
  if (apiError) throw new HttpError(502, explainModelError(apiError, r.model ?? model));

  const summary = textParts.join('\n').trim() || 'Run complete.';
  emit('run-complete', { result: summary, cost_usd: cost, ...(r.costEstimated ? { cost_estimated: true } : {}) });
  emit('status', { state: 'idle' });
  // Spend is recorded and the run is done: now the pull request step (never fails the run).
  await submitRepoChanges(run, wf?.created_by ?? null, changes);
  return summary;
}
