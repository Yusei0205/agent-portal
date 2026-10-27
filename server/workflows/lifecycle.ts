/** Ending an iteration burst: marking a session done, blocked, failed, paused or stopped. */
import { one, run as exec, type Row } from '../db.ts';
import { now, parseJson } from '../util.ts';
import { drainQueue } from '../control-plane.ts';
import { getLoopSpec, type EscalationConfig } from '../loop-specs.ts';
import { escalateSession, fireWebhooks } from '../loop-engine.ts';
import { recordLoopMetrics } from '../loop-specs.ts';
import { patch, log } from './store.ts';
import { childStopped } from './delegation.ts';
import { kick } from './driver.ts';

export function stopWith(id: string, status: 'done' | 'blocked' | 'failed' | 'paused' | 'stopped', reason: string): void {
  const w = one<Row>('SELECT * FROM workflows WHERE id = ?', id);
  patch(id, { status, stop_reason: reason });
  // The session stopped or paused, so whatever comes next starts a new wall-clock window (driver.ts).
  exec('UPDATE loop_run_states SET wall_clock_started_at = NULL WHERE workflow_id = ?', id);
  log(id, 'status', reason ? `${status}: ${reason}` : status);
  childStopped(id);

  // When a top-level session stops/finishes, drain the queue — start any waiting sessions.
  const terminal = ['done', 'blocked', 'failed', 'stopped'];
  if (w && !w.parent_id && terminal.includes(status)) {
    setImmediate(() => {
      try {
        const ids = drainQueue();
        for (const qid of ids) {
          kick(qid);
        }
      } catch {
        /* queue drain is best-effort */
      }
    });
  }

  // A session that was drawing an architecture diagram hands its result over (NEW-1).
  if (w && terminal.includes(status)) {
    void import('../diagrams.ts').then((m) => m.onSessionStopped(id)).catch(() => undefined);
  }

  // A session of a "Keep docs current" firing moves the firing on (NEW-2).
  if (w && terminal.includes(status)) {
    void import('../docs-sync.ts').then((m) => m.onSessionStopped(id)).catch(() => undefined);
  }

  // A session that was making a presentation hands its deck over (NEW-7).
  if (w && terminal.includes(status)) {
    void import('../presentations.ts').then((m) => m.onSessionStopped(id)).catch(() => undefined);
  }

  // A session that was writing a document hands its Markdown over (NEW-6).
  if (w && terminal.includes(status)) {
    void import('../generated-docs.ts').then((m) => m.onSessionStopped(id)).catch(() => undefined);
  }

  // Record loop metrics when a session terminates (not just pauses).
  if (w && terminal.includes(status)) {
    const specId = w.loop_spec_id ? String(w.loop_spec_id) : null;
    const savedState = one<Row>('SELECT * FROM loop_run_states WHERE workflow_id = ?', id);
    const lastCheckData = savedState?.last_check ? parseJson<any>(savedState.last_check, null) : null;
    const verifPass = lastCheckData?.steps ? (lastCheckData.steps as any[]).filter((s: any) => s.ok && !s.advisory).length : 0;
    const verifFail = lastCheckData?.steps ? (lastCheckData.steps as any[]).filter((s: any) => !s.ok && !s.advisory).length : 0;
    const humanInputs = Number(one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_events WHERE workflow_id = ? AND kind = 'human'", id,
    )?.n ?? 0);
    const hasPr = Boolean(one<Row>(
      "SELECT id FROM workflow_events WHERE workflow_id = ? AND kind = 'push' AND data LIKE '%\"pr\"%' LIMIT 1", id,
    ));
    recordLoopMetrics({
      workflowId: id,
      specId,
      projectId: String(w.project_id),
      terminalState: status,
      iterationsUsed: Number(w.iteration ?? 0),
      costUsd: Number(w.spent_usd ?? 0),
      verifStepsPass: verifPass,
      verifStepsFail: verifFail,
      stagnationHit: status === 'blocked' && String(reason).includes('same thing') ? 1 : 0,
      humanInputs,
      prOpened: hasPr ? 1 : 0,
      startedAt: String(w.created_at),
      finishedAt: now(),
    });

    // Escalation for blocked/failed sessions that have escalation configured.
    if ((status === 'blocked' || status === 'failed') && specId) {
      try {
        const spec = getLoopSpec(specId);
        const esc: EscalationConfig = spec.escalation;
        const shouldEsc = (status === 'blocked' && esc.onBlocked !== false) || (status === 'failed' && esc.onFail !== false);
        if (shouldEsc) {
          escalateSession(id, status === 'blocked' ? 'blocked' : 'failed', reason);
        }
      } catch { /* spec may have been deleted */ }
    } else if (status === 'blocked' || status === 'failed') {
      // Even without a spec, fire webhooks for blocked/failed
      fireWebhooks(String(w.project_id), status === 'failed' ? 'session.failed' : 'session.blocked', {
        workflowId: id, projectId: w.project_id, title: w.title, reason,
      });
    } else if (status === 'done') {
      fireWebhooks(String(w.project_id), 'session.done', {
        workflowId: id, projectId: w.project_id, title: w.title,
      });
    }
  }
}
