/**
 * Cursor engine: runs the Cursor CLI (`agent -p --output-format stream-json`) as a child process.
 *
 * Local / Docker path (the cloud path is server/agent/cursor-agentcore.ts). The CLI keeps its own chat store
 * (~/.cursor/chats), so a follow-up turn passes `--resume <session_id>`; the id is saved on the workflow with
 * engine_session_engine = 'cursor'.
 *
 * Approvals: print mode has no per-call approval. A trusted session runs with --force. An untrusted one runs with
 * --trust only, so file edits run but shell commands that are not allow-listed come back as "rejected" (shown to the
 * person as a blocked tool call). The prompt goes in on stdin, never on the command line.
 */

import type { RunContext } from './types.ts';
import { HttpError, now } from '../util.ts';
import { resolveCredentialEnv } from '../credentials.ts';
import { cursorAvailable } from '../cursor-cmd.ts';
import { CursorArgError, cursorArgs as buildArgs, driveCursorTurn, turnFailure, type CursorArgOptions } from './cursor-turn.ts';
import { buildConversationRecap } from './recap.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getBudgetRepository } from '../repositories/budget.ts';
import { cavemanMode, withCavemanGuidance } from './caveman-guidance.ts';
import { planMode, withPlanGuidance } from './plan-guidance.ts';
import { applyCursorRules } from './cursor-config.ts';
import { getCursorConfigFiles } from '../user-config.ts';

/** Argument list for a turn; an invalid model or session id is a 400. */
export function cursorArgs(opts: CursorArgOptions): string[] {
  try { return buildArgs(opts); } catch (e) { if (e instanceof CursorArgError) throw new HttpError(400, e.message); throw e; }
}

/** Records the turn's token usage on the run and in the budget. Cursor reports tokens, not dollars. */
export async function recordCursorUsage(
  run: { runId: string; projectId: string | null; workflowId: string; credentialOwnerId: string | null; model: string | null },
  state: { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number } | null; model: string | null },
): Promise<void> {
  const u = state.usage;
  if (!u) return;
  const input = u.inputTokens + u.cacheWriteTokens;
  const output = u.outputTokens + u.reasoningTokens;
  const model = state.model ?? run.model ?? '';
  await getSessionsRepository().updateRun(run.runId, { input_tokens: input, output_tokens: output, cache_read_tokens: u.cacheReadTokens, cost_usd: 0, model }).catch(() => {});
  if (input || output) {
    await getBudgetRepository().record({
      user_id: run.credentialOwnerId, project_id: run.projectId, workflow_id: run.workflowId, run_id: null,
      cost_usd: 0, input_tokens: input, output_tokens: output, provider: 'cursor', model, created_at: now(),
    }).catch(() => {});
  }
}

export async function runCursor(ctx: RunContext): Promise<string> {
  const { run, emit } = ctx;
  if (!run.credentialOwnerId) throw new HttpError(400, 'Cursor needs a session owner with a Cursor sign-in.');
  const repo = getSessionsRepository();

  const resumeId = run.engineSessionId;
  const recap = resumeId ? '' : await buildConversationRecap(run.workflowId, run.runId);
  const prompt = withPlanGuidance(withCavemanGuidance(recap + run.goal, cavemanMode(run.workflowId), !resumeId), planMode(run.workflowId));

  if (process.env.PORTAL_CURSOR_AGENTCORE_RUNTIME_ARN) {
    const { runCursorViaAgentCore } = await import('./cursor-agentcore.ts');
    return await runCursorViaAgentCore(ctx, prompt);
  }

  if (!(await cursorAvailable())) {
    throw new HttpError(502, 'The Cursor CLI was not found. Install it (https://cursor.com/cli) and set PORTAL_CURSOR_BIN to the agent binary if it is not on PATH.');
  }
  // The person's Cursor API key; with none stored the CLI falls back to its own `agent login` (a local install only).
  const credEnv = await resolveCredentialEnv('cursor', run.credentialOwnerId, run.credentialId);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(credEnv.CURSOR_API_KEY ? { CURSOR_API_KEY: credEnv.CURSOR_API_KEY } : {}) };

  // The person's own Cursor rules (Configuration > Cursor) go into the workspace the CLI runs in.
  try { applyCursorRules(run.workDir, await getCursorConfigFiles(run.credentialOwnerId)); }
  catch (e) { emit('status', { text: `Your Cursor rules were not applied: ${(e as Error).message}` }); }

  let savedSession: string | null = null;
  let saving: Promise<unknown> = Promise.resolve();
  const result = await driveCursorTurn({
    args: cursorArgs({ trusted: run.trusted, model: run.model, resumeId }),
    prompt, cwd: run.workDir, env, emit, signal: ctx.signal,
    heartbeatMs: Number(process.env.PORTAL_CURSOR_HEARTBEAT_MS) || undefined,
    onSession: (id) => {
      if (id === savedSession) return;
      savedSession = id;
      saving = repo.updateWorkflow(run.workflowId, { engine_session_id: id, engine_session_engine: 'cursor', updated_at: now() }).catch(() => {});
    },
  });
  await saving;
  // Count what was used even when the turn failed or was cancelled.
  await recordCursorUsage(run, result.state);

  if (ctx.signal?.aborted) throw new DOMException('Run cancelled', 'AbortError');
  const failure = turnFailure(result);
  if (failure) throw new HttpError(502, failure);

  const text = result.state.resultText ?? result.state.text;
  emit('status', { state: 'idle' });
  emit('run-complete', { result: text, cost_usd: 0 });
  return text;
}
