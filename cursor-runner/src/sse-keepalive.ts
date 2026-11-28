/**
 * A comment line on the run's event stream every 20 seconds while the run goes on.
 *
 * Without it a quiet stretch (a long tool, a long think) leaves the connection with no traffic, and a NAT gateway on the way forgets a quiet
 * connection after 350 seconds without telling either end: the portal then waits for events that can never arrive. The line also tells the
 * portal this runner sends keepalives, so it can treat a minute and a half of silence as a lost connection (see AgentCoreStallError).
 *
 * The same file is in agent-runner, kiro-runner and codex-runner (a test keeps the copies equal): the runners do not share source files.
 */

export const KEEPALIVE_MS = 20_000;

interface StreamLike {
  write(chunk: string): unknown;
  readonly writableEnded: boolean;
  on(event: 'close', listener: () => void): unknown;
}

/** Starts the keepalive on a response that is already streaming. Returns a function that stops it (it also stops when the response closes). */
export function startKeepalive(res: StreamLike, everyMs: number = KEEPALIVE_MS): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': keepalive\n\n'); } catch { /* the connection is closing */ }
  }, everyMs);
  timer.unref?.();
  const stop = (): void => clearInterval(timer);
  res.on('close', stop);
  return stop;
}
