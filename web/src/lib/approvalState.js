/**
 * What became of each approval request in a session, worked out from the session's events, so an approval card shows
 * the answer after a reload instead of the Approve / Deny buttons.
 *
 *   approval-resolved  { inputId, status: 'approved'|'denied', allowAll, by }   — answered in the session or the Inbox
 *   approval-expired   { inputId }                                             — nobody answered in time
 *   run-complete / run-failed                                                  — the turn is over: nothing still waits
 *
 * Live stream events carry no run_id; they belong to the current run (`currentRunId`).
 *
 * @param {Array<{ type: string, run_id?: string|null, payload?: Record<string, unknown> }>} events
 * @param {string|null} currentRunId
 * @returns {{ resolutions: Map<string, { status: string, allowAll: boolean, by: string|null }>, endedRuns: Set<string> }}
 */
export function approvalStates(events, currentRunId) {
  const resolutions = new Map();
  const endedRuns = new Set();
  for (const e of events || []) {
    const p = e.payload || {};
    if (e.type === 'approval-resolved' && p.inputId) {
      resolutions.set(String(p.inputId), {
        status: p.status === 'approved' ? 'approved' : 'denied',
        allowAll: Boolean(p.allowAll),
        by: typeof p.by === 'string' && p.by ? p.by : null,
      });
    } else if (e.type === 'approval-expired' && p.inputId && !resolutions.has(String(p.inputId))) {
      resolutions.set(String(p.inputId), { status: 'expired', allowAll: false, by: null });
    } else if (e.type === 'run-complete' || e.type === 'run-failed') {
      const rid = e.run_id ?? currentRunId;
      if (rid) endedRuns.add(String(rid));
    }
  }
  return { resolutions, endedRuns };
}
