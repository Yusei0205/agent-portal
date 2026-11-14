/**
 * Shared AI model provider for test generation and agent steps.
 *
 * Provider selection order (per call):
 *   1. LiteLLM gateway — if provider.mode === 'litellm' and baseUrl is set.
 *   2. Resolved credential env (user bedrock_role cred or portal Bedrock settings):
 *        CLAUDE_CODE_USE_BEDROCK=1  → Bedrock Converse API.
 *        ANTHROPIC_API_KEY          → Anthropic Messages API.
 *   2b. A personal Kiro credential — the prompt goes to the Kiro runner (AgentCore), so the cloud portal needs no
 *      kiro-cli of its own.
 *   3. Kiro CLI — if provider.mode === 'kiro' and no personal claude-code credential
 *      overrides it (runs kiro-cli chat --no-interactive --trust-tools=).
 *   4. Demo / nothing configured    → throws a clear error.
 *
 * The Bedrock client is injectable via setBedrockClientFactory for tests.
 */

// ── Bedrock client abstraction ────────────────────────────────────────────────

export interface BedrockConverseInput {
  modelId: string;
  system?: Array<{ text: string }>;
  messages: Array<{ role: string; content: Array<BedrockContentBlock> }>;
  inferenceConfig?: { maxTokens?: number };
}

/** A single content block in a Bedrock Converse message. */
export type BedrockContentBlock =
  | { text: string }
  | { image: { format: 'png' | 'jpeg' | 'webp' | 'gif'; source: { bytes: Uint8Array } } };

export interface BedrockConverseOutput {
  output?: {
    message?: {
      content?: Array<{ text?: string }>;
    };
  };
}

export interface BedrockClientLike {
  converse(input: BedrockConverseInput): Promise<BedrockConverseOutput>;
}

type BedrockClientFactory = (
  region: string,
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
) => BedrockClientLike;

let _bedrockClientFactory: BedrockClientFactory | null = null;

/**
 * Override the Bedrock client factory used by callTextModel.
 * Pass null to restore the real SDK client.
 */
export function setBedrockClientFactory(fn: BedrockClientFactory | null): void {
  _bedrockClientFactory = fn;
}

/** Override callTextModel entirely for tests. Pass null to restore. */
let _callTextModelOverride: ((sys: string, usr: string, opts: CallTextModelOptions) => Promise<string>) | null = null;
export function setCallTextModelOverride(
  fn: ((sys: string, usr: string, opts: CallTextModelOptions) => Promise<string>) | null,
): void {
  _callTextModelOverride = fn;
}

async function makeBedrockClient(
  region: string,
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
): Promise<BedrockClientLike> {
  if (_bedrockClientFactory) return _bedrockClientFactory(region, credentials);

  type BRModule = {
    BedrockRuntimeClient: new (opts: object) => { send(cmd: object): Promise<unknown> };
    ConverseCommand: new (input: object) => object;
  };
  const mod = await (Function('m', 'return import(m)')('@aws-sdk/client-bedrock-runtime') as Promise<BRModule>);
  const client = new mod.BedrockRuntimeClient({
    region,
    ...(credentials ? { credentials } : {}),
  });
  return {
    converse: (input) => client.send(new mod.ConverseCommand(input)) as Promise<BedrockConverseOutput>,
  };
}

// ── Main provider call ────────────────────────────────────────────────────────

export interface CallTextModelOptions {
  maxTokens?: number;
  createdBy?: string | null;
  /** The person's own credential to use (must be theirs); their default one when absent. */
  credentialId?: string | null;
  /** The model to use instead of the portal's default (a Bedrock model id or an Anthropic model id, to match the credential). */
  model?: string | null;
  /**
   * Optional image attachments for multi-modal generation.
   * Each entry is a raw image buffer, its MIME type, and a filename (for diagnostics).
   */
  images?: Array<{ data: Buffer; mimeType: string; filename: string }>;
}

// ── Which engine's credential a call uses ────────────────────────────────────

export type TextEngine = 'claude-code' | 'kiro' | 'codex';

/**
 * The engine a text call should use for this person: the engine of the credential they chose, otherwise their default
 * Claude Code credential, otherwise any Kiro credential of theirs. null when they have neither (the portal's own
 * provider settings then apply).
 */
export async function pickTextEngine(userId: string | null, credentialId: string | null): Promise<TextEngine | null> {
  if (!userId) return null;
  if (credentialId === 'codex-account') {
    const { hasCodexLogin } = await import('../codex-auth.ts');
    if (!await hasCodexLogin(userId)) throw new Error('Connect your ChatGPT account in Agent sign-ins.');
    return 'codex';
  }
  const { getCredentialsRepository } = await import('../repositories/credentials.ts');
  const repo = getCredentialsRepository();
  if (credentialId) {
    const row = await repo.getByIdAndUser(credentialId, userId);
    if (row && (row.engine === 'claude-code' || row.engine === 'kiro')) return row.engine;
    return null;
  }
  if (await repo.getDefaultByUserAndEngine(userId, 'claude-code')) return 'claude-code';
  const mine = await repo.listByUser(userId);
  if (mine.some((c) => c.engine === 'claude-code')) return 'claude-code';
  if (mine.some((c) => c.engine === 'kiro')) return 'kiro';
  return null;
}

/**
 * The most the Kiro runner accepts as one prompt (MAX_PROMPT in kiro-runner/src/validate.ts). A longer prompt is refused with
 * a bare 400, which comes back as "AgentCore returned HTTP 424" and says nothing about why.
 */
export const KIRO_RUNNER_MAX_PROMPT = 100_000;
/** What callTextModel adds around the system and user text for Kiro (the reply instructions), with room to spare. */
const KIRO_WRAPPER_CHARS = 600;

/**
 * The most system and user text together that callTextModel can send for this person and sign-in, or null when the model has
 * no limit that matters. Callers that build a long prompt from a document use it to cut the document to fit.
 */
export async function textPromptLimit(userId: string | null, credentialId: string | null = null): Promise<number | null> {
  if (!userId || !(process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN || _kiroRunnerOverride)) return null;
  return (await pickTextEngine(userId, credentialId)) === 'kiro' ? KIRO_RUNNER_MAX_PROMPT - KIRO_WRAPPER_CHARS : null;
}

let _kiroRunnerOverride: ((prompt: string, userId: string, credentialId: string | null, model?: string | null) => Promise<string>) | null = null;
/** Replace the Kiro runner call in tests. Pass null to restore. */
export function setKiroRunnerOverride(fn: typeof _kiroRunnerOverride): void {
  _kiroRunnerOverride = fn;
}

/**
 * Send a prompt to the Kiro runner (AgentCore) with the person's Kiro credential and return the reply text. Each call is
 * its own short session. Kiro picks its model itself.
 */
async function callKiroViaRunner(
  prompt: string,
  userId: string,
  credentialId: string | null,
  model: string | null = null,
): Promise<string> {
  if (prompt.length > KIRO_RUNNER_MAX_PROMPT) {
    throw new Error(`The text to send is ${prompt.length.toLocaleString('en-US')} characters, and Kiro accepts at most ${KIRO_RUNNER_MAX_PROMPT.toLocaleString('en-US')}. Use a shorter document, or choose a Claude sign-in, which takes longer text.`);
  }
  if (_kiroRunnerOverride) return _kiroRunnerOverride(prompt, userId, credentialId, model);
  const runtimeArn = process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN;
  if (!runtimeArn) throw new Error('The Kiro runner is not set up for this portal, so a Kiro credential cannot be used here.');
  const { resolveCredentialEnv } = await import('../credentials.ts');
  const { getCredentialsRepository } = await import('../repositories/credentials.ts');
  const { kiroTokenFromEnv } = await import('../agent/kiro.ts');
  const { runKiroViaAgentCore } = await import('../agent/kiro-agentcore.ts');
  const { randomUUID } = await import('node:crypto');

  const repo = getCredentialsRepository();
  const row = credentialId
    ? await repo.getByIdAndUser(credentialId, userId)
    : (await repo.listByUser(userId)).find((c) => c.engine === 'kiro') ?? null;
  if (!row || row.engine !== 'kiro') throw new Error('That Kiro credential was not found. Choose one of your own credentials.');

  const env = await resolveCredentialEnv('kiro', userId, row.id);
  const token = kiroTokenFromEnv(env);
  if (!token.accessToken) throw new Error('The Kiro credential has no valid token. Sign in again under Credentials.');

  // A minimal run context: nothing to approve, nothing shown live. The reply comes back as text parts.
  const ctx = {
    run: { runId: randomUUID(), workflowId: '' },
    emit: () => {},
    awaitInput: async () => ({ decision: 'deny' as const, remember: false, message: '' }),
    allowed: new Set<string>(),
    signal: undefined,
  } as unknown as Parameters<typeof runKiroViaAgentCore>[0];

  const { textParts } = await runKiroViaAgentCore(ctx, {
    runtimeArn,
    runId: randomUUID(),
    prompt,
    token,
    credentialId: row.id,
    expectedCiphertext: row.secret_enc ?? null,
    model,
  });
  return textParts.join('');
}

/**
 * Call the portal's configured AI provider and return the response text.
 *
 * @param systemPrompt  System instruction sent to the model.
 * @param userMessage   The user-turn text.
 * @param opts          Optional: maxTokens (default 4096), createdBy (user id), images (multi-modal).
 */
export async function callTextModel(
  systemPrompt: string,
  userMessage: string,
  opts: CallTextModelOptions = {},
): Promise<string> {
  if (_callTextModelOverride) return _callTextModelOverride(systemPrompt, userMessage, opts);
  const { maxTokens = 4096, createdBy = null, images = [], credentialId = null, model: modelOverride = null } = opts;

  const { getSettings } = await import('../settings.ts');
  const { resolveCredentialEnv } = await import('../credentials.ts');
  const { getDb: _getDb } = await import('../db.ts');
  const { decrypt: _decrypt } = await import('../secrets.ts');
  const { config: _config } = await import('../config.ts');

  const settings = getSettings();
  const personalEngine = await pickTextEngine(createdBy, credentialId);
  if (personalEngine === 'codex' || (!personalEngine && settings.provider.mode === 'codex')) {
    if (!createdBy) throw new Error('Codex AI generation requires a signed-in portal user with a ChatGPT connection.');
    if (images.length) throw new Error('Codex portal AI generation currently accepts text only. Remove image attachments or select an image-capable provider.');
    const { callCodexText } = await import('../agent/codex-text.ts');
    return callCodexText(systemPrompt + '\n\n' + userMessage + '\n\nReturn only the requested output. Do not use tools or ask questions.', createdBy, modelOverride || (settings.provider.mode === 'codex' ? settings.defaultModel : null));
  }

  // A person who works with Kiro has a Kiro credential and no Claude one: the prompt goes to the Kiro runner.
  if (process.env.PORTAL_KIRO_AGENTCORE_RUNTIME_ARN || _kiroRunnerOverride) {
    if ((await pickTextEngine(createdBy, credentialId)) === 'kiro' && createdBy) {
      const imageNote = images.length > 0 ? `

[Note: ${images.length} image attachment(s) were provided but cannot be forwarded to Kiro. Base your answer on the text only.]` : '';
      return callKiroViaRunner(
        `${systemPrompt}

${userMessage}${imageNote}

Reply with the requested output only: no explanation, no markdown fences, no questions and no tools. If something is unclear, make a reasonable assumption and still produce the output.`,
        createdBy,
        credentialId,
        modelOverride,
      );
    }
  }

  // The portal's own provider may be unset (demo) while the person has a credential of their own: that is enough.
  const personalEnv = settings.provider.mode === 'demo' ? await resolveCredentialEnv('claude-code', createdBy, credentialId) : null;
  if (settings.provider.mode === 'demo' && !personalEnv?.CLAUDE_CODE_USE_BEDROCK && !personalEnv?.ANTHROPIC_API_KEY) {
    throw new Error(
      'No AI provider configured. Set up an Anthropic API key, Bedrock, LiteLLM, or Kiro CLI ' +
      'in Settings to use this feature.',
    );
  }

  // ── 1. LiteLLM gateway ────────────────────────────────────────────────────
  if (settings.provider.mode === 'litellm' && settings.litellm.baseUrl) {
    const llModel = settings.litellm.model || 'gpt-4o';
    const keyEncRaw = _getDb().prepare('SELECT value FROM settings WHERE key = ?').get('litellm.key.enc') as
      | { value: string }
      | undefined;
    let apiKey = '';
    if (keyEncRaw?.value) {
      try { apiKey = _decrypt(keyEncRaw.value, _config.secretKey); } catch { /* ignore */ }
    }

    // Build the user content: text + optional images (OpenAI image_url style)
    type LiteLLMContentPart =
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } };

    const LITELLM_IMAGE_LIMIT = 20 * 1024 * 1024; // 20 MB
    for (const img of images) {
      if (img.data.length > LITELLM_IMAGE_LIMIT) {
        throw new Error(
          `Image "${img.filename}" (${(img.data.length / 1024 / 1024).toFixed(1)} MB) exceeds the LiteLLM image limit of 20 MB. ` +
          'Please reduce the image size before attaching it.',
        );
      }
    }

    const userContent: LiteLLMContentPart[] = [{ type: 'text', text: userMessage }];
    for (const img of images) {
      const b64 = img.data.toString('base64');
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${b64}` },
      });
    }

    const resp = await fetch(`${settings.litellm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: images.length > 0 ? userContent : userMessage },
        ],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { error?: { message?: string } | string };
      const msg = typeof err.error === 'object' && err.error !== null
        ? ((err.error as { message?: string }).message ?? resp.statusText)
        : String(err.error ?? resp.statusText);
      throw new Error(`LiteLLM API error: ${msg}`);
    }
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }

  // ── 2. Resolve credential env (user cred first, then portal fallback) ─────
  const env = personalEnv ?? await resolveCredentialEnv('claude-code', createdBy, credentialId);

  // ── 3. Kiro CLI mode ─────────────────────────────────────────────────────
  // Use kiro-cli when provider mode is kiro AND the user has no personal
  // claude-code credential that would give a Bedrock or Anthropic key.
  // Personal credentials (CLAUDE_CODE_USE_BEDROCK or ANTHROPIC_API_KEY) always
  // take precedence — they fall through to the Bedrock/Anthropic branches below.
  if (settings.provider.mode === 'kiro' && !env.CLAUDE_CODE_USE_BEDROCK && !env.ANTHROPIC_API_KEY) {
    return callKiroCli(
      systemPrompt,
      userMessage,
      images,
      settings.kiroApiKeyEnc,
      _config.secretKey,
      settings.defaultModel,
    );
  }

  const modelId = modelOverride || (settings.defaultModel ? settings.defaultModel : null);

  if (!modelId) {
    throw new Error(
      'No AI model configured. Set a model in Settings (Bedrock model, LiteLLM model, or Claude model list) ' +
      'to use this feature.',
    );
  }

  // ── 3a. Bedrock Converse API ──────────────────────────────────────────────
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
    const region = env.AWS_REGION || settings.provider.bedrockRegion || 'us-east-1';
    const credentials = env.AWS_ACCESS_KEY_ID
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        }
      : undefined;

    const BEDROCK_IMAGE_LIMIT = 3.75 * 1024 * 1024; // 3.75 MB decoded
    const userContentBlocks: BedrockContentBlock[] = [{ text: userMessage }];
    for (const img of images) {
      if (img.data.length > BEDROCK_IMAGE_LIMIT) {
        throw new Error(
          `Image "${img.filename}" (${(img.data.length / 1024 / 1024).toFixed(1)} MB) exceeds the Bedrock image limit of 3.75 MB. ` +
          'Please reduce the image size before attaching it.',
        );
      }
      const format = bedrockImageFormat(img.mimeType);
      userContentBlocks.push({
        image: { format, source: { bytes: new Uint8Array(img.data) } },
      });
    }

    const client = await makeBedrockClient(region, credentials);
    const result = await client.converse({
      modelId,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: userContentBlocks }],
      inferenceConfig: { maxTokens },
    });
    return result.output?.message?.content?.[0]?.text ?? '';
  }

  // ── 3b. Anthropic Messages API ────────────────────────────────────────────
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No AI provider configured. Set up an Anthropic API key, Bedrock, LiteLLM, or Kiro CLI ' +
      'in Settings, or add a personal credential.',
    );
  }

  const ANTHROPIC_IMAGE_LIMIT = 5 * 1024 * 1024; // 5 MB decoded
  type AnthropicContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

  const anthropicContent: AnthropicContentPart[] = [];
  for (const img of images) {
    if (img.data.length > ANTHROPIC_IMAGE_LIMIT) {
      throw new Error(
        `Image "${img.filename}" (${(img.data.length / 1024 / 1024).toFixed(1)} MB) exceeds the Anthropic image limit of 5 MB. ` +
        'Please reduce the image size before attaching it.',
      );
    }
    anthropicContent.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.data.toString('base64') },
    });
  }
  anthropicContent.push({ type: 'text', text: userMessage });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: images.length > 0 ? anthropicContent : userMessage }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Anthropic API error: ${err.error?.message ?? resp.statusText}`);
  }
  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> };
  return data.content?.find((c) => c.type === 'text')?.text ?? '';
}

// ── Kiro CLI helper ───────────────────────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[mGKHFJ]/g;

/**
 * Call kiro-cli chat --no-interactive with the combined prompt on stdin.
 *
 * Prompts are delivered via stdin (not CLI args) to avoid the 32K Windows
 * command-line length limit and to support very large attachment-derived prompts.
 *
 * Images cannot be forwarded to kiro-cli in non-interactive mode without tool
 * access; when images are present a brief note is appended to the user message
 * so the model can still answer from text context alone.
 *
 * Tool trust is intentionally empty (--trust-tools=): kiro-cli cannot read or
 * write files during this call, which limits accidental side-effects.
 */
async function callKiroCli(
  systemPrompt: string,
  userMessage: string,
  images: Array<{ data: Buffer; mimeType: string; filename: string }>,
  kiroApiKeyEnc: string,
  secretKey: string,
  defaultModel: string,
): Promise<string> {
  const { spawn } = await import('node:child_process');

  const imageNote = images.length > 0
    ? `\n\n[Note: ${images.length} image attachment(s) were provided but cannot be ` +
      `forwarded to Kiro CLI in non-interactive mode. ` +
      `Please base your response on the text content only.]`
    : '';
  const combinedPrompt = `${systemPrompt}\n\n${userMessage}${imageNote}`;

  const modelArgs: string[] = [];
  const dm = defaultModel?.trim();
  if (dm && dm !== 'auto') {
    modelArgs.push('--model', dm);
  }

  const fake = process.env.PORTAL_KIRO_FAKE;
  const kiroCmd = fake ? process.execPath : 'kiro-cli';
  const kiroArgs = fake
    ? [fake, 'chat', '--no-interactive', '--trust-tools=', ...modelArgs]
    : ['chat', '--no-interactive', '--trust-tools=', ...modelArgs];

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (kiroApiKeyEnc) {
    try {
      const { decrypt: dec } = await import('../secrets.ts');
      const kiroKey = dec(kiroApiKeyEnc, secretKey);
      if (kiroKey) childEnv.KIRO_API_KEY = kiroKey;
    } catch { /* best effort: kiro-cli will use its own session if key is missing */ }
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(kiroCmd, kiroArgs, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timeoutMs = 300_000; // 5 minutes
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ok */ }
      reject(new Error('Kiro CLI timed out after 5 minutes.'));
    }, timeoutMs);
    timer.unref();

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e?.code === 'ENOENT') {
        reject(new Error(
          'kiro-cli is not installed or not on PATH. ' +
          'Install it via Settings › Tool packs › Kiro CLI.',
        ));
      } else {
        reject(new Error(`Could not start kiro-cli: ${e.message}`));
      }
    });

    try {
      child.stdin!.write(combinedPrompt + '\n');
      child.stdin!.end();
    } catch { /* stdin may already be closed if the process errored immediately */ }

    const stdoutParts: string[] = [];
    let stderrTail = '';

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => { stdoutParts.push(chunk); });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        const tail = stderrTail.toLowerCase();
        let msg: string;
        if (
          tail.includes('not signed in') || tail.includes('not logged in') ||
          tail.includes('please login') || tail.includes('please sign in') ||
          tail.includes('unauthenticated')
        ) {
          msg = 'Kiro CLI is not signed in. Sign in via Settings › Provider › Kiro sign-in.';
        } else if (tail.includes('expired') && (tail.includes('token') || tail.includes('session'))) {
          msg = 'Kiro CLI session has expired. Sign in again via Settings › Provider › Kiro sign-in.';
        } else {
          msg = `kiro-cli exited with code ${code}.${stderrTail.trim() ? ` ${stderrTail.trim().slice(-500)}` : ''}`;
        }
        reject(new Error(msg));
        return;
      }
      resolve(stdoutParts.join('').replace(ANSI_RE, '').trim());
    });
  });
}

// ── Image helpers ─────────────────────────────────────────────────────────────

function bedrockImageFormat(mimeType: string): 'png' | 'jpeg' | 'webp' | 'gif' {
  const map: Record<string, 'png' | 'jpeg' | 'webp' | 'gif'> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[mimeType] ?? 'png';
}
