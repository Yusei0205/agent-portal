/**
 * Which engine, sign-in and model the Create modules (diagrams, documents, presentations) run with.
 *
 * They used to start every run on the simulated "demo" engine, which writes no files, so a diagram or document
 * never appeared. A run now uses one of the person's own Kiro or Claude sign-ins (the one they pick, else their
 * default), exactly like a session.
 */

import { badRequest } from './util.ts';
import { getCredentialsRepository } from './repositories/credentials.ts';

export interface CreateAi {
  engine: 'kiro' | 'claude-code' | 'demo';
  credential_id: string | null;
  model: string;
}

const MODEL_RE = /^[A-Za-z0-9._:/@-]{1,120}$/;

/** True when agents run in the cloud (AgentCore), where the simulated engine is never what anyone wants. */
export function runsInCloud(): boolean {
  return Boolean(process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN || process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN);
}

/**
 * `body` may carry `credentialId` and `model` (what the picker in the dialog sends). Without a credential the
 * person's default sign-in is used. With no sign-in at all, a cloud portal asks for one; a local one keeps the
 * simulated engine so it can be tried without an account.
 */
export async function resolveCreateAi(userId: string, body: Record<string, unknown> = {}): Promise<CreateAi> {
  const repo = getCredentialsRepository();
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (requestedModel && !MODEL_RE.test(requestedModel)) throw badRequest('model is not a valid model id');

  const credentialId = typeof body.credentialId === 'string' ? body.credentialId.trim() : '';
  if (credentialId) {
    const c = await repo.getByIdAndUser(credentialId, userId);
    if (!c || (c.engine !== 'kiro' && c.engine !== 'claude-code')) throw badRequest('That sign-in was not found. Pick one of your Kiro or Claude sign-ins.');
    return { engine: c.engine, credential_id: c.id, model: requestedModel };
  }

  for (const engine of ['claude-code', 'kiro'] as const) {
    const d = await repo.getDefaultByUserAndEngine(userId, engine);
    if (d) return { engine, credential_id: d.id, model: requestedModel };
  }
  const own = (await repo.listByUser(userId)).filter((c) => c.engine === 'claude-code' || c.engine === 'kiro');
  const first = own.find((c) => c.engine === 'claude-code') ?? own[0];
  if (first) return { engine: first.engine as 'kiro' | 'claude-code', credential_id: first.id, model: requestedModel };

  if (runsInCloud()) {
    throw badRequest('Add a Kiro or Claude sign-in under Connect › Agent sign-ins first. An agent has to write the file, and it needs a sign-in to run.');
  }
  return { engine: 'demo', credential_id: null, model: '' };
}
