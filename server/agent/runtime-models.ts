/**
 * The Claude models the Claude AgentCore runtime can run on Bedrock, and which of them this AWS account may use.
 *
 * The runtime's role may call the models in RUNTIME_BEDROCK_MODELS (infra/lib/harness-stack.ts keeps the same list;
 * a test checks it). Whether the account may use a model is a separate question: Bedrock lists newer Claude models
 * in a region before an account is entitled to them, and calls to those fail with 403 "… is not available for this
 * account". GetFoundationModelAvailability answers it without calling the model, so the model pickers and /model
 * offer only models that will run.
 */

/** Bedrock IDs of the models the runtime's role may call, by family and version (newest first). */
export const RUNTIME_BEDROCK_MODELS: Readonly<Record<string, string>> = {
  'opus-5-5': 'anthropic.claude-opus-5-5',
  'sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  'haiku-5-5': 'anthropic.claude-haiku-5-5',
  'opus-4-6': 'anthropic.claude-opus-4-6-v1',
  'sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'opus-4-5': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'sonnet-4-5': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'haiku-4-5': 'anthropic.claude-haiku-4-5-20251001-v1:0',
};

/** The model a run uses when the session names none (the runner's DEFAULT_MODEL, agent-runner/src/validate.ts). */
export const RUNTIME_DEFAULT_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

/** A model's name for people: "Claude Sonnet 4.6" for global.anthropic.claude-sonnet-4-6 and the like. */
export function modelLabel(id: string): string {
  const m = /claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d))?(?![\d])/i.exec(id);
  if (!m) return id;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `Claude ${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// ── Availability ──────────────────────────────────────────────────────────────

/** true: the account may use it · false: it may not · null: could not tell (e.g. no permission to ask). */
export type Availability = boolean | null;
export type AvailabilityCheck = (modelId: string) => Promise<Availability>;

const AVAILABILITY_TTL_MS = 60 * 60 * 1000;
const availabilityCache = new Map<string, { at: number; value: Availability }>();

/** The region the Claude runtime runs in (from its ARN), else the portal's. */
function runtimeRegion(): string {
  const arn = process.env.PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN ?? '';
  return /^arn:aws[\w-]*:bedrock-agentcore:([a-z0-9-]+):/.exec(arn)?.[1] ?? process.env.AWS_REGION ?? 'ap-southeast-1';
}

/**
 * Whether this account may use a Bedrock model (its bare ID, anthropic.…), from GetFoundationModelAvailability.
 * Usable only when it is authorised, entitled, agreed and offered in the region. Cached for an hour.
 */
export const bedrockModelAvailability: AvailabilityCheck = async (modelId) => {
  const key = `${runtimeRegion()}|${modelId}`;
  const hit = availabilityCache.get(key);
  if (hit && Date.now() - hit.at < AVAILABILITY_TTL_MS) return hit.value;
  let value: Availability = null;
  try {
    type BM = {
      BedrockClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
      GetFoundationModelAvailabilityCommand: new (opts: object) => object;
    };
    const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-bedrock') as Promise<BM>);
    const client = new mod.BedrockClient({ region: runtimeRegion() });
    const r = await client.send(new mod.GetFoundationModelAvailabilityCommand({ modelId })) as {
      authorizationStatus?: string; entitlementAvailability?: string; regionAvailability?: string;
      agreementAvailability?: { status?: string };
    };
    value = r.authorizationStatus === 'AUTHORIZED'
      && r.entitlementAvailability === 'AVAILABLE'
      && r.regionAvailability === 'AVAILABLE'
      && r.agreementAvailability?.status === 'AVAILABLE';
  } catch (e) {
    console.warn(`[runtime-models] Could not check whether ${modelId} is available: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  availabilityCache.set(key, { at: Date.now(), value });
  return value;
};

/** Test hook: forget the cached answers. */
export function _clearAvailabilityCache(): void {
  availabilityCache.clear();
}

let availabilityCheck: AvailabilityCheck = bedrockModelAvailability;

/** Test hook: answer availability questions without AWS (null restores the Bedrock check). */
export function _setAvailabilityCheck(check: AvailabilityCheck | null): void {
  availabilityCheck = check ?? bedrockModelAvailability;
}

export interface RuntimeModelEntry { id: string; label: string; default?: true }

/**
 * The models a Claude session on AgentCore can use: the runtime's list (as global inference profiles, which the role
 * may call), without the ones this account may not use. A model whose availability could not be checked stays in
 * the list; a run on it that Bedrock refuses fails with a plain message (explainModelError).
 */
export async function runtimeClaudeModels(check: AvailabilityCheck = availabilityCheck): Promise<{ models: RuntimeModelEntry[]; hidden: string[] }> {
  const entries = Object.values(RUNTIME_BEDROCK_MODELS);
  const answers = await Promise.all(entries.map((id) => check(id).catch((): Availability => null)));
  const models: RuntimeModelEntry[] = [];
  const hidden: string[] = [];
  entries.forEach((id, i) => {
    const profile = `global.${id}`;
    if (answers[i] === false) { hidden.push(profile); return; }
    models.push({ id: profile, label: modelLabel(id), ...(profile === RUNTIME_DEFAULT_MODEL ? { default: true as const } : {}) });
  });
  return { models, hidden };
}

/**
 * True when this account is known NOT to be allowed to call the model (a Bedrock ID or one of its inference profiles).
 * Checked before a run starts: Claude Code retries a refused call for minutes before giving up, and the person would
 * wait all that time for an error that was known in a second. A model that could not be checked, or is not on the
 * runtime's list, is not refused here.
 */
export async function modelRefusedForAccount(model: string | undefined, check: AvailabilityCheck = availabilityCheck): Promise<boolean> {
  if (!model) return false;
  const bare = model.replace(/^(?:global|us|eu|apac|jp|au)\./, '');
  if (!Object.values(RUNTIME_BEDROCK_MODELS).includes(bare)) return false;
  return (await check(bare).catch((): Availability => null)) === false;
}

// ── A refused model call ──────────────────────────────────────────────────────

/** Claude Code's text for a turn that ended on an API error: "API Error: 403 …". */
const API_ERROR_TEXT = /^\s*API Error: \d{3}\b/;

/**
 * The error a run's answer reports, when its turn ended on an API error rather than a model reply: the runner's
 * `apiError`, or (from runners that do not send it) an answer that is only Claude Code's "API Error: …" text and
 * used no tokens.
 */
export function runApiError(result: { apiError?: string; metrics?: { inputTokens?: number; outputTokens?: number } }, answer: string): string | null {
  if (result.apiError && result.apiError.trim()) return result.apiError.trim();
  const used = (result.metrics?.inputTokens ?? 0) + (result.metrics?.outputTokens ?? 0);
  return used === 0 && API_ERROR_TEXT.test(answer) ? answer.trim() : null;
}

/** A refused model call, said plainly: what failed and what the person can do about it. */
export function explainModelError(error: string, model: string | undefined): string {
  const name = model ? modelLabel(model) : 'The model';
  const detail = error.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (/not available for this account|model access|isn't available|is not available/i.test(error)) {
    return `${name} is not available to this AWS account on Amazon Bedrock, so the run could not start. `
      + 'Pick another model with /model (it lists the models this account can use), or ask your AWS admin to enable this one. '
      + `Bedrock said: ${detail}`;
  }
  if (/\b403\b|AccessDenied|not authorized/i.test(error)) {
    return `Bedrock refused the call to ${name} (not allowed). Pick another model with /model, or ask your admin to check the access. `
      + `Bedrock said: ${detail}`;
  }
  return `The call to ${name} failed: ${detail}`;
}
