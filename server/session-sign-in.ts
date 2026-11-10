/**
 * Which sign-in a session runs on, in words a person recognises: a Claude Pro / Max plan, an Anthropic API key,
 * Amazon Bedrock, a ChatGPT plan, and so on. The status bar shows it so a Claude session on a plan is told apart from
 * one on Bedrock without reading model IDs.
 *
 * It follows the order runs use: the session's own sign-in, else its owner's default for the engine, else the portal's
 * provider. It comes from the sign-in's type, never from the name the person gave it.
 */

import { getCredentialsRepository } from './repositories/credentials.ts';
import { findUserCredential } from './credential-default.ts';
import { isBedrockRuntimeChoice } from './credentials.ts';
import { getSettings } from './settings.ts';

export type SignInKind = 'plan' | 'api_key' | 'bedrock' | 'sso' | 'chatgpt' | 'portal' | 'missing';
export interface SessionSignIn { kind: SignInKind; label: string; detail: string }

const CLAUDE_MODES: Record<string, SessionSignIn> = {
  subscription_token: { kind: 'plan', label: 'Pro/Max plan', detail: 'Your Claude Pro or Max subscription' },
  api_key: { kind: 'api_key', label: 'Anthropic API key', detail: 'An Anthropic API key (billed to the key)' },
  aws_keys: { kind: 'bedrock', label: 'Bedrock (AWS keys)', detail: 'Amazon Bedrock with your AWS access keys' },
  bedrock_role: { kind: 'bedrock', label: 'Bedrock (IAM role)', detail: 'Amazon Bedrock through an IAM role' },
};
const KIRO_MODES: Record<string, SessionSignIn> = {
  api_key: { kind: 'api_key', label: 'Kiro API key', detail: 'A Kiro API key' },
  identity_center: { kind: 'sso', label: 'Company sign-in (AWS SSO)', detail: 'Kiro through your company AWS sign-in' },
};

export async function sessionSignIn(w: { engine?: unknown; credential_id?: unknown; created_by?: unknown }): Promise<SessionSignIn | null> {
  const engine = String(w.engine ?? '');
  if (engine === 'codex') return { kind: 'chatgpt', label: 'ChatGPT plan', detail: 'Your ChatGPT plan, signed in under Connect > Agent sign-ins' };
  if (engine !== 'claude-code' && engine !== 'kiro') return null;

  const owner = w.created_by ? String(w.created_by) : null;
  const credentialId = w.credential_id ? String(w.credential_id) : null;
  if (isBedrockRuntimeChoice(engine, credentialId)) {
    return { kind: 'bedrock', label: 'Bedrock (portal AWS)', detail: "Amazon Bedrock in the portal's own AWS account" };
  }

  const modes = engine === 'kiro' ? KIRO_MODES : CLAUDE_MODES;
  const cred = credentialId
    ? (owner ? await getCredentialsRepository().getByIdAndUser(credentialId, owner) : null)
    : await findUserCredential(owner, engine);
  if (credentialId && !cred) return { kind: 'missing', label: 'sign-in not found', detail: 'The sign-in this session used was removed. Switch the session to another one.' };
  if (cred) return modes[String(cred.mode)] ?? { kind: 'api_key', label: String(cred.mode), detail: String(cred.mode) };

  // No sign-in of its own: the portal's provider.
  if (engine === 'kiro') return { kind: 'portal', label: 'Portal Kiro key', detail: "The portal's own Kiro provider" };
  const mode = getSettings().provider.mode;
  if (mode === 'bedrock') return { kind: 'bedrock', label: 'Portal default (Bedrock)', detail: "The portal's provider: Amazon Bedrock" };
  if (mode === 'anthropic') return { kind: 'portal', label: 'Portal default (Anthropic)', detail: "The portal's provider: Anthropic API" };
  return { kind: 'portal', label: mode === 'demo' ? 'Demo mode' : `Portal default (${mode})`, detail: "The portal's own provider" };
}
