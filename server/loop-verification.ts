/**
 * Verification pipeline — replaces the single `verify_command` string.
 *
 * A pipeline is an ordered list of steps. Each step is either:
 *  • cmd  — shell command with a timeout; exit 0 = pass.
 *  • llm  — LLM judge (advisory only; never decides pass/fail; uses the cheap model).
 *
 * Steps marked `required: true` must pass for the pipeline to pass overall.
 * Optional steps log their result but do not affect the outcome.
 *
 * The result is written to `loop_run_states.last_check` after each iteration and fed back
 * to the agent in the next iteration's prompt (via composeIterationPrompt).
 *
 * Demo mode: deterministic heuristic instead of a real LLM call.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { all, one, run as exec, type Row } from './db.ts';
import { parseJson, now } from './util.ts';
import { getSettings } from './settings.ts';
import { projectDir, getProject } from './projects.ts';
import type { VerificationStep } from './loop-specs.ts';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface StepResult {
  step: string;
  kind: 'cmd' | 'llm';
  ok: boolean;
  /** Output (truncated to 4 000 chars). */
  output: string;
  duration_ms: number;
  required: boolean;
  /** LLM judge result is advisory — shown in the UI but never blocks the pipeline. */
  advisory?: boolean;
}

export interface PipelineResult {
  steps: StepResult[];
  /** True only when all required steps pass. */
  overall_ok: boolean;
  ran_at: string;
}

/* ------------------------------------------------------------------ */
/* Command runner (same pattern as runCheck() in workflows.ts)        */
/* ------------------------------------------------------------------ */

function runCommandStep(cmd: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(AWS_|ANTHROPIC_|PORTAL_|GITHUB_|GH_)/i.test(k)) env[k] = v;
    }
    const child = spawn(cmd, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d: Buffer) => { out = (out + d.toString()).slice(-6000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      out += '\n[step timed out]';
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Could not start step: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim().slice(-4000) });
    });
  });
}

/* ------------------------------------------------------------------ */
/* LLM judge step                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run an LLM judge advisory step.
 * Uses the oneshot path with the cheap model (Haiku).
 * In Demo mode, uses a deterministic heuristic (summary contains "pass" / "fail").
 * NEVER decides pass/fail for the pipeline — always advisory.
 */
async function runLlmJudgeStep(step: VerificationStep, agentSummary: string): Promise<{ ok: boolean; output: string }> {
  const settings = getSettings();
  const isDemo = settings.provider.mode === 'demo';
  const rubric = step.rubric ?? 'Does the agent\'s summary indicate the task is complete and tests pass?';

  if (isDemo) {
    // Deterministic heuristic for Demo mode
    const lower = agentSummary.toLowerCase();
    const ok = lower.includes('pass') || lower.includes('done') || lower.includes('complet') || lower.includes('success');
    return {
      ok,
      output: `[Demo mode LLM judge] Rubric: "${rubric}". Heuristic: summary ${ok ? 'appears' : 'does not appear'} to indicate success. (Advisory only — does not decide pass/fail.)`,
    };
  }

  try {
    const { oneShot } = await import('./agent/runner.ts') as any;
    if (typeof oneShot !== 'function') {
      return { ok: true, output: '[LLM judge: oneShot not available — skipped. Advisory only.]' };
    }
    const prompt = `You are an advisory code review judge. You evaluate whether an AI agent completed its task.

Rubric: ${rubric}

Agent's summary:
${agentSummary.slice(0, 1000)}

Reply in JSON: {"verdict": "pass"|"fail", "reason": "one sentence"}

This verdict is ADVISORY ONLY and does not decide whether the session continues.`;
    const result = await oneShot({ prompt, model: 'haiku', maxTokens: 200 });
    const text = String(result?.text ?? result ?? '');
    const json = (() => { try { const m = text.match(/\{[^}]+\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } })();
    const ok = json?.verdict === 'pass';
    return { ok, output: `[LLM judge advisory] ${json?.reason ?? text.slice(0, 200)}. (Advisory only — does not decide pass/fail.)` };
  } catch (e: any) {
    return { ok: true, output: `[LLM judge: error — ${String(e?.message ?? e).slice(0, 100)}. Treated as pass. Advisory only.]` };
  }
}

/* ------------------------------------------------------------------ */
/* Run the full pipeline                                               */
/* ------------------------------------------------------------------ */

/**
 * Run all verification steps in order.
 * A step with `required: true` (the default) that fails stops the pipeline early and fails it. A step with
 * `required: false` is reported but never fails the pipeline. (`required` is the only name for this flag.)
 * Returns the full result including per-step details.
 */
export async function runPipeline(
  steps: VerificationStep[],
  cwd: string,
  agentSummary: string,
): Promise<PipelineResult> {
  const results: StepResult[] = [];
  let overallOk = true;
  const ranAt = now();

  for (const step of steps) {
    const start = Date.now();
    const kind: 'cmd' | 'llm' = step.kind === 'llm' ? 'llm' : 'cmd';
    const required = step.required !== false;
    let result: { ok: boolean; output: string };

    if (kind === 'llm') {
      result = await runLlmJudgeStep(step, agentSummary);
      // LLM judge is always advisory — never affects overall_ok.
      results.push({
        step: step.step,
        kind,
        ok: result.ok,
        output: result.output,
        duration_ms: Date.now() - start,
        required,
        advisory: true,
      });
      continue; // advisory: do not affect overall_ok or stop pipeline
    }

    if (!step.cmd) {
      results.push({ step: step.step, kind, ok: false, output: 'No command configured for this step', duration_ms: 0, required });
      if (required) overallOk = false;
      continue;
    }

    const timeoutMs = (step.timeout ?? 300) * 1000;
    result = await runCommandStep(step.cmd, cwd, timeoutMs);
    results.push({
      step: step.step,
      kind,
      ok: result.ok,
      output: result.output,
      duration_ms: Date.now() - start,
      required,
    });

    if (!result.ok && required) {
      overallOk = false;
      // Stop the pipeline on the first required failure.
      break;
    }
  }

  return { steps: results, overall_ok: overallOk, ran_at: ranAt };
}

/* ------------------------------------------------------------------ */
/* Format pipeline result for the agent prompt                        */
/* ------------------------------------------------------------------ */

/**
 * Format a PipelineResult as a string for inclusion in the agent's iteration prompt.
 * Replaces the old single-string check output.
 */
export function formatPipelineForPrompt(result: PipelineResult): string {
  const lines = [`Verification pipeline ran at ${result.ran_at}. Overall: ${result.overall_ok ? '✓ PASS' : '✗ FAIL'}`];
  for (const s of result.steps) {
    const icon = s.advisory ? '💡' : s.ok ? '✓' : '✗';
    const label = s.advisory ? `${s.step} (advisory)` : s.step;
    lines.push(`${icon} ${label}: ${s.ok ? 'pass' : 'fail'} (${s.duration_ms}ms)`);
    if (!s.ok || s.advisory) lines.push(`  Output: ${s.output.slice(0, 500)}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Persist results to loop_run_states                                 */
/* ------------------------------------------------------------------ */

/**
 * Write a PipelineResult to loop_run_states.last_check (replaces the old lastCheck object).
 */
export function persistPipelineResult(workflowId: string, result: PipelineResult): void {
  exec(
    `INSERT INTO loop_run_states (workflow_id, iteration, failures, last_check, summaries, updated_at)
     VALUES (?, 0, 0, ?, '[]', ?)
     ON CONFLICT(workflow_id) DO UPDATE SET last_check = excluded.last_check, updated_at = excluded.updated_at`,
    workflowId,
    JSON.stringify(result),
    now(),
  );
}

/* ------------------------------------------------------------------ */
/* Memory: per-session progress file                                  */
/* ------------------------------------------------------------------ */

const MEMORY_FILE_NAME = 'loop-progress.md';

/** Path to the session's progress file (in the project's work area, alongside decisions.md). */
export function progressFilePath(projectId: string, workflowId: string): string {
  const pd = projectDir(getProject(projectId));
  return path.join(pd, 'docs', `loop-progress-${workflowId}.md`);
}

/**
 * Read the session's progress file. Returns '' if it does not exist yet.
 */
export function readProgressFile(projectId: string, workflowId: string): string {
  const p = progressFilePath(projectId, workflowId);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * Append a new iteration summary to the progress file, keeping at most `maxEntries` entries.
 */
export function appendProgress(projectId: string, workflowId: string, summary: string, iteration: number, maxEntries = 20): void {
  const p = progressFilePath(projectId, workflowId);
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }

  const header = `## Iteration ${iteration} — ${now()}\n\n${summary.trim()}\n\n`;
  let existing = '';
  try { existing = fs.readFileSync(p, 'utf8'); } catch { /* new file */ }

  // Keep at most maxEntries: split on "## Iteration" markers.
  const entries = existing.split(/^(?=## Iteration )/m).filter(Boolean);
  entries.push(header);
  const kept = entries.slice(-maxEntries);

  const title = '# Loop session progress\n\nThis file is updated after each iteration and read at the start of the next one.\n\n';
  fs.writeFileSync(p, title + kept.join(''), 'utf8');
}

/**
 * Delete the progress file when a session is deleted/cleaned up.
 */
export function deleteProgressFile(projectId: string, workflowId: string): void {
  const p = progressFilePath(projectId, workflowId);
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ */
/* Planning gate helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * A session in planning_gate mode has a `planning` status between `paused` and `running`.
 * The first iteration writes a plan; a person approves/edits it; then the session resumes.
 *
 * This function checks whether a session is waiting for plan approval.
 */
export function isPlanPending(workflowId: string): boolean {
  const r = one<Row>('SELECT planning_gate, status, stop_reason FROM workflows WHERE id = ?', workflowId);
  if (!r) return false;
  return Boolean(r.planning_gate) && r.status === 'paused' && String(r.stop_reason).startsWith('Plan ready');
}

/**
 * Check whether a new session should enter planning mode (spec has planning_gate = 1 AND this is iteration 1).
 */
export function shouldPlanFirst(workflowId: string): boolean {
  const r = one<Row>('SELECT planning_gate, iteration FROM workflows WHERE id = ?', workflowId);
  return Boolean(r?.planning_gate) && Number(r?.iteration ?? 0) === 0;
}
