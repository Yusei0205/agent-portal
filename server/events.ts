/**
 * In-process SSE event bus.
 *
 * Subscribers can be scoped to a project (projectId) or global (null).
 * - A global subscriber (projectId = null) receives ALL events.
 * - A project subscriber receives only events emitted for that project.
 * - emit(null, event) sends to global subscribers only.
 * - emit(projectId, event) sends to that project's subscribers AND global subscribers.
 */

import type { ServerResponse } from 'node:http';

interface Subscriber {
  projectId: string | null;
  res: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}

const subscribers = new Set<Subscriber>();

/**
 * Subscribe to SSE events.
 *
 * @param projectId  The project to subscribe to, or null for all events.
 * @param res        The ServerResponse to write SSE frames to.
 * @returns          An unsubscribe function.
 */
export function subscribe(
  projectId: string | null,
  res: ServerResponse,
): () => void {
  // Write SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // Keep-alive ping every 25 seconds
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 25_000);
  heartbeat.unref();

  const sub: Subscriber = { projectId, res, heartbeat };
  subscribers.add(sub);

  const unsubscribe = (): void => {
    clearInterval(sub.heartbeat);
    subscribers.delete(sub);
    if (!res.writableEnded) res.end();
  };

  // Auto-unsubscribe when the client disconnects
  res.on('close', unsubscribe);

  return unsubscribe;
}

/**
 * Emit an event to relevant subscribers.
 *
 * @param projectId  Project context for this event, or null for global.
 * @param event      The event payload (will be JSON-serialised).
 */
export function emit(projectId: string | null, event: object): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;

  for (const sub of subscribers) {
    // Global subscribers receive everything
    const isGlobal = sub.projectId === null;
    // Project subscriber: only receives events for its project
    const isMatch = projectId !== null && sub.projectId === projectId;
    // A global emit (projectId = null) goes only to global subscribers
    const shouldReceive = isGlobal || isMatch;

    if (!shouldReceive) continue;
    if (sub.res.writableEnded) continue;

    try {
      sub.res.write(data);
    } catch {
      // Broken pipe — remove the subscriber
      clearInterval(sub.heartbeat);
      subscribers.delete(sub);
    }
  }
}

/** Returns the current number of active SSE subscribers. */
export function subscriberCount(): number {
  return subscribers.size;
}
