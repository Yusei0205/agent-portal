/**
 * Which of a person's sign-ins an engine uses when nothing was chosen.
 *
 * A sign-in marked as the default wins. For Kiro, a person who signed in (for example with AWS IAM Identity Center) but never
 * marked it as the default still has exactly one way to run Kiro, so the oldest usable Kiro sign-in is used rather than
 * reporting "no Kiro credentials". Claude Code is left alone: it can deliberately fall back to the portal's own Bedrock account.
 */

import { getCredentialsRepository } from './repositories/credentials.ts';
import type { CredentialRecord } from './repositories/credentials.ts';

/** A sign-in that can run: one with a stored secret or token (a half-finished device sign-in has none yet). */
function usable(c: CredentialRecord): boolean {
  return Boolean(c.secret_enc) || c.mode === 'bedrock_role';
}

export async function findUserCredential(userId: string | null | undefined, engine: string): Promise<CredentialRecord | null> {
  if (!userId) return null;
  const repo = getCredentialsRepository();
  const flagged = await repo.getDefaultByUserAndEngine(userId, engine);
  if (flagged) return flagged;
  if (engine !== 'kiro') return null;
  const mine = (await repo.listByUser(userId))
    .filter((c) => c.engine === 'kiro')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  // The cloud portal runs Kiro in its AgentCore runtime, which only takes an Identity Center sign-in, so prefer that there.
  const cloud = Boolean(process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN);
  return (cloud ? mine.find((c) => usable(c) && c.mode === 'identity_center') : undefined) ?? mine.find(usable) ?? null;
}
