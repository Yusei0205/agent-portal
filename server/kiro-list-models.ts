/**
 * Shared Kiro model-listing helper.
 *
 * Spawns `kiro-cli chat --list-models --format json` and falls back to the
 * plain-text table parser for older CLI versions that don't support --format.
 *
 * Imported by both server/models.ts and server/settings.ts.
 * Has no imports from models.ts or settings.ts to avoid circular dependencies.
 */

import { spawn } from 'node:child_process';
import { resolveKiroCmd } from './kiro-cmd.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KiroModelRaw {
  model_id: string;
  model_name?: string;
  description?: string;
  context_window_tokens?: number;
  rate_multiplier?: number;
  rate_unit?: string;
  /** true if this was the default_model in the JSON response, or marked with * in plain text. */
  is_default?: boolean;
}

export interface KiroRawListResult {
  models: KiroModelRaw[];
  error?: string;
}

// ── Internal parsers ──────────────────────────────────────────────────────────

const MODEL_ROW_RE = /^([* ]) +(\S+) +(\d+\.\d+x) +credits(.*)/;

function parseJsonOutput(output: string): KiroRawListResult {
  try {
    const parsed = JSON.parse(output.trim()) as {
      models?: Array<{
        model_id?: string;
        model_name?: string;
        description?: string;
        context_window_tokens?: number;
        rate_multiplier?: number;
        rate_unit?: string;
      }>;
      default_model?: string;
    };
    if (!Array.isArray(parsed.models)) {
      return { models: [], error: 'kiro-cli JSON response missing models array.' };
    }
    const defaultModelId = parsed.default_model ?? '';
    const models: KiroModelRaw[] = parsed.models
      .filter((m) => typeof m.model_id === 'string' && m.model_id.length > 0)
      .map((m) => ({
        model_id: m.model_id!,
        model_name: m.model_name,
        description: m.description,
        context_window_tokens: m.context_window_tokens,
        rate_multiplier: m.rate_multiplier,
        rate_unit: m.rate_unit,
        is_default: m.model_id === defaultModelId,
      }));
    return { models };
  } catch {
    return { models: [], error: 'kiro-cli JSON parse failed.' };
  }
}

function parsePlainOutput(output: string): KiroRawListResult {
  const models: KiroModelRaw[] = [];
  for (const raw of output.split('\n')) {
    const m = MODEL_ROW_RE.exec(raw);
    if (!m) continue;
    const [, star, id, multiplierStr, rest] = m;
    const rateMultiplier = parseFloat(multiplierStr);
    models.push({
      model_id: id,
      description: rest.trim() || undefined,
      rate_multiplier: isNaN(rateMultiplier) ? undefined : rateMultiplier,
      is_default: star === '*',
    });
  }
  if (models.length === 0) {
    return { models: [], error: 'kiro-cli --list-models returned no models.' };
  }
  return { models };
}

// ── Public spawner ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Spawn `kiro-cli chat --list-models --format json`.
 *
 * Tries JSON output first; if stdout doesn't start with `{`, falls back to the
 * plain-text table parser so older CLI versions continue to work.
 *
 * @param childEnv  Complete env for the child process.
 *                  Callers should merge their credential env with process.env before passing:
 *                    `{ ...process.env, KIRO_API_KEY: key }`
 * @param timeoutMs Timeout in milliseconds (default 15 000).
 */
export async function spawnKiroListModels(
  childEnv: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<KiroRawListResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    const { cmd, fullArgs } = resolveKiroCmd(['chat', '--list-models', '--format', 'json']);

    try {
      child = spawn(cmd, fullArgs, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch {
      resolve({ models: [], error: 'kiro-cli is not installed or not on PATH.' });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') {
        resolve({ models: [], error: 'kiro-cli is not installed or not on PATH.' });
      } else {
        resolve({ models: [], error: `Failed to run kiro-cli: ${e.message}` });
      }
    });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ok */ }
      resolve({ models: [], error: `kiro-cli --list-models timed out after ${timeoutMs / 1000}s. Sign in again to refresh.` });
    }, timeoutMs).unref();

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        const tail = (stderr.trim() || stdout.trim()).slice(-300);
        const isExpired = tail.includes('expired') || tail.includes('token') ||
          tail.includes('sign in') || tail.includes('login');
        const errMsg = isExpired
          ? `Kiro sign-in has expired. Please re-authenticate in Credentials. (${tail.slice(0, 100)})`
          : `kiro-cli exited with code ${code}. ${tail.slice(0, 200)}`.trim();
        resolve({ models: [], error: errMsg });
        return;
      }

      const trimmed = stdout.trim();
      if (trimmed.startsWith('{')) {
        const jsonResult = parseJsonOutput(trimmed);
        if (!jsonResult.error) {
          resolve(jsonResult);
          return;
        }
      }

      // Fall back to plain-text parser (older CLI or --format not yet supported)
      const plainResult = parsePlainOutput(stdout);
      resolve(plainResult);
    });
  });
}
