/**
 * The portal's own limit on one turn (PORTAL_RUN_TIMEOUT_MS: 14 minutes on the cloud portal's Lambda, so a turn ends before
 * the 15-minute invocation does) stops a cloud run by aborting its connection to the runner. That abort reaches the
 * run as an error, which would read as a bare "Cancelled". These helpers record the real reason first, so the run
 * shows "time limit reached (N minutes)" and the session says to send another message to continue.
 */
import { getSessionsRepository } from '../repositories/sessions.ts';
import type { RunContext } from './types.ts';

export function hostLimitMinutes(limitMs: number): number {
  return Math.max(1, Math.round(limitMs / 60_000));
}

export function hostLimitStopReason(limitMs: number): string {
  return `time limit reached (${hostLimitMinutes(limitMs)} minutes)`;
}

export function hostLimitMessage(limitMs: number): string {
  return `Time limit reached: on this portal one turn can run for at most ${hostLimitMinutes(limitMs)} minutes. Send another message to continue.`;
}

/** Say why the run is ending (status line and the run's stop reason). Never throws: the run is ending anyway. */
export async function recordHostTimeLimit(ctx: RunContext, runId: string, limitMs: number): Promise<void> {
  try { ctx.emit('status', { text: hostLimitMessage(limitMs) }); } catch { /* ignore */ }
  try { await getSessionsRepository().updateRun(runId, { stop_reason: hostLimitStopReason(limitMs) }); } catch { /* ignore */ }
}
