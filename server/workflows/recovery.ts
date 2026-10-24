/** Pausing and resuming sessions around a server restart. */
import { all, one, run as exec, type Row } from '../db.ts';
import { now } from '../util.ts';
import { drainQueue } from '../control-plane.ts';
import { patch, log, overBudget } from './store.ts';
import { kick } from './driver.ts';

const RESTART_REASON = 'The server restarted. Resume to go on.';

const INTERRUPTED_REASON = 'Interrupted mid-iteration by a server restart.';

/** After a restart nothing is driving any more: sessions that were running are paused. Returns their ids. */
export function recoverWorkflows(): string[] {
  const ids = all<Row>("SELECT id FROM workflows WHERE status = 'running'").map((w) => String(w.id));
  for (const id of ids) {
    // Check if this session was in the middle of an iteration when it was interrupted.
    const savedState = one<Row>('SELECT iteration FROM loop_run_states WHERE workflow_id = ?', id);
    const w = one<Row>('SELECT iteration FROM workflows WHERE id = ?', id);
    const wasInIteration = savedState && w && Number(savedState.iteration) > Number(w.iteration);
    const reason = wasInIteration ? INTERRUPTED_REASON : RESTART_REASON;
    exec('UPDATE workflows SET status = ?, stop_reason = ?, updated_at = ? WHERE id = ?', 'paused', reason, now(), id);
    // If it was interrupted mid-iteration, record the fact in workflow_events so the history is clear.
    if (wasInIteration) {
      exec(
        "INSERT INTO workflow_events (workflow_id, kind, run_id, body, data, consumed, created_at) VALUES (?, 'status', NULL, ?, '{}', 0, ?)",
        id,
        `Iteration ${savedState.iteration} was interrupted by a server restart. It will run again from the last checkpoint when resumed.`,
        now(),
      );
    }
  }
  return ids;
}

/**
 * Start again the sessions a restart paused (Settings › Agent defaults decides whether this happens). A session that
 * someone changed in the meantime, or that has used its budget, stays paused. Each continues where it was: the next
 * iteration resumes the conversation and the working copy of its last run, with its iteration count unchanged.
 * The durable loop state (failures, summaries, lastCheck) is restored from loop_run_states.
 */
export function resumeAfterRestart(ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
    if (!w || w.status !== 'paused') continue;
    if (w.stop_reason !== RESTART_REASON && w.stop_reason !== INTERRUPTED_REASON) continue;
    if (overBudget(w)) continue;
    patch(id, { status: 'running', stop_reason: '' });
    log(id, 'status', 'The server restarted; the session carries on by itself where it left off.');
    kick(id);
    n++;
  }
  // On restart, also check if any queued sessions can now start (drain mode may have lifted, or capacity available).
  try {
    const started = drainQueue();
    for (const qid of started) kick(qid);
    n += started.length;
  } catch {
    /* best-effort */
  }
  return n;
}
