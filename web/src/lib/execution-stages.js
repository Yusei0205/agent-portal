/**
 * The stage strip of the Execution view: Planning → Working → Checking → Done, worked out from what the session really did
 * (its tool calls and the session's status). Nothing is simulated: with no tool calls and no run, every stage is pending.
 *
 *  Planning  only preparation tools were used, or explicit plan mode is enabled
 *  Working   it has edited files or used execution/research tools (including browser and connected services)
 *  Checking  it ran a test/build/check, after the most recent edit when there is one
 *  Done      the session finished
 */

export const STAGES = [
  { key: 'planning', label: 'Planning' },
  { key: 'working', label: 'Working' },
  { key: 'checking', label: 'Checking' },
  { key: 'done', label: 'Done' },
];

const SHELL_TOOL = /^(bash|shell|sh|run_?command|exec|execute|command|powershell|terminal|local_shell)/i;
const VERIFY = /\b(tests?|jest|vitest|pytest|mocha|tsc|typecheck|type-check|lint|eslint|build|mypy|ruff|cargo (test|check|build)|go (test|vet|build)|npm run (test|build|lint|check))\b/i;
const toolName = (name) => String(name).replace(/^Running:\s*/i, '').replace(/^(functions|tools)\./, '').replace(/[\s-]/g, '_');
const PREPARATION = /^(read|read_file|glob|grep|list_files|list_directory|todowrite|todo_write|update_plan|updateplan|plan)$/i;
const READ_COMMAND = /^(?:ls|pwd|cat|head|tail|which|where|rg|find|Get-Content|Get-ChildItem|Get-Location)\b/i;

function isWorkCall(call) {
  if (call.status === 'failed') return false;
  if (call.file) return true;
  const name = toolName(call.name);
  if (PREPARATION.test(name)) return false;
  if (SHELL_TOOL.test(name)) {
    let command = call.preview || '';
    try { const input = JSON.parse(command); command = input.cmd || input.command || command; } catch { /* plain command */ }
    if (READ_COMMAND.test(command.trim())) return false;
  }
  return true;
}

/** True when a tool call looks like a command that checks the work (tests, build, type check, lint). */
export function isVerifyCall(call) {
  return SHELL_TOOL.test(toolName(call.name)) && VERIFY.test(call.preview || '');
}

/**
 * @param {{ calls: Array<{ name: string, preview: string, file: string, status: string, at: number }>, files: any[] }} summary from summarizeExecution
 * @param {{ status?: string, planMode?: boolean }} ctx the session's status ('running', 'done', 'failed', …) and whether plan mode is on
 * @returns {{ stages: Array<{ key: string, label: string, state: 'pending'|'active'|'done'|'failed'|'stopped' }>, current: number, progress: number }}
 */
export function deriveStages(summary, { status = '', planMode = false } = {}) {
  const calls = summary?.calls ?? [];
  const running = status === 'running' || status === 'pending';
  const finished = status === 'done';

  if (!calls.length && !running && !finished) {
    return { stages: STAGES.map((s) => ({ ...s, state: 'pending' })), current: -1, progress: 0 };
  }

  const lastEdit = calls.filter((c) => c.file && c.status !== 'failed').reduce((latest, call) => !latest || call.at >= latest.at ? call : latest, null);
  const verifying = !planMode && calls.some((c) => (!lastEdit || c.at >= lastEdit.at) && isVerifyCall(c));
  let current = 0;
  if (!planMode && calls.some(isWorkCall)) current = 1;
  if (verifying) current = 2;
  if (finished) current = 3;

  const stages = STAGES.map((s, i) => {
    let state = 'pending';
    if (i < current) state = 'done';
    else if (i === current) {
      if (finished) state = 'done';
      else if (status === 'failed') state = 'failed';
      else if (running) state = 'active';
      else state = 'stopped';
    }
    return { ...s, state };
  });
  const reason = finished ? 'The session reported completion.' : planMode ? 'Plan mode is on; the stage remains Planning until execution is enabled.' : verifying ? 'A test, build or verification command was recorded. Inspect its result below.' : current === 1 ? 'Execution or research tools were used. Working does not require a file change.' : 'Only preparation activity has been recorded so far.';
  const prefix = status === 'paused' ? 'Session paused. ' : status === 'blocked' ? 'Session needs a decision. ' : status === 'failed' ? 'Session failed. ' : status === 'stopped' ? 'Session stopped. ' : '';
  return { stages, current, reason: prefix + reason, progress: finished ? 1 : current / (STAGES.length - 1) };
}
