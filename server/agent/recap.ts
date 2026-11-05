/**
 * Conversation recap helper — shared by the Kiro and Claude Code engines.
 *
 * Used when starting a fresh session (no stored engine_session_id, or after a
 * failed resume) to provide the engine with context from earlier turns.
 */

import { getSessionsRepository } from '../repositories/sessions.ts';

/**
 * Build a compact recap of the conversation so far for injection into a fresh
 * engine session when there is no stored session ID to resume from.
 *
 * Returns '' when there is nothing to recap (first run, or right after /clear).
 *
 * Algorithm:
 *   1. Find the last /clear command time (if any).
 *   2. Collect completed run summaries (p6_events type='run-complete') and
 *      human messages (p6_workflow_events kind='human'), both filtered to
 *      after the last /clear (if any) and excluding the current run's events.
 *   3. Human messages are further restricted to those with id < the LOWEST
 *      p6_workflow_events id consumed for the current run's prompt — this
 *      reliably excludes the messages that are already the current prompt.
 *      When no such boundary exists (prompt came from workflow.goal rather
 *      than pending events), all human messages from prior runs are included.
 *   4. Both streams are merged by created_at ascending.
 *   5. Oldest entries are trimmed to fit within maxChars (newest kept).
 *
 * @param workflowId       Workflow to recap.
 * @param runId            Current run ID — its completions are excluded.
 * @param minExcludeEventId If non-null, human messages with id >= this value
 *                          are the current run's input and are excluded.
 *                          Pass null to include all prior human messages.
 * @param maxChars         Soft character cap (default 8 000).
 */
export async function buildConversationRecap(
  workflowId: string,
  runId: string,
  minExcludeEventId: number | null = null,
  maxChars = 8_000,
): Promise<string> {
  const repo = getSessionsRepository();

  const wf = await repo.getWorkflowById(workflowId);
  const goal = wf ? String(wf.goal).slice(0, 800) : '';

  // ── Last /clear time ──────────────────────────────────────────────────────
  const lastClearTime = await repo.getLastWorkflowEventTime(workflowId, 'command', '/clear');

  // ── Completed run summaries (excluding current run) ───────────────────────
  const completionRows = await repo.listRunCompletionEvents(workflowId, runId, lastClearTime ?? undefined);

  // ── Failed runs (excluding current run) ──────────────────────────────────
  // A run that failed part-way (e.g. Kiro credits ran out) has no run-complete summary, but what the agent had said
  // before it failed is the context the next engine needs, above all after the session was switched to another one.
  const failedTurns = await failedRunTurns(workflowId, runId, lastClearTime);

  if (completionRows.length === 0 && failedTurns.length === 0) {
    return '';
  }

  // ── Human messages (prior turns only) ────────────────────────────────────
  // Exclude messages that are the current run's input (already in the prompt).
  const lastCompletionTs = [...completionRows.map((r) => r.created_at), ...failedTurns.map((t) => t.ts)].sort().pop()!;

  let humanRows: Array<{ id: number; body: string; created_at: string }>;
  if (minExcludeEventId !== null) {
    humanRows = await repo.listHumanWorkflowEvents(workflowId, lastClearTime, minExcludeEventId, null);
  } else {
    // When minExcludeEventId is null, exclude messages after the last completed reply
    // (those are the current prompt). Use beforeOrAtDate to apply the upper bound.
    humanRows = await repo.listHumanWorkflowEvents(workflowId, lastClearTime, null, lastCompletionTs);
  }

  // ── Merge by created_at ───────────────────────────────────────────────────
  type TurnEntry = { role: 'assistant' | 'user'; text: string; ts: string };
  const turns: TurnEntry[] = [];

  for (const row of completionRows) {
    try {
      const p = JSON.parse(String(row.payload)) as { result?: string };
      if (p.result) {
        turns.push({ role: 'assistant', text: String(p.result).slice(0, 600), ts: row.created_at });
      }
    } catch { /* skip malformed */ }
  }

  for (const row of humanRows) {
    turns.push({ role: 'user', text: String(row.body).slice(0, 600), ts: row.created_at });
  }

  for (const t of failedTurns) turns.push({ role: 'assistant', text: t.text, ts: t.ts });

  // Sort by timestamp ascending
  turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  if (turns.length === 0) return '';

  // ── Budget-constrained trim ───────────────────────────────────────────────
  const header = `[Context from previous conversation]\nOriginal goal: ${goal}\n\n`;
  const footer = '---\n';
  const budget = maxChars - header.length - footer.length;

  const lines = turns.map(
    (t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}\n`,
  );

  // Keep the newest exchanges: scan backward, accumulate until budget exceeded
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > budget) break;
    kept.unshift(lines[i]);
    used += lines[i].length;
  }

  if (kept.length === 0) return '';

  return header + kept.join('') + footer;
}

/**
 * One recap entry per failed earlier run: the end of what the agent wrote in it, and why it stopped.
 * Runs before the last /clear and the current run are left out.
 */
async function failedRunTurns(
  workflowId: string,
  currentRunId: string,
  lastClearTime: string | null,
): Promise<Array<{ text: string; ts: string }>> {
  const repo = getSessionsRepository();
  const events = await repo.listWorkflowRunEventsByType(workflowId, ['run-failed', 'assistant-text'], 2000);
  const failures = events.filter((e) => e.type === 'run-failed' && e.run_id !== currentRunId
    && (!lastClearTime || String(e.created_at) > lastClearTime));
  const out: Array<{ text: string; ts: string }> = [];
  for (const f of failures) {
    // Events come newest first; put this run's text back in order.
    const said = events
      .filter((e) => e.type === 'assistant-text' && e.run_id === f.run_id)
      .reverse()
      .map((e) => {
        try { return String((JSON.parse(String(e.payload)) as { text?: unknown }).text ?? ''); } catch { return ''; }
      })
      .join('')
      .trim();
    let error = '';
    try { error = String((JSON.parse(String(f.payload)) as { error?: unknown }).error ?? ''); } catch { /* none */ }
    const tail = said.length > 500 ? `…${said.slice(-500)}` : said;
    const text = `${tail ? `${tail}\n` : ''}(This turn stopped before it finished${error ? `: ${error.slice(0, 200)}` : ''}.)`;
    out.push({ text, ts: String(f.created_at) });
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
