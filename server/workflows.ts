/**
 * Autonomous workflow sessions.
 *
 * A session is a saved goal that the portal drives on its own: it starts an agent run, waits for it, runs the team's
 * check command, feeds the result into the next run (which resumes the previous run's conversation and working copy),
 * and repeats until the agent reports done or blocked, or a limit is hit. People review the changes and give new
 * instructions at any time; those are picked up by the next iteration and re-open a finished session.
 *
 * A single run is a session whose max_iterations is 1: one iteration, then it is done (or failed), with the agent's reply
 * as the result. It may be attended (permission_mode set): a person answers its questions and approves its tools. A
 * finished session re-opens when a person sends a message, which is how a single run is continued.
 *
 * Limits that keep an unattended loop safe: a spending budget, a cap on iterations per burst, a stop when the agent
 * keeps reporting the same thing, two failed runs in a row, and blocked commands (see guardrails.ts).
 *
 * The code lives in server/workflows/, one module per concern; this file keeps the public import path.
 */
import { registerSessionRoutes } from './workflows/crud.ts';
import { registerPushRoutes } from './workflows/push.ts';
import { registerDelegationRoutes } from './workflows/delegation.ts';
import { registerControlRoutes } from './workflows/controls.ts';
import { registerWorkingCopyRoutes } from './workflows/working-copies.ts';

export { view } from './workflows/views.ts';
export { closeEngineSwitch } from './workflows/engine-switch.ts';
export { delegationRoom, createChild } from './workflows/delegation.ts';
export { kick, anyDriving } from './workflows/driver.ts';
export { recoverWorkflows, resumeAfterRestart } from './workflows/recovery.ts';
export { readEngine } from './workflows/validation.ts';

export function registerWorkflowRoutes(): void {
  registerSessionRoutes();
  registerPushRoutes();
  registerDelegationRoutes();
  registerControlRoutes();
  registerWorkingCopyRoutes();
}
