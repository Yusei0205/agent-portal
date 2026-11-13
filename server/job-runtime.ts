/**
 * Long background jobs on their own AgentCore runtime (a microVM per job), instead of a Lambda invocation.
 *
 * A Lambda invocation ends after 15 minutes and holds one of the account's few concurrent-execution slots for as long
 * as it runs. The jobs named here are started on a separate AgentCore runtime that runs this same portal code
 * (Dockerfile.jobs), one session (one microVM) per job, which can run for hours and does not use a Lambda slot.
 *
 * Portal side:  runInBackground (background-jobs.ts) calls startOnJobRuntime for the jobs in jobRuntimeJobs().
 * Runner side:  PORTAL_JOB_RUNNER=1. POST /invocations accepts {job, args, secret} and answers 202 at once while the job
 *               goes on, and GET /ping says HealthyBusy until the last job ends, so the runtime is not stopped as idle
 *               in the middle of a job (see handleJobInvocation and jobRunnerPing in scheduled-jobs.ts).
 *
 * Off unless PORTAL_JOB_RUNTIME_ARN is set. If starting a job on the runtime fails, the caller falls back to a Lambda
 * invocation, so a job is not lost.
 */

import https from 'node:https';
import { randomUUID } from 'node:crypto';

/** Jobs that can outlast a Lambda invocation and need no person at the screen. Change with PORTAL_JOB_RUNTIME_JOBS. */
export const DEFAULT_JOB_RUNTIME_JOBS = [
  'scan-estimate', 'scan-run', 'knowledge-process', 'knowledge-embed', 'test-run', 'test-generate',
  'case-set-generate', 'case-set-generate-filtered', 'sim-ai-import', 'build-code-graph',
] as const;

/** True inside the job runtime's container. */
export function isJobRunner(): boolean {
  return process.env.PORTAL_JOB_RUNNER === '1';
}

export function jobRuntimeArn(): string {
  return (process.env.PORTAL_JOB_RUNTIME_ARN ?? '').trim();
}

/**
 * The job names that go to the runtime. `PORTAL_JOB_RUNTIME_JOBS` (comma separated) replaces the default list; a name
 * written with a leading `+` (for example `+execute-run`) is added to the default list instead.
 */
export function jobRuntimeJobs(): Set<string> {
  const raw = process.env.PORTAL_JOB_RUNTIME_JOBS;
  const items = raw === undefined ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
  const added = items.filter((s) => s.startsWith('+')).map((s) => s.slice(1).trim()).filter(Boolean);
  const replaced = items.filter((s) => !s.startsWith('+'));
  return new Set([...(replaced.length ? replaced : DEFAULT_JOB_RUNTIME_JOBS), ...added]);
}

/**
 * What to do when a job cannot be started on the runtime. `lambda` (default) runs it as a Lambda invocation instead, so
 * it is not lost but is limited to 15 minutes again. `none` makes runInBackground throw, so the caller can fail it at
 * once instead of letting a long job die at 15 minutes with no obvious cause (PORTAL_JOB_RUNTIME_FALLBACK=none).
 */
export function jobRuntimeFallsBackToLambda(): boolean {
  return (process.env.PORTAL_JOB_RUNTIME_FALLBACK ?? 'lambda').trim().toLowerCase() !== 'none';
}

/** True when this job should be started on the job runtime rather than here. Never true inside the runtime itself. */
export function runsOnJobRuntime(name: string): boolean {
  return !isJobRunner() && Boolean(jobRuntimeArn()) && jobRuntimeJobs().has(name);
}

/** A new session per job: one microVM each. AgentCore wants an id of at least 33 characters. */
export function jobSessionId(name: string): string {
  return `job-${name}-${randomUUID()}`.slice(0, 100);
}

type Invoker = (runtimeArn: string, sessionId: string, payload: Record<string, unknown>) => Promise<void>;
let invokerOverride: Invoker | null = null;

/** Test hook: replace the signed call to the runtime. */
export function _setJobRuntimeInvoker(fn: Invoker | null): void {
  invokerOverride = fn;
}

/** Start a job on the runtime and return once the runtime has accepted it (it answers at once; the job goes on). */
export async function startOnJobRuntime(name: string, args: Record<string, unknown>, secret: string): Promise<void> {
  const arn = jobRuntimeArn();
  if (!arn) throw new Error('No job runtime is configured');
  const payload = { job: name, args, secret };
  const sessionId = jobSessionId(name);
  if (invokerOverride) return invokerOverride(arn, sessionId, payload);

  // Imported when needed: this file is loaded by background-jobs.ts, which almost every module imports.
  const { resolveAwsCredentials, signRequest, parseRuntimeArn } = await import('./agent/kiro-agentcore.ts');
  const { region } = parseRuntimeArn(arn);
  const effectiveRegion = process.env.PORTAL_AGENTCORE_REGION || region;
  const credentials = await resolveAwsCredentials(process.env.PORTAL_AGENTCORE_AWS_PROFILE || undefined);
  const url = new URL(`https://bedrock-agentcore.${effectiveRegion}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations`);
  const body = JSON.stringify(payload);
  const headers = await signRequest({
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
    service: 'bedrock-agentcore',
    region: effectiveRegion,
    credentials,
  });
  // node:https, as the other AgentCore calls do: the signed headers include `host`, which fetch may refuse to send.
  await new Promise<void>((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers, timeout: 30_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (text.length < 300) text += c; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`The job runtime answered HTTP ${status}: ${text.slice(0, 200)}`));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The job runtime did not answer in 30 seconds')));
    req.on('error', reject);
    req.end(body);
  });
}
