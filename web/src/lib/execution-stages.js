/**
 * The stage strip of the Execution view: Planning → Working → Checking → Done, worked out from what the session really did
 * (its tool calls and the session's status). Nothing is simulated: with no tool calls and no run, every stage is pending.
 *
 *  Planning  the agent is reading, exploring or has made a task list, and has not changed a file yet (always, in plan mode)
 *  Working   it has written at least one file
 *  Checking  after a file was written it ran something that looks like a test, build, type check or lint
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

/** True when a tool call looks like a command that checks the work (tests, build, type check, lint). */
export function isVerifyCall(call) {
  return SHELL_TOOL.test(String(call.name).replace(/[\s-]/g, '_')) && VERIFY.test(call.preview || '');
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

  const firstEdit = calls.find((c) => c.file && c.status !== 'failed');
  const verifying = !planMode && firstEdit && calls.some((c) => c.at >= firstEdit.at && isVerifyCall(c));
  let current = 0;
  if (!planMode && firstEdit) current = 1;
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
  return { stages, current, progress: finished ? 1 : current / (STAGES.length - 1) };
}
