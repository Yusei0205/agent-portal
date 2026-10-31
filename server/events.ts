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
  /** When true the subscriber only receives emitGlobal() events, not emit() events. */
  globalOnly: boolean;
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

  const sub: Subscriber = { projectId, res, heartbeat, globalOnly: false };
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
    // globalOnly subscribers only receive emitGlobal() events, not emit() events
    if (sub.globalOnly) continue;

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

/**
 * Emit a portal-wide event to ALL subscribers regardless of project scope.
 * Use this for system-level events such as theme changes that every open
 * client needs to receive.
 */
export function emitGlobal(event: object): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const sub of subscribers) {
    if (sub.res.writableEnded) continue;
    try {
      sub.res.write(data);
    } catch {
      clearInterval(sub.heartbeat);
      subscribers.delete(sub);
    }
  }
}

/**
 * Subscribe to portal-wide SSE events only (emitGlobal).
 *
 * Unlike subscribe(), this subscriber will NOT receive events from emit().
 * Use for the /api/events endpoint so browser clients can receive portal-wide
 * events (e.g. theme.changed) without leaking per-project run events.
 *
 * @param res  The ServerResponse to write SSE frames to.
 * @returns    An unsubscribe function.
 */
export function subscribeGlobalOnly(res: ServerResponse): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 25_000);
  heartbeat.unref();

  const sub: Subscriber = { projectId: null, res, heartbeat, globalOnly: true };
  subscribers.add(sub);

  const unsubscribe = (): void => {
    clearInterval(sub.heartbeat);
    subscribers.delete(sub);
    if (!res.writableEnded) res.end();
  };

  res.on('close', unsubscribe);

  return unsubscribe;
}

/** Returns the current number of active SSE subscribers. */
export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * Register an existing SSE response as a live subscriber WITHOUT writing headers.
 *
 * Use this when the caller has already written SSE headers and replayed
 * historical events — e.g. the `/api/runs/:id/events` endpoint writes its own
 * headers, replays past events, then calls this to receive future live events.
 *
 * Unlike `subscribe()`, this function does NOT call `res.writeHead()`.
 * It does set up the keep-alive heartbeat and the `res.on('close', …)` cleanup.
 *
 * @param projectId  The project to subscribe to, or null for global.
 * @param res        The ServerResponse that has already had SSE headers written.
 * @returns          An unsubscribe function (also registered on 'close' automatically).
 */
export function addLiveSubscriber(
  projectId: string | null,
  res: ServerResponse,
): () => void {
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 25_000);
  heartbeat.unref();

  const sub: Subscriber = { projectId, res, heartbeat, globalOnly: false };
  subscribers.add(sub);

  const unsubscribe = (): void => {
    clearInterval(sub.heartbeat);
    subscribers.delete(sub);
    if (!res.writableEnded) res.end();
  };

  res.on('close', unsubscribe);
  return unsubscribe;
}
