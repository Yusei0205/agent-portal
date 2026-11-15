/**
 * Picking a session back up after a turn was cut off by something that is not the person: a dropped connection to the runner, a lost
 * process (see lost-runs.ts), or the runner's own time limit.
 *
 * Three things happen, so that a session never just goes quiet:
 *   1. The person is told: an inbox item ("Blocked sessions") says what happened and whether the portal is continuing.
 *   2. The next turn gets what it needs to carry on: the conversation recap (recap.ts) plus a recovery brief built from the cut-off
 *      turn's own events (what was asked, the last steps it took, what it last said).
 *   3. Unless the person has not answered a recovery already, the portal starts that turn itself with a "↻ Continue where you left off"
 *      message, so the leftover task goes on without anyone being at the screen. At most MAX_AUTO_RECOVERIES in a row (a message from
 *      the person resets the count), so a task that keeps getting cut off does not loop for ever.
 *
 * The person can do the same by hand: /continue (or the Continue button on the inbox item).
 */

import { getSessionsRepository } from '../repositories/sessions.ts';
import { createInboxItem } from '../inbox.ts';
import { now } from '../util.ts';

/** The start of the message the portal sends on the person's behalf. A message the person typed does not start like this. */
export const RECOVERY_PREFIX = '↻';
/** Automatic recoveries in a row, without a message from the person in between. */
export const MAX_AUTO_RECOVERIES = 2;

export type InterruptionKind = 'connection-lost' | 'timed-out' | 'turn-lost' | 'engine-connection' | 'engine-stopped';

/** A short wait before an automatic turn after the engine's own service had a connection problem, so the retry does not hit the same hiccup. */
export function engineRetryDelayMs(): number {
  const n = Number(process.env.PORTAL_ENGINE_RETRY_DELAY_MS);
  return Number.isFinite(n) && n >= 0 && process.env.PORTAL_ENGINE_RETRY_DELAY_MS !== undefined ? n : 30_000;
}

/** Whether an error that ended a turn is an interruption (not the agent's own failure, not the person's Stop), and how to say it. */
export function interruptionOf(e: unknown): { kind: InterruptionKind; why: string } | null {
  const err = e as { name?: string; status?: number; message?: string } | null;
  if (err?.name === 'AgentCoreStallError') return { kind: 'connection-lost', why: 'the connection to the runner was lost' };
  if (err?.status === 504 && /timed out/i.test(String(err.message ?? ''))) return { kind: 'timed-out', why: "the runner's time limit for one turn was reached" };
  // kiro-cli could not reach (or lost its connection to) Kiro's service and gave up after its own retries: "ACP error -32603: Internal error
  // (Encountered an error in the response stream: ... dispatch failure)". The turn did not fail on its own merits.
  if (/-32603|dispatch failure|error in the response stream/i.test(String(err?.message ?? ''))) {
    return { kind: 'engine-connection', why: "the engine's service had a connection problem (it was retried and still failed)" };
  }
  // The engine's process went away in the middle of the turn: the runner stops it at its own turn limit (2 hours), and it can also be
  // killed. The runner reports that only as "ACP error: kiro-cli process exited". (A start-up failure is "exited with code N": not this.)
  if (/kiro-cli process exited|reached the runner's time limit/i.test(String(err?.message ?? ''))) {
    return { kind: 'engine-stopped', why: "the engine's process stopped before the turn finished (the runner's time limit for one turn, or it was killed)" };
  }
  return null;
}

const clip = (text: string, max: number): string => (text.length > max ? `…${text.slice(text.length - max)}` : text);
const field = (payload: string, key: string): string => {
  try { return String((JSON.parse(payload) as Record<string, unknown>)[key] ?? ''); } catch { return ''; }
};

/**
 * What the agent is told when it carries on: what it was asked, how far it got in the cut-off turn, and what it last said. The
 * conversation recap comes with it; this adds the steps the recap leaves out. `runId` null: the session's latest run.
 */
export async function buildRecoveryBrief(workflowId: string, runId: string | null, why: string): Promise<string> {
  const repo = getSessionsRepository();
  const cutOff = runId ?? (await repo.getLatestRun(workflowId))?.id ?? null;

  const asked = (await repo.listHumanWorkflowEvents(workflowId, null, null, null))
    .filter((m) => !String(m.body).startsWith(RECOVERY_PREFIX))
    .pop();

  let steps: string[] = [];
  let said = '';
  if (cutOff) {
    // Newest first; this run's, put back in order.
    const events = (await repo.listWorkflowRunEventsByType(workflowId, ['tool-start', 'assistant-text'], 2000)).filter((e) => e.run_id === cutOff).reverse();
    steps = events.filter((e) => e.type === 'tool-start').map((e) => field(String(e.payload), 'toolName').replace(/\s+/g, ' ').trim()).filter(Boolean);
    said = events.filter((e) => e.type === 'assistant-text').map((e) => field(String(e.payload), 'text')).join('').trim();
  }

  const lines = [`Your previous turn was cut off before you finished: ${why}. Nothing you did is lost from the conversation, but the turn did not end normally.`];
  if (asked) lines.push(`What you were asked:\n${clip(String(asked.body).trim(), 800)}`);
  if (steps.length) {
    lines.push(`What you had done in that turn (${steps.length} step${steps.length === 1 ? '' : 's'}; the last ones):\n${steps.slice(-12).map((s) => `- ${s.slice(0, 160)}`).join('\n')}`);
  }
  if (said) lines.push(`What you had said last:\n${clip(said, 1200)}`);
  lines.push(
    'Anything you kept in /tmp or another machine-local folder is gone when a turn is cut off: look in the work folder (the current directory) and '
    + 'its files first, and from now on keep notes, partial results and files you will need again inside the work folder, not in /tmp. '
    + 'Carry on with the task from where you stopped. Do not start over and do not repeat what is finished: first check the state of the work '
    + '(the files, git status, anything you had produced) and continue with what is left. If something you needed is gone, redo only that. '
    + 'If the task was already complete, say so briefly.',
  );
  return lines.join('\n\n');
}

/** How many recoveries the portal sent in a row since the person last wrote. */
export function trailingRecoveries(humanBodies: string[]): number {
  let n = 0;
  for (let i = humanBodies.length - 1; i >= 0 && humanBodies[i].startsWith(RECOVERY_PREFIX); i--) n++;
  return n;
}

export interface RecoveryOutcome { notified: boolean; continued: boolean }

/**
 * A turn was cut off: tell the person, and (when `auto`) carry on with the leftover task. Never throws.
 */
export async function recoverAfterInterruption(
  workflowId: string,
  runId: string,
  why: string,
  opts: { auto?: boolean; delayMs?: number } = {},
): Promise<RecoveryOutcome> {
  const out: RecoveryOutcome = { notified: false, continued: false };
  try {
    const repo = getSessionsRepository();
    const workflow = await repo.getWorkflowById(workflowId);
    if (!workflow) return out;

    if (opts.auto !== false) {
      const bodies = (await repo.listHumanWorkflowEvents(workflowId, null, null, null)).map((m) => String(m.body));
      if (trailingRecoveries(bodies) < MAX_AUTO_RECOVERIES) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const driver = await import('./driver.ts');
        // A message the person sent while the turn was going is the next instruction: it starts the turn instead.
        out.continued = await driver.continueWithQueuedMessages(workflowId);
        if (!out.continued) {
          const brief = await buildRecoveryBrief(workflowId, runId, why);
          await repo.appendWorkflowEvent({
            workflow_id: workflowId,
            kind: 'human',
            body: `${RECOVERY_PREFIX} Continue where you left off (the last turn was cut off: ${why}).`,
            data: JSON.stringify({ by: 'system', recovery: true, prompt: brief }),
            created_at: now(),
          });
          try {
            await driver.queuedDeps.startRun(workflowId);
            out.continued = true;
          } catch (e) {
            console.error(`[recovery] could not start the turn for ${workflowId}:`, e);
          }
        }
      }
    }

    if (workflow.project_id) {
      await createInboxItem({
        type: 'blocked',
        projectId: String(workflow.project_id),
        workflowId,
        runId,
        payload: {
          kind: 'turn-interrupted',
          reason: why,
          continued: out.continued,
          canContinue: !out.continued,
          message: out.continued
            ? `The last turn was cut off (${why}). The portal is continuing it from where it stopped.`
            : `The last turn was cut off (${why}). Open the session and press Continue, or send a message, to carry on from where it stopped.`,
        },
      });
      out.notified = true;
    }
  } catch (e) {
    console.error(`[recovery] could not recover ${workflowId}:`, e);
  }
  return out;
}
