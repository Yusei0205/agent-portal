/**
 * How long one turn of an agent may run on an AgentCore runtime before it is stopped.
 *
 * The runner stops the engine at RUNNER_TURN_LIMIT_MS; the portal waits a minute longer, so a turn that reaches the limit is reported
 * by the runner itself ("reached the runner's time limit") and not as a dropped connection. The runtime's own maxLifetime (infra/lib/
 * harness-stack.ts: 4 hours, counted from when its session started whether or not it is busy) must stay well above this. The portal's
 * run time limit (settings agents.runTimeoutMinutes) is a separate, per-session limit and defaults to the same two hours.
 */
export const RUNNER_TURN_LIMIT_MS = 120 * 60_000;
export const PORTAL_TURN_LIMIT_MS = RUNNER_TURN_LIMIT_MS + 60_000;
