import { openUserCodex, codexHome } from '../codex-auth.ts';
import { getCodexConfigFiles } from '../user-config.ts';
import { applyCodexConfig } from './codex-config.ts';
import type { RunContext } from './types.ts';
import { driveCodexTurn, type CodexTurnResult } from './codex-session.ts';
import { buildConversationRecap } from './recap.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';
import { getBudgetRepository } from '../repositories/budget.ts';
import { now } from '../util.ts';
import { cavemanMode, withCavemanGuidance } from './caveman-guidance.ts';
export { approveCodexRequest } from './codex-session.ts';

export async function runCodex(ctx: RunContext): Promise<string> {
  const { run, emit } = ctx;
  if (!run.credentialOwnerId) throw new Error('Codex requires a session owner with a Codex sign-in.');
  if (run.credentialId) throw new Error('Codex uses your Codex sign-in. Clear the Kiro or Claude credential selection.');
  const repo = getSessionsRepository();
  const recap = run.engineSessionId ? '' : await buildConversationRecap(run.workflowId, run.runId);
  // Terse replies, when the session was started with that option: the full instructions for a new Codex thread, a reminder when one continues.
  const guide = (text: string): string => withCavemanGuidance(text, cavemanMode(run.workflowId), !run.engineSessionId);
  const record = async (usage: Omit<CodexTurnResult, 'text'>) => {
    await repo.updateRun(run.runId, { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheTokens, cost_usd: 0, model: usage.model });
    if (usage.inputTokens || usage.outputTokens) await getBudgetRepository().record({
      user_id: run.credentialOwnerId, project_id: run.projectId, workflow_id: run.workflowId, run_id: null,
      cost_usd: 0, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
      provider: 'codex-subscription', model: usage.model, created_at: now(),
    });
  };
  let result: CodexTurnResult;
  if (process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN) {
    const { runCodexViaAgentCore } = await import('./codex-agentcore.ts');
    result = await runCodexViaAgentCore(ctx, guide(recap + run.goal), record);
  } else {
    const setup = applyCodexConfig(codexHome(run.credentialOwnerId), await getCodexConfigFiles(run.credentialOwnerId), run.leadAgent);
    result = await driveCodexTurn(ctx, {
      config: setup.config, instructions: setup.instructions,
      openClient: () => openUserCodex(run.credentialOwnerId!, run.workDir), managedAuth: true,
      prompt: guide(recap + run.goal), onUsage: record,
      onThread: async id => { await repo.updateWorkflow(run.workflowId, { engine_session_id: id, engine_session_engine: 'codex' }); },
    });
  }
  emit('run-complete', { result: result.text, cost_usd: 0 });
  return result.text;
}
