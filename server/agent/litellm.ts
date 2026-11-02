/**
 * LiteLLM engine — runs PR reviews (and other workflows) via a LiteLLM-compatible
 * OpenAI chat endpoint.
 *
 * This engine is a direct-call provider: it does NOT spawn a subprocess.
 * Each review is a single chat-completions request per the diff or goal text.
 *
 * Requirements:
 *   - LiteLLM base URL must be configured in Settings › Provider › LiteLLM.
 *   - If the URL is missing, the run fails immediately with a clear error.
 *   - Token usage from the provider response is recorded (not estimated).
 *
 * Runner wiring (cannot be done here — see report):
 *   runner.ts needs one additional dispatch branch:
 *     else if (agentRun.engine === 'litellm') { result = await runLiteLLM(runContext); }
 *   Import: import { runLiteLLM } from './litellm.ts';
 */

import { insert } from '../db.ts';
import { now, HttpError } from '../util.ts';
import { getSetting, getSettings } from '../settings.ts';
import { getDb } from '../db.ts';
import { decrypt } from '../secrets.ts';
import { config } from '../config.ts';
import type { RunContext } from './types.ts';
import { getSessionsRepository } from '../repositories/sessions.ts';

// ── Settings ──────────────────────────────────────────────────────────────────

function getLiteLLMConfig(): { baseUrl: string; apiKey: string; model: string } {
  const db = getDb();
  const baseUrl = (getSetting(db, 'litellm.baseUrl') ?? '').replace(/\/$/, '');
  const keyEnc = getSetting(db, 'litellm.key.enc') ?? '';
  const modelRaw = getSetting(db, 'litellm.model') ?? '"gpt-4o"';
  let model = 'gpt-4o';
  try { model = JSON.parse(modelRaw) as string; } catch { /* keep default */ }

  let apiKey = '';
  if (keyEnc) {
    try { apiKey = decrypt(keyEnc, config.secretKey); } catch { /* leave empty */ }
  }
  return { baseUrl, apiKey, model };
}

// ── Review system instructions ────────────────────────────────────────────────

const REVIEW_SYSTEM = `
You are performing a code review. Read the provided diff and identify real defects,
security risks, reliability issues, and best-practice violations.

At the end of your response output all findings as a JSON array in a markdown code block:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 42,
    "severity": "critical|high|medium|low|info",
    "title": "Short description",
    "body": "Detailed explanation and suggestion.",
    "confidence": 0.9
  }
]
\`\`\`

Use severities: critical, high, medium, low, info.
Set confidence 0.0–1.0. Output [] when the diff is clean.
`.trim();

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run a workflow using the LiteLLM chat-completions endpoint.
 * Emits events via ctx.emit() and returns the final summary text.
 *
 * Called by runner.ts (pending the one-line hook described above).
 */
export async function runLiteLLM(ctx: RunContext): Promise<string> {
  const { run, emit } = ctx;
  const llm = getLiteLLMConfig();

  if (!llm.baseUrl) {
    throw new HttpError(
      400,
      'LiteLLM base URL is not configured. Add it in Settings › Provider › LiteLLM.',
    );
  }

  let prompt = run.goal;
  if (run.kind === 'review') {
    prompt = `${run.goal}\n\n${REVIEW_SYSTEM}`;
  }

  // Resolve model: prefer run.leadAgent (treated as model override) or settings default
  const model = run.leadAgent ?? llm.model;

  const messages = [
    { role: 'system', content: 'You are a helpful AI assistant.' },
    { role: 'user', content: prompt },
  ];

  emit('assistant-text', { text: '' }); // signal run start to UI

  let responseText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages }),
      signal: ctx.signal ?? AbortSignal.timeout(300_000),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      const msg = (body as { error?: { message?: string } | string }).error;
      const msgStr = typeof msg === 'object' && msg !== null ? ((msg as { message?: string }).message ?? resp.statusText) : String(msg ?? resp.statusText);
      throw new HttpError(502, `LiteLLM API error (${resp.status}): ${msgStr}`);
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    responseText = data.choices?.[0]?.message?.content ?? '';
    inputTokens = data.usage?.prompt_tokens ?? 0;
    outputTokens = data.usage?.completion_tokens ?? 0;
  } catch (e: unknown) {
    if (ctx.signal?.aborted || (e as { name?: string })?.name === 'AbortError') {
      throw new DOMException('Run cancelled', 'AbortError');
    }
    throw e;
  }

  if (responseText) {
    emit('assistant-text', {
      text: responseText,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  }

  const costUsd = 0; // LiteLLM cost varies by backend; leave as 0 (billing via LiteLLM)

  const repo = getSessionsRepository();
  await repo.updateRun(run.runId, {
    cost_usd: costUsd,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    model,
  });

  if (inputTokens > 0 || outputTokens > 0) {
    // S1-TODO(budget): budget_usage insert — budget module conversion deferred
    const wfRow = await repo.getWorkflowById(run.workflowId);
    insert('budget_usage', {
      user_id: wfRow?.created_by ?? null,
      project_id: run.projectId,
      workflow_id: run.workflowId,
      run_id: null,
      cost_usd: costUsd,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      provider: 'litellm',
      model,
      created_at: now(),
    });
  }

  const summary = responseText.trim() || 'LiteLLM run complete.';
  emit('run-complete', { result: summary, cost_usd: costUsd });
  return summary;
}
