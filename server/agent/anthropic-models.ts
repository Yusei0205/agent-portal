/**
 * Model names for Claude runs that use an Anthropic API key or a Claude plan (Pro / Max) instead of Bedrock.
 *
 * A session made while the portal ran on Bedrock, an agent file written for Bedrock, or the portal's Bedrock default can
 * name a Bedrock ID such as global.anthropic.claude-opus-4-6-v1. The Anthropic API does not know those names, and the
 * run would end with "There's an issue with the selected model", so they become the same model's Anthropic name
 * (claude-opus-4-6). Pure, so it can be tested without a run.
 */

const ALIAS = /^(haiku|sonnet|opus|fable)$/i;
const CLAUDE_ID = /^claude-[a-z0-9.-]+$/i;
// [inference-profile ARN/][region.]anthropic.claude-…[-vN[:M]]
const BEDROCK_ID = /(?:^|[/.])anthropic\.(claude-[a-z0-9-]+?)(?:-v\d+(?::\d+)?)?$/i;

/** The model a run with an Anthropic sign-in uses when neither the session nor the portal names one it can run. */
export const DEFAULT_ANTHROPIC_RUN_MODEL = 'claude-sonnet-4-5';

/**
 * A model name the Anthropic API takes: a Claude ID or one of the SDK's aliases (opus, sonnet, haiku, fable) as given,
 * a Bedrock ID or inference-profile ARN as the same model's Anthropic ID, and undefined for anything else.
 */
export function anthropicModelFor(model: string | null | undefined): string | undefined {
  const m = (model ?? '').trim();
  if (!m) return undefined;
  if (ALIAS.test(m)) return m.toLowerCase();
  if (CLAUDE_ID.test(m)) return m;
  return BEDROCK_ID.exec(m)?.[1].toLowerCase();
}

/**
 * The model for a run with an Anthropic sign-in: the session's own, as its Anthropic name when it is a Bedrock ID;
 * the portal's default model (translated the same way) when the session has none; claude-sonnet-4-5 when neither works.
 * `note` says what was changed and why, for the run's status line.
 */
export function resolveAnthropicModel(
  sessionModel: string | null | undefined,
  portalDefault: string | null | undefined,
): { model: string; note?: string } {
  const fallback = anthropicModelFor(portalDefault) ?? DEFAULT_ANTHROPIC_RUN_MODEL;
  const own = (sessionModel ?? '').trim();
  if (!own) return { model: fallback };
  if (ALIAS.test(own) || CLAUDE_ID.test(own)) return { model: own };
  const mapped = anthropicModelFor(own);
  if (mapped) {
    return { model: mapped, note: `This session's model ${own} is a Bedrock name, so the run uses ${mapped}, the same model on your Anthropic sign-in.` };
  }
  return { model: fallback, note: `This session's model ${own} cannot run with an Anthropic sign-in, so the run uses ${fallback}. Pick another with /model.` };
}
