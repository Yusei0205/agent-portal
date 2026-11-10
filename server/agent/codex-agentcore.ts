import { randomUUID } from 'node:crypto';
import { invokeAgentCore, agentCoreControlSender, runnerApprovals } from './kiro-agentcore.ts';
import { agentCoreSessionId } from './agentcore-session.ts';
import { ApprovalRelay, isApprovalRequest } from './agentcore-bridge.ts';
import { snapshotAccess, codexStateAccess } from './runner-snapshot-access.ts';
import { createFileReceiver } from './runner-files.ts';
import { toPolicyRules } from './tool-policy.ts';
import { cloudCodexAuth } from '../codex-device.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { persistFile } from '../durable-files.ts';
import { HttpError } from '../util.ts';
import type { RunContext } from './types.ts';
import { withSkillsGuidance } from './skills-guidance.ts';
import type { CodexTurnResult } from './codex-session.ts';
import { getCodexConfigFiles } from '../user-config.ts';
import { parseCodexPrRequest, type CodexPrRequest } from './codex-pr-tool.ts';

const allowedEvents = new Set(['assistant-text', 'tool-start', 'tool-end', 'tool-blocked', 'status', 'context-usage', 'subagent-started', 'subagent-finished', 'subagent-failed']);
const finiteTokenCount = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
function usageFrom(raw: Record<string, any>): Omit<CodexTurnResult, 'text'> {
  return { threadId: typeof raw.threadId === 'string' ? raw.threadId : '', model: typeof raw.model === 'string' ? raw.model : '',
    inputTokens: finiteTokenCount(raw.inputTokens), outputTokens: finiteTokenCount(raw.outputTokens), cacheTokens: finiteTokenCount(raw.cacheTokens) };
}

export async function runCodexViaAgentCore(
  ctx: RunContext, prompt: string, recordUsage: (value: Omit<CodexTurnResult, 'text'>) => Promise<void>,
): Promise<CodexTurnResult> {
  const arn = process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN;
  if (!arn || !ctx.run.credentialOwnerId) throw new HttpError(503, 'Codex cloud runtime or session owner is missing.');
  const auth = await cloudCodexAuth(ctx.run.credentialOwnerId);
  const secrets = ['accessToken' in auth ? auth.accessToken : auth.chatgptAuthTokens.accessToken];
  const [workspace, state] = await Promise.all([snapshotAccess(ctx.run.workflowId), codexStateAccess(ctx.run.workflowId)]);
  if (!state || !workspace) throw new HttpError(503, 'Cloud Codex requires durable S3 conversation and workspace snapshots.');
  const session = agentCoreSessionId(ctx.run.workflowId, 'codex');
  const control = agentCoreControlSender(arn, session);
  const approvals = new ApprovalRelay(ctx, control, ctx.run.permissions.rules);
  const files = createFileReceiver(ctx.run.workDir, persistFile);
  const changes: Array<{ repo: string; base: string; commits: number; files: number }> = [];
  const requestedPrs = new Map<string, CodexPrRequest>();
  let finalizeCheck = false;
  if (ctx.run.projectId && ctx.run.runnerRepos?.length) {
    const { finalizeRunPayloadFlag } = await import('../session-pr.ts');
    const workflow = await getSessionsRepository().getWorkflowById(ctx.run.workflowId);
    finalizeCheck = await finalizeRunPayloadFlag(ctx.run.projectId, Boolean(workflow?.jira_key)).catch(() => false);
  }
  const payload = { mode: 'codex-run', runId: ctx.run.runId, workflowId: ctx.run.workflowId, prompt: withSkillsGuidance(prompt, Boolean(ctx.run.runnerRepos?.length)), ...auth,
    codexConfig: await getCodexConfigFiles(ctx.run.credentialOwnerId), leadAgent: ctx.run.leadAgent,
    trusted: ctx.run.trusted, rules: toPolicyRules(ctx.run.permissions.rules), approvals: runnerApprovals(),
    model: ctx.run.model, threadId: ctx.run.engineSessionId, repos: ctx.run.runnerRepos,
    mcpServers: ctx.run.runnerMcpServers, inputFiles: ctx.run.runnerInputFiles, checks: ctx.run.runnerChecks,
    snapshot: workspace, stateSnapshot: state, finalizeCheck };
  let result: CodexTurnResult | null = null;
  let latest = usageFrom({});
  let failure: string | null = null;
  const scrub = (value: unknown): any => { let text = JSON.stringify(value); for (const secret of secrets) text = text.split(secret).join('***'); return JSON.parse(text); };
  const cancel = () => { void control({ mode: 'cancel', runId: ctx.run.runId }).catch(() => {}); };
  ctx.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
    ctx.emit('status', { text: 'Running Codex on AgentCore with your connected ChatGPT account.' });
    for await (const raw of invokeAgentCore(arn, session, payload, ctx.signal ?? undefined)) {
      const event = scrub(raw) as Record<string, any>;
      if (event.type === 'auth-refresh-request' && 'chatgptAuthTokens' in auth) {
        const renewed = await cloudCodexAuth(ctx.run.credentialOwnerId, true);
        if (!('chatgptAuthTokens' in renewed)) throw new HttpError(409, 'Codex account changed. Reconnect and resume.');
        secrets.push(renewed.chatgptAuthTokens.accessToken);
        await control({ mode: 'auth-refresh-result', runId: ctx.run.runId, requestId: event.requestId, ...renewed }); continue;
      }
      if (isApprovalRequest(event)) { approvals.handle(event); continue; }
      if (event.type === 'pull-request-request') {
        const request = parseCodexPrRequest({ repo: event.repo, base: event.base }, (ctx.run.runnerRepos ?? []).map(r => r.name));
        requestedPrs.set(request.repo, request);
        ctx.emit('status', { text: `PR publication queued for ${request.repo} against ${request.base}.` });
        continue;
      }
      if (event.type === 'portal-event' && allowedEvents.has(event.eventType) && event.payload && typeof event.payload === 'object') ctx.emit(event.eventType, event.payload);
      else if (event.type === 'status' && typeof event.text === 'string') ctx.emit('status', { text: event.text });
      else if (event.type === 'file') await files.handle(event);
      else if (event.type === 'check-result') ctx.emit('check-result', { ok: event.ok === true, ranAt: event.ranAt, steps: event.steps });
      else if (event.type === 'repo-changes' && typeof event.repo === 'string') changes.push({ repo: event.repo, base: String(event.base || ''), commits: Number(event.commits) || 0, files: Number(event.files) || 0 });
      else if (event.type === 'usage') latest = usageFrom(event);
      else if (event.type === 'error') failure = String(event.message || 'Codex runner failed');
      else if (event.type === 'result') {
        latest = usageFrom(event.usage ?? event);
        if (event.cancelled) throw new DOMException('Run cancelled', 'AbortError');
        if (event.exitCode !== 0) throw new HttpError(502, failure || 'Codex runner failed.');
        if (event.stateSaved !== true || !latest.threadId || typeof event.text !== 'string') throw new HttpError(502, 'Codex did not confirm durable conversation state.');
        result = { ...latest, text: event.text };
      }
    }
    if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
    if (!result || failure) throw new HttpError(502, failure || 'The Codex runner ended without a completion result.');
    await getSessionsRepository().updateWorkflow(ctx.run.workflowId, { engine_session_id: result.threadId, engine_session_engine: 'codex' });
    if (changes.length && ctx.run.projectId) {
      const { handleRepoChanges } = await import('../session-pr.ts');
      await handleRepoChanges({ workflowId: ctx.run.workflowId, runId: ctx.run.runId, projectId: ctx.run.projectId,
        userId: ctx.run.credentialOwnerId, engine: 'codex' }, changes.filter(c => !requestedPrs.has(c.repo))).catch(() => {});
    }
    if (ctx.run.projectId && requestedPrs.size) {
      const { createRequestedSessionPullRequest } = await import('../session-pr.ts');
      for (const request of requestedPrs.values()) {
        await createRequestedSessionPullRequest({ workflowId: ctx.run.workflowId, runId: ctx.run.runId,
          projectId: ctx.run.projectId, userId: ctx.run.credentialOwnerId, engine: 'codex' }, request);
      }
    }
    return result;
  } finally {
    ctx.signal?.removeEventListener('abort', cancel);
    await recordUsage(latest);
  }
}

export async function listCodexModelsViaAgentCore(userId: string): Promise<Array<{ id: string; label: string; default?: true }>> {
  const arn = process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN;
  if (!arn) throw new HttpError(503, 'Codex cloud runtime is not configured.');
  const auth = await cloudCodexAuth(userId);
  const signal = AbortSignal.timeout(60_000);
  for await (const raw of invokeAgentCore(arn, 'codex-models-' + randomUUID(), { mode: 'codex-models', ...auth }, signal)) {
    const event = raw as unknown as Record<string, any>;
    if (event.type === 'models' && Array.isArray(event.models)) return event.models.map((m: any) => ({ id: String(m.model), label: String(m.displayName || m.model), ...(m.isDefault ? { default: true as const } : {}) }));
    if (event.type === 'error') throw new HttpError(502, 'The Codex cloud runner could not list models.');
  }
  throw new HttpError(502, 'The Codex cloud runner returned no model catalog.');
}
