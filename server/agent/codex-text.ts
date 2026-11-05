import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexUsesCloud, openUserCodex, hasCodexLogin } from '../codex-auth.ts';
import { codexAccessToken } from '../codex-oauth.ts';
import { invokeAgentCore } from './kiro-agentcore.ts';
import { driveCodexTurn } from './codex-session.ts';

/** Short, isolated generation request using only the requesting person's Codex connection. */
export async function callCodexText(prompt: string, userId: string, model?: string | null): Promise<string> {
  if (!await hasCodexLogin(userId)) throw new Error('Connect your ChatGPT account in Connect > Agent sign-ins to use the Codex provider.');
  const signal = AbortSignal.timeout(120_000);
  if (codexUsesCloud()) {
    const arn = process.env.PORTAL_CODEX_AGENTCORE_RUNTIME_ARN;
    if (!arn) throw new Error('The Codex AgentCore runner is not configured.');
    const accessToken = await codexAccessToken(userId);
    for await (const raw of invokeAgentCore(arn, 'codex-text-' + randomUUID(), { mode: 'codex-text', prompt, accessToken, model }, signal)) {
      const event = raw as unknown as Record<string, any>;
      if (event.type === 'error') throw new Error('Codex could not complete this AI request. Check your connection and account limits.');
      if (event.type === 'result' && event.exitCode === 0 && typeof event.text === 'string') return event.text;
    }
    throw new Error('Codex returned no completed AI response.');
  }
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-codex-text-'));
  try {
    const result = await driveCodexTurn({ run: { workDir, goal: prompt, trusted: false, model: model || null, engineSessionId: null, permissions: { rules: [] } },
      signal, allowed: new Set(), emit: () => {}, awaitInput: async () => ({ decision: 'deny', remember: false, message: 'Tools requiring approval are unavailable for portal AI generation.' }) },
    { managedAuth: true, openClient: () => openUserCodex(userId, workDir), config: { 'features.shell_tool': false, 'features.multi_agent': false } });
    return result.text;
  } finally { await fs.rm(workDir, { recursive: true, force: true }); }
}
