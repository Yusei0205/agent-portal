/**
 * Periodic maintenance jobs for the cloud portal.
 *
 * Locally these run from setInterval timers in index.ts. On Lambda there is no long-lived process, so
 * EventBridge Scheduler invokes the function with {"job": "...", "secret": "..."} and Lambda Web Adapter
 * forwards that event as POST /internal/events (AWS_LWA_PASS_THROUGH_PATH). The secret is the same value
 * that CloudFront sends as x-portal-origin, so only the schedule (or CloudFront) can trigger jobs.
 */

import { hasBackgroundJob, runBackgroundJobNow } from './background-jobs.ts';
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { checkIdleSessions } from './session-lifecycle.ts';
import { cleanupOrphanedAttachments } from './ai-attachments.ts';
import { cleanupSessions } from './auth.ts';
import { runDueTriggers } from './loop-triggers.ts';

export const SCHEDULED_EVENT_PATH = '/internal/events';

export const JOBS = {
  'idle-stop': async (): Promise<void> => { await checkIdleSessions(); },
  'attachment-cleanup': async (): Promise<void> => { await cleanupOrphanedAttachments(); },
  'session-cleanup': async (): Promise<void> => { cleanupSessions(); },
  'loop-triggers': async (): Promise<void> => { await runDueTriggers(); },
} as const;

export type JobName = keyof typeof JOBS;

export function isJobName(v: unknown): v is JobName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(JOBS, v);
}

function secretMatches(given: unknown, expected: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Handles POST /internal/events. `expectedSecret` must be set; without it the endpoint is closed. */
export async function handleScheduledEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedSecret: string | undefined,
): Promise<void> {
  if (req.method !== 'POST' || !expectedSecret) { reply(res, 403, { error: 'Forbidden' }); return; }
  let payload: { job?: unknown; secret?: unknown; args?: unknown };
  try {
    payload = JSON.parse(await readBody(req)) as { job?: unknown; secret?: unknown; args?: unknown };
  } catch {
    reply(res, 400, { error: 'Invalid event' });
    return;
  }
  if (!secretMatches(payload.secret, expectedSecret)) { reply(res, 403, { error: 'Forbidden' }); return; }
  const started = Date.now();
  if (hasBackgroundJob(payload.job)) {
    // Work another request started and handed to this invocation (see background-jobs.ts).
    try {
      const args = payload.args && typeof payload.args === 'object' ? (payload.args as Record<string, unknown>) : {};
      await runBackgroundJobNow(payload.job, args);
      reply(res, 200, { ok: true, job: payload.job, ms: Date.now() - started });
    } catch (e) {
      console.error(`[background-job] ${payload.job} failed:`, e instanceof Error ? e.message : e);
      reply(res, 500, { ok: false, job: payload.job });
    }
    return;
  }
  if (!isJobName(payload.job)) { reply(res, 400, { error: 'Unknown job' }); return; }
  try {
    await JOBS[payload.job]();
    reply(res, 200, { ok: true, job: payload.job, ms: Date.now() - started });
  } catch (e) {
    console.error(`[scheduled-job] ${payload.job} failed:`, e instanceof Error ? e.message : e);
    reply(res, 500, { ok: false, job: payload.job });
  }
}
