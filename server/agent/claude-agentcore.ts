/**
 * Claude Code on Amazon Bedrock AgentCore.
 *
 * On Lambda the Claude Agent SDK cannot run locally (no long-lived process, no shell), so a Claude run is
 * sent to an AgentCore runtime (agent-runner image) with the user's own Anthropic credential in the request.
 * The runner streams back SSE events that this module turns into the portal's run events.
 *
 * Enabled when PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN is set and the run's credential is an Anthropic API key
 * or a Claude subscription token (Bedrock credentials keep using the local SDK path).
 *
 * Runner events: status, assistant-text {text, tokens}, tool-call {name,input}, tool-result {name,output},
 * tool-blocked {toolName,reason}, result {stop_reason, metrics}, error {message}.
 */

import { randomUUID } from 'node:crypto';
import { invokeAgentCore } from './kiro-agentcore.ts';
import { HttpError } from '../util.ts';
import type { RunContext } from './types.ts';
import { createFileReceiver } from './runner-files.ts';
import { persistFile } from '../durable-files.ts';
import { snapshotAccess } from './runner-snapshot-access.ts';
import { agentCoreSessionId } from './agentcore-session.ts';
import { waitForRepoPrep } from './repo-prep.ts';

export interface ClaudeAgentCoreOpts {
  runtimeArn: string;
  runId: string;
  prompt: string;
  model: string;
  auth: { kind: 'api_key' | 'oauth_token'; secret: string };
  trustTools: boolean;
  maxBudgetUsd?: number | null;
  /** Thinking effort from Settings (empty = the model's default). */
  effort?: string | null;
  maxTurns?: number | null;
  /** Give the agent the AgentCore Browser tools (mcp__browser__*). */
  browser?: boolean;
  /** The session's repositories for the runner to clone under repos/. */
  repos?: import('./runner-repos.ts').RunnerRepo[];
  /** The project's remote MCP integrations (runner starts a proxy for each). */
  mcpServers?: import('./runner-mcp.ts').McpServerSpec[];
  /** The project's AWS account as AWS_* variables for the agent's shell. */
  awsEnv?: Record<string, string>;
  /** A loop session's check steps, run by the runner after the agent finishes. */
  checks?: import('./runner-checks.ts').CheckStep[];
}

export interface ClaudeAgentCoreResult {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string;
}

/** Picks the credential the runner should use from the env built by resolveCredentialEnv(). */
export function anthropicAuthFromEnv(env: Record<string, string | undefined>): ClaudeAgentCoreOpts['auth'] | null {
  if (env.CLAUDE_CODE_USE_BEDROCK) return null;
  if (env.ANTHROPIC_API_KEY) return { kind: 'api_key', secret: env.ANTHROPIC_API_KEY };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: 'oauth_token', secret: env.CLAUDE_CODE_OAUTH_TOKEN };
  return null;
}

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

export async function runClaudeViaAgentCore(ctx: RunContext, opts: ClaudeAgentCoreOpts): Promise<ClaudeAgentCoreResult> {
  const { emit, signal } = ctx;
  // One AgentCore session per portal session, so the session's persistent folder (repositories) is found again.
  const sessionId = ctx.run?.workflowId ? agentCoreSessionId(ctx.run.workflowId, 'claude-code') : randomUUID();
  if (ctx.run?.workflowId && opts.repos?.length) await waitForRepoPrep(ctx.run.workflowId);
  const parts: string[] = [];
  const out: ClaudeAgentCoreResult = {
    text: '', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, stopReason: 'end_turn',
  };

  emit('status', { state: 'thinking' });
  emit('status', { text: 'Running Claude via AgentCore…' });

  // Just under the AgentCore runtime's 30 minute maximum lifetime.
  const timeoutMs = Number(process.env.PORTAL_RUN_TIMEOUT_MS) || 29 * 60_000;
  const ac = new AbortController();
  const merged = signal ? mergeSignals([signal, ac.signal]) : ac.signal;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(new Error('AgentCore run timed out')); }, timeoutMs);

  const snapshot = opts.repos?.length && ctx.run?.workflowId ? await snapshotAccess(ctx.run.workflowId) : null;
  const payload: Record<string, unknown> = {
    runId: opts.runId,
    prompt: opts.prompt,
    model: opts.model,
    auth: opts.auth,
    trustTools: opts.trustTools,
    ...(opts.browser ? { browser: true } : {}),
    ...(opts.repos?.length ? { repos: opts.repos } : {}),
    ...(opts.mcpServers?.length ? { mcpServers: opts.mcpServers } : {}),
    ...(opts.awsEnv && Object.keys(opts.awsEnv).length ? { awsEnv: opts.awsEnv } : {}),
    ...(opts.checks?.length ? { checks: opts.checks } : {}),
    ...(snapshot ? { snapshot } : {}),
    maxMinutes: Math.floor(timeoutMs / 60_000),
    ...(opts.maxBudgetUsd && opts.maxBudgetUsd > 0 ? { maxBudgetUsd: Math.min(opts.maxBudgetUsd, 100) } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.maxTurns && opts.maxTurns > 0 ? { maxTurns: Math.min(opts.maxTurns, 200) } : {}),
  };

  // Files the agent wrote come back as 'file' events and land in the run's work folder (then mirrored to S3).
  const receiver = ctx.run?.workDir ? createFileReceiver(ctx.run.workDir, (abs) => persistFile(abs)) : null;

  try {
    for await (const raw of invokeAgentCore(opts.runtimeArn, sessionId, payload, merged)) {
      if (signal?.aborted) break;
      const ev = raw as unknown as Record<string, unknown>;
      switch (ev.type) {
        case 'assistant-text': {
          const text = String(ev.text ?? '');
          if (text) {
            // `stream` marks a piece of a longer message, which the viewer joins as-is.
            emit('assistant-text', ev.stream === true ? { text, stream: true } : { text });
            if (ev.stream === true && parts.length) parts[parts.length - 1] += text;
            else parts.push(text);
          }
          break;
        }
        case 'context': {
          const percent = Number(ev.percent);
          if (Number.isFinite(percent)) emit('context-usage', { percent });
          break;
        }
        case 'thought': {
          const text = String(ev.text ?? '');
          if (text) emit('agent-thought', { text });
          break;
        }
        case 'tool-call':
          // A tool call ends the current text segment; the next piece starts a new one.
          if (parts.length && parts[parts.length - 1] !== '') parts.push('');
          emit('tool-start', { toolCallId: '', toolName: String(ev.name ?? 'Tool'), toolInput: String(ev.input ?? '{}'), status: 'in_progress' });
          break;
        case 'tool-result':
          emit('tool-end', { toolCallId: '', toolName: String(ev.name ?? 'Tool'), status: 'completed', output: String(ev.output ?? '') });
          break;
        case 'check-result':
          emit('check-result', { ok: Boolean(ev.ok), ranAt: String(ev.ranAt ?? ''), steps: Array.isArray(ev.steps) ? ev.steps : [] });
          break;
        case 'browser-session':
          if (ev.sessionId) emit('browser-session', { browserId: String(ev.browserId ?? 'aws.browser.v1'), sessionId: String(ev.sessionId), width: Number(ev.width) || 1280, height: Number(ev.height) || 800 });
          break;
        case 'browser-navigate':
          if (ev.url) emit('browser-navigate', { url: String(ev.url) });
          break;
        case 'browser-screenshot':
          if (ev.screenshotBase64) emit('browser-screenshot', { screenshotBase64: String(ev.screenshotBase64), ...(ev.url ? { url: String(ev.url) } : {}) });
          break;
        case 'tool-blocked':
          emit('tool-blocked', { toolName: String(ev.toolName ?? ''), toolInput: String(ev.toolInput ?? ''), reason: String(ev.reason ?? '') });
          break;
        case 'status': {
          const text = String(ev.text ?? '');
          if (text && !text.startsWith('Work dir:')) emit('status', { text });
          break;
        }
        case 'file':
          await receiver?.handle(ev);
          break;
        case 'error':
          // Never echo the credential: the runner does not log it, but cut anything that looks like a key anyway.
          throw new HttpError(502, `AgentCore Claude run error: ${String(ev.message ?? '').replace(/sk-ant-[\w-]+/g, 'sk-ant-…')}`);
        case 'result': {
          const m = (ev.metrics ?? {}) as Record<string, unknown>;
          out.costUsd = Number(m.costUsd ?? 0) || 0;
          out.inputTokens = Number(m.inputTokens ?? 0) || 0;
          out.outputTokens = Number(m.outputTokens ?? 0) || 0;
          out.cacheReadTokens = Number(m.cacheReadTokens ?? 0) || 0;
          out.cacheWriteTokens = Number(m.cacheWriteTokens ?? 0) || 0;
          out.stopReason = String(ev.stop_reason ?? 'end_turn');
          break;
        }
        default:
          break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) throw new HttpError(504, 'AgentCore Claude run timed out');
  if (signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');

  if (receiver?.received.length) emit('status', { text: `Received ${receiver.received.length} file${receiver.received.length === 1 ? '' : 's'} from the agent` });
  emit('status', { state: 'idle' });
  out.text = parts.join('\n').trim();
  return out;
}
