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

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, Handler>();

export function registerBackgroundJob(name: string, handler: Handler): void {
  handlers.set(name, handler);
}

export function hasBackgroundJob(name: unknown): name is string {
  return typeof name === 'string' && handlers.has(name);
}

/** Run a registered job in this process and wait for it. */
export async function runBackgroundJobNow(name: string, args: Record<string, unknown>): Promise<unknown> {
  const h = handlers.get(name);
  if (!h) throw new Error(`Unknown background job: ${name}`);
  return await h(args);
}

/** True when this process should hand background work to a separate Lambda invocation. */
export function useLambdaInvoke(): boolean {
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.PORTAL_ORIGIN_SECRET);
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
 * Start a registered job without waiting for it. On Lambda this makes a separate invocation; if that call
 * fails the job runs inline so the work is not lost (it then finishes within this request's lifetime).
 */
export async function runInBackground(name: string, args: Record<string, unknown>): Promise<void> {
  if (!handlers.has(name)) throw new Error(`Unknown background job: ${name}`);
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
