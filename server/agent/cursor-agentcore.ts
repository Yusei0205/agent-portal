/**
 * Cursor on AgentCore: the portal side. Sends one turn to the Cursor runner (cursor-runner/) and relays its events.
 * Modelled on codex-agentcore.ts. There is no approval relay (print mode has none) and no renewable credential:
 * the runner gets the person's Cursor API key for the turn and redacts it from everything it sends back.
 */

import { randomUUID } from 'node:crypto';
import { invokeAgentCore, invokeAgentCoreOneShot } from './kiro-agentcore.ts';
import { agentCoreSessionId } from './agentcore-session.ts';
import { snapshotAccess, cursorStateAccess } from './runner-snapshot-access.ts';
import { createFileReceiver } from './runner-files.ts';
import { resolveCredentialEnv } from '../credentials.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { persistFile } from '../durable-files.ts';
import { HttpError, now } from '../util.ts';
import type { RunContext } from './types.ts';
import { withSkillsGuidance } from './skills-guidance.ts';
import { recordCursorUsage } from './cursor.ts';
import { getCursorConfigFiles } from '../user-config.ts';
import { parseCursorModels, type CursorModel } from '../cursor-models.ts';
import type { CursorAuth } from '../cursor-login-token.ts';

const allowedEvents = new Set(['assistant-text', 'agent-thought', 'tool-start', 'tool-end', 'tool-blocked', 'status']);
const count = (n: unknown): number => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0);

/** The person's Cursor API key or login token. Cloud Cursor has no `agent login` of its own, so one of them is required. */
async function authFor(userId: string, credentialId: string | null): Promise<CursorAuth> {
  const env = await resolveCredentialEnv('cursor', userId, credentialId);
  if (!env.CURSOR_API_KEY && !env.CURSOR_AUTH_TOKEN) throw new HttpError(400, 'Cloud Cursor needs a Cursor API key or login token. Add one under Credentials.');
  return { apiKey: env.CURSOR_API_KEY, authToken: env.CURSOR_AUTH_TOKEN };
}

export async function runCursorViaAgentCore(ctx: RunContext, prompt: string): Promise<string> {
  const { run } = ctx;
  const arn = process.env.PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN;
  if (!arn || !run.credentialOwnerId) throw new HttpError(503, 'The Cursor cloud runtime or the session owner is missing.');
  const auth = await authFor(run.credentialOwnerId, run.credentialId);
  const secrets = [auth.apiKey, auth.authToken].filter((s): s is string => Boolean(s));
  const [workspace, state] = await Promise.all([snapshotAccess(run.workflowId), cursorStateAccess(run.workflowId)]);
  if (!state || !workspace) throw new HttpError(503, 'Cloud Cursor needs durable S3 conversation and workspace snapshots.');
  const session = agentCoreSessionId(run.workflowId, 'cursor');
  const files = createFileReceiver(run.workDir, persistFile);
  const changes: Array<{ repo: string; base: string; commits: number; files: number }> = [];
  let finalizeCheck = false;
  if (run.projectId && run.runnerRepos?.length) {
    const { finalizeRunPayloadFlag } = await import('../session-pr.ts');
    const workflow = await getSessionsRepository().getWorkflowById(run.workflowId);
    finalizeCheck = await finalizeRunPayloadFlag(run.projectId, Boolean(workflow?.jira_key)).catch(() => false);
  }
  const payload = {
    mode: 'cursor-run', runId: run.runId, workflowId: run.workflowId,
    prompt: withSkillsGuidance(prompt, Boolean(run.runnerRepos?.length)), apiKey: auth.apiKey, authToken: auth.authToken,
    cursorConfig: await getCursorConfigFiles(run.credentialOwnerId).catch(() => []),
    trusted: run.trusted, model: run.model, sessionId: run.engineSessionId, repos: run.runnerRepos,
    mcpServers: run.runnerMcpServers, inputFiles: run.runnerInputFiles, checks: run.runnerChecks,
    snapshot: workspace, stateSnapshot: state, finalizeCheck,
  };
  const scrub = (value: unknown): Record<string, any> => JSON.parse(secrets.reduce((text, secret) => text.split(secret).join('***'), JSON.stringify(value)));
  const cancelControl = async (): Promise<void> => {
    try {
      for await (const _ of invokeAgentCore(arn, session, { mode: 'cancel', runId: run.runId })) { /* one reply */ }
    } catch { /* the run is already ending */ }
  };
  ctx.signal?.addEventListener('abort', cancelControl, { once: true });

  let failure: string | null = null;
  let done: { text: string; sessionId: string } | null = null;
  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number } | null = null;
  let model: string | null = null;
  try {
    if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
    ctx.emit('status', { text: `Running Cursor on AgentCore with your Cursor ${auth.authToken ? 'login' : 'API key'}.` });
    for await (const raw of invokeAgentCore(arn, session, payload, ctx.signal ?? undefined)) {
      const event = scrub(raw);
      if (event.type === 'portal-event' && allowedEvents.has(event.eventType) && event.payload && typeof event.payload === 'object') ctx.emit(event.eventType, event.payload);
      else if (event.type === 'status' && typeof event.text === 'string') ctx.emit('status', { text: event.text });
      else if (event.type === 'file') await files.handle(event);
      else if (event.type === 'check-result') ctx.emit('check-result', { ok: event.ok === true, ranAt: event.ranAt, steps: event.steps });
      else if (event.type === 'repo-changes' && typeof event.repo === 'string') changes.push({ repo: event.repo, base: String(event.base || ''), commits: Number(event.commits) || 0, files: Number(event.files) || 0 });
      else if (event.type === 'error') failure = String(event.message || 'The Cursor runner failed');
      else if (event.type === 'result') {
        const u = event.usage && typeof event.usage === 'object' ? event.usage : null;
        if (u) usage = { inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens), cacheReadTokens: count(u.cacheReadTokens), cacheWriteTokens: count(u.cacheWriteTokens), reasoningTokens: count(u.reasoningTokens) };
        model = typeof event.model === 'string' ? event.model : null;
        if (event.cancelled) {
          // Ended by the person, but the runner kept the conversation: the next message goes on from it.
          if (event.stateSaved === true && typeof event.sessionId === 'string' && event.sessionId) {
            await getSessionsRepository().updateWorkflow(run.workflowId, { engine_session_id: event.sessionId, engine_session_engine: 'cursor', updated_at: now() }).catch(() => undefined);
          }
          throw new DOMException('Run cancelled', 'AbortError');
        }
        if (event.exitCode !== 0) throw new HttpError(502, failure || 'The Cursor runner failed.');
        if (event.stateSaved !== true || typeof event.sessionId !== 'string' || !event.sessionId || typeof event.text !== 'string') throw new HttpError(502, 'Cursor did not confirm durable conversation state.');
        done = { text: event.text, sessionId: event.sessionId };
      }
    }
    if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
    if (!done || failure) throw new HttpError(502, failure || 'The Cursor runner ended without a completion result.');
    await getSessionsRepository().updateWorkflow(run.workflowId, { engine_session_id: done.sessionId, engine_session_engine: 'cursor', updated_at: now() });
    if (changes.length && run.projectId) {
      const { handleRepoChanges } = await import('../session-pr.ts');
      await handleRepoChanges({ workflowId: run.workflowId, runId: run.runId, projectId: run.projectId, userId: run.credentialOwnerId, engine: 'cursor' }, changes).catch(() => {});
    }
    ctx.emit('status', { state: 'idle' });
    ctx.emit('run-complete', { result: done.text, cost_usd: 0 });
    return done.text;
  } finally {
    ctx.signal?.removeEventListener('abort', cancelControl);
    await recordCursorUsage(run, { usage, model });
  }
}

export async function listCursorModelsViaAgentCore(userId: string, credentialId: string | null): Promise<CursorModel[]> {
  const arn = process.env.PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN;
  if (!arn) throw new HttpError(503, 'The Cursor cloud runtime is not configured.');
  const auth = await authFor(userId, credentialId);
  for await (const raw of invokeAgentCoreOneShot(arn, 'cursor-models-' + randomUUID(), { mode: 'cursor-models', apiKey: auth.apiKey, authToken: auth.authToken }, AbortSignal.timeout(60_000))) {
    const event = raw as unknown as Record<string, any>;
    if (event.type === 'models' && typeof event.text === 'string') return parseCursorModels(event.text);
    if (event.type === 'error') throw new HttpError(502, 'The Cursor cloud runner could not list models.');
  }
  throw new HttpError(502, 'The Cursor cloud runner returned no model list.');
}
