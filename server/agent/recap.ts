/**
 * Conversation recap helper — shared by the Kiro and Claude Code engines.
 *
 * Used when starting a fresh session (no stored engine_session_id, or after a
 * failed resume) to provide the engine with context from earlier turns.
 *
 * Verified facts about where each engine stores sessions:
 *
 *   Kiro — kiro-cli ACP saves sessions to the REAL user profile at
 *     %USERPROFILE%\.kiro\sessions\cli\<sessionId>.json/.jsonl (Windows),
 *     regardless of where HOME is pointed.  Nothing is written under the
 *     materialised temp HOME.  The portal does NOT need to copy or restore
 *     these files; see the removed preserve/restoreKiroSessions code.
 *     The isReplaying guard in kiro.ts is kept because it is harmless and
 *     protects against future replay if the behaviour ever changes.
 *
 *   Claude Code — The Agent SDK / CLI stores transcripts under:
 *     <home>/.claude/projects/<CLAUDE_CODE_PROJECT_DIR_NAME>/<sessionId>.jsonl
 *     (source: bridge.mjs, SDK 0.3.303 / CLI 2.1.303).
 *     Because the materialised HOME is a fresh temp dir every run, the portal
 *     persists those .jsonl files into <workDir>/.portal/claude-sessions/ after
 *     each run and restores them before the next.  See claude-sessions.ts.
 */

import { one, all } from '../db.ts';

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
export function buildConversationRecap(
  workflowId: string,
  runId: string,
  minExcludeEventId: number | null = null,
  maxChars = 8_000,
): string {
  const wf = one<{ goal: string }>('SELECT goal FROM p6_workflows WHERE id = ?', workflowId);
  const goal = wf ? String(wf.goal).slice(0, 800) : '';

  // ── Last /clear time ──────────────────────────────────────────────────────
  const clearRow = one<{ ts: string | null }>(
    `SELECT MAX(created_at) AS ts FROM p6_workflow_events
       WHERE workflow_id = ? AND kind = 'command' AND body = '/clear'`,
    workflowId,
  );
  const lastClearTime: string | null = clearRow?.ts ?? null;

  // ── Completed run summaries (excluding current run) ───────────────────────
  const completionArgs: (string | null)[] = [workflowId, runId];
  if (lastClearTime) completionArgs.push(lastClearTime);

  const completionRows = all<{ payload: string; created_at: string }>(
    `SELECT e.payload, e.created_at
       FROM p6_events e
       JOIN p6_runs r ON e.run_id = r.id
      WHERE r.workflow_id = ? AND r.id != ? AND e.type = 'run-complete'
        ${lastClearTime ? 'AND e.created_at > ?' : ''}
      ORDER BY e.created_at ASC`,
    ...completionArgs,
  );

  if (completionRows.length === 0) {
    // Nothing to recap: first run, or first run after /clear
    return '';
  }

  // ── Human messages (prior turns only) ────────────────────────────────────
  // Exclude messages that are the current run's input (already in the prompt).
  // When minExcludeEventId is provided, those messages have id >= minExcludeEventId.
  // When null, messages sent after the last completed reply are treated as the
  // current prompt (runner.ts consumes exactly those for this run) and skipped.
  const lastCompletionTs = completionRows[completionRows.length - 1].created_at;
  const humanArgs: (string | number | null)[] = [workflowId];
  if (minExcludeEventId !== null) humanArgs.push(minExcludeEventId);
  else humanArgs.push(lastCompletionTs);
  if (lastClearTime) humanArgs.push(lastClearTime);

  const humanRows = all<{ body: string; created_at: string }>(
    `SELECT body, created_at FROM p6_workflow_events
      WHERE workflow_id = ? AND kind = 'human'
        ${minExcludeEventId !== null ? 'AND id < ?' : 'AND created_at <= ?'}
        ${lastClearTime ? 'AND created_at > ?' : ''}
      ORDER BY created_at ASC`,
    ...humanArgs,
  );

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
