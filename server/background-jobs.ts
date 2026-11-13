/**
 * Work that must continue after an HTTP response has been sent (scans, document conversion).
 *
 * Locally this is a plain setImmediate. On Lambda the instance is frozen as soon as the response ends, so the
 * portal invokes ITSELF asynchronously (InvocationType Event) with {job, args, secret}; Lambda Web Adapter
 * forwards that to POST /internal/events (see scheduled-jobs.ts), which runs the registered handler for up to
 * the function timeout (15 minutes). Long jobs must be resumable.
 *
 *   registerBackgroundJob('scan-run', async ({ id }) => ...)     once, at route registration
 *   await runInBackground('scan-run', { id })                    from a request handler
 */

import { isJobRunner, jobRuntimeFallsBackToLambda, runsOnJobRuntime, startOnJobRuntime } from './job-runtime.ts';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, Handler>();

export function registerBackgroundJob(name: string, handler: Handler): void {
  handlers.set(name, handler);
}

export function hasBackgroundJob(name: unknown): name is string {
  return typeof name === 'string' && handlers.has(name);
}

let activeJobs = 0;
/** How many jobs are running in this process. The job runtime reports itself busy while this is above zero. */
export function runningJobCount(): number {
  return activeJobs;
}

/** Run a registered job in this process and wait for it. */
export async function runBackgroundJobNow(name: string, args: Record<string, unknown>): Promise<unknown> {
  const h = handlers.get(name);
  if (!h) throw new Error(`Unknown background job: ${name}`);
  activeJobs += 1;
  try {
    return await h(args);
  } finally {
    activeJobs -= 1;
  }
}

/** True when this process should hand background work to a separate Lambda invocation. */
export function useLambdaInvoke(): boolean {
  // The job runtime runs a job where it is: it sets AWS_LAMBDA_FUNCTION_NAME only so the code takes its cloud paths.
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.PORTAL_ORIGIN_SECRET) && !isJobRunner();
}

let invoker: ((payload: Record<string, unknown>) => Promise<void>) | null = null;

/** Test hook: replace the Lambda self-invoke. */
export function _setLambdaInvoker(fn: ((payload: Record<string, unknown>) => Promise<void>) | null): void {
  invoker = fn;
}

async function invokeSelf(payload: Record<string, unknown>): Promise<void> {
  if (invoker) return invoker(payload);
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
}

/**
 * A run that may ask a person to approve a tool (the session is not set to trust all tools) has to stay where that
 * person's answer can reach it: the approval is held in the memory of the process running the turn. Runs that need
 * no approval (trusted sessions, and every Create document or diagram run) can go to the job runtime.
 */
async function needsPersonAtScreen(name: string, args: Record<string, unknown>): Promise<boolean> {
  if (name !== 'execute-run') return false;
  try {
    const { getSessionsRepository } = await import('./repositories/sessions.ts');
    const w = await getSessionsRepository().getWorkflowById(String(args.workflowId ?? ''));
    return !(w && Number(w.trust_tools) === 1);
  } catch {
    return true;
  }
}

/**
 * Start a registered job without waiting for it. On Lambda this makes a separate invocation; if that call
 * fails the job runs inline so the work is not lost (it then finishes within this request's lifetime).
 */
export async function runInBackground(name: string, args: Record<string, unknown>): Promise<void> {
  if (!handlers.has(name)) throw new Error(`Unknown background job: ${name}`);
  // A long job goes to the job runtime (no 15-minute limit, no Lambda slot). If that cannot be reached, a Lambda
  // invocation below still runs it.
  if (runsOnJobRuntime(name) && process.env.PORTAL_ORIGIN_SECRET && !(await needsPersonAtScreen(name, args))) {
    try {
      await startOnJobRuntime(name, args, process.env.PORTAL_ORIGIN_SECRET);
      return;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (!jobRuntimeFallsBackToLambda()) {
        console.error(`[background-jobs] job runtime did not take ${name} and PORTAL_JOB_RUNTIME_FALLBACK=none:`, why);
        throw new Error(`The long-job runtime could not start ${name}: ${why}`);
      }
      console.error(`[background-jobs] job runtime did not take ${name}, using Lambda (15 minute limit applies):`, why);
    }
  }
  if (useLambdaInvoke()) {
    try {
      await invokeSelf({ job: name, args, secret: process.env.PORTAL_ORIGIN_SECRET });
      return;
    } catch (e) {
      console.error('[background-jobs] self-invoke failed, running inline:', e instanceof Error ? e.message : e);
      await runBackgroundJobNow(name, args).catch((err) => console.error(`[background-jobs] ${name} failed:`, err));
      return;
    }
  }
  setImmediate(() => {
    runBackgroundJobNow(name, args).catch((err) => console.error(`[background-jobs] ${name} failed:`, err));
  });
}
