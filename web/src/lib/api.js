// @ts-check
// Thin client for the portal API. Every state-changing call carries the CSRF header.
// Response shapes are described in ./api-types.js; a caller can name one with a JSDoc type, for example
//   const r = await api.get('/api/projects'); // r: { projects: import('./api-types.js').Project[] }
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status; 0 when the server could not be reached
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
/** @param {() => void} fn Called when a request other than sign-in answers 401. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/**
 * @template [T=any]
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body] Sent as JSON
 * @param {{ raw?: BodyInit }} [options] `raw` sends a file or bytes instead of JSON
 * @returns {Promise<T>}
 */
async function request(method, url, body, { raw } = {}) {
  /** @type {Record<string, string>} */
  const headers = { 'x-requested-with': 'agent-portal' };
  /** @type {BodyInit | undefined} */
  let payload;
  if (raw) {
    headers['content-type'] = 'application/octet-stream';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Cannot reach the portal server. Check that it is running.');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (res.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  return data;
}

/**
 * The API methods. Each takes a path starting with /api/ and resolves with the parsed JSON body (or the text of a
 * non-JSON answer). Failures reject with an ApiError.
 * @type {{
 *   get: <T = any>(url: string) => Promise<T>,
 *   post: <T = any>(url: string, body?: unknown) => Promise<T>,
 *   put: <T = any>(url: string, body?: unknown) => Promise<T>,
 *   patch: <T = any>(url: string, body?: unknown) => Promise<T>,
 *   del: <T = any>(url: string, body?: unknown) => Promise<T>,
 *   upload: <T = any>(url: string, file: BodyInit) => Promise<T>,
 *   postRaw: <T = any>(url: string, data: BodyInit) => Promise<T>,
 * }}
 */
export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u, b) => request('DELETE', u, b),
  upload: (u, file) => request('PUT', u, undefined, { raw: file }),
  postRaw: (u, data) => request('POST', u, undefined, { raw: data }),
};

/**
 * Server-sent events with automatic reconnect. Returns a function that closes the stream.
 * @param {string | (() => string)} url A path, or a function giving the path each time the stream (re)connects
 * @param {Record<string, (data: any) => void>} handlers One function per event name; each gets the parsed JSON data
 * @returns {() => void}
 */
export function stream(url, handlers) {
  /** @type {EventSource} */
  let es;
  let closed = false;
  let retry = 1000;
  const open = () => {
    if (closed) return;
    es = new EventSource(typeof url === 'function' ? url() : url);
    es.onopen = () => (retry = 1000);
    for (const [event, fn] of Object.entries(handlers)) {
      es.addEventListener(event, (e) => {
        try {
          fn(JSON.parse(e.data));
        } catch (err) {
          console.error(err);
        }
      });
    }
    es.onerror = () => {
      es.close();
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000)));
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}

/**
 * Like stream(), but every tab of the browser shares one connection per URL: one tab holds it (navigator.locks) and
 * passes each event to the others over a BroadcastChannel. When that tab closes, another takes over.
 *
 * Browsers allow only 6 open connections to the same server across all tabs over HTTP/1.1. Each open stream holds one
 * for as long as the page is open, so a few portal tabs with a stream each used them all up and every other request
 * waited forever (pages kept loading). Falls back to a plain stream where the browser lacks locks or channels.
 *
 * @param {string} url
 * @param {Record<string, (data: any) => void>} handlers
 * @returns {() => void}
 */
export function sharedStream(url, handlers) {
  if (typeof navigator === 'undefined' || !navigator.locks || typeof BroadcastChannel === 'undefined') return pausedWhenHidden(() => stream(url, handlers));
  const key = `portal-sse:${url}`;
  const channel = new BroadcastChannel(key);
  /** @type {(event: string, data: any) => void} */
  const deliver = (event, data) => {
    const fn = handlers[event];
    if (!fn) return;
    try {
      fn(data);
    } catch (err) {
      console.error(err);
    }
  };
  channel.onmessage = (m) => deliver(m.data?.event, m.data?.data);
  // Only a visible tab competes for the connection; a tab that goes to the background lets it go, so a visible tab
  // (in any window) takes over and background tabs never hold browser connections.
  /** @type {AbortController | null} */
  let abort = null;
  /** @type {(() => void) | null} */
  let closeOwn = null;
  /** @type {((value?: unknown) => void) | null} */
  let release = null;
  const join = () => {
    if (abort) return;
    abort = new AbortController();
    navigator.locks
      .request(key, { signal: abort.signal }, () => {
        const relay = Object.fromEntries(
          Object.keys(handlers).map((event) => [
            event,
            /** @param {any} data */
            (data) => {
              deliver(event, data);
              channel.postMessage({ event, data });
            },
          ]),
        );
        closeOwn = stream(url, relay);
        return new Promise((resolve) => (release = resolve));
      })
      .catch(() => {
        /* aborted before this tab got the lock */
      });
  };
  const leave = () => {
    abort?.abort();
    abort = null;
    closeOwn?.();
    closeOwn = null;
    release?.();
    release = null;
  };
  const onVisibility = () => (document.hidden ? leave() : join());
  if (!document.hidden) join();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    leave();
    channel.close();
  };
}

/**
 * Run a stream only while the tab is visible (background tabs hold no connection). `open` returns its closer.
 * @param {() => (() => void)} open
 * @returns {() => void}
 */
export function pausedWhenHidden(open) {
  if (typeof document === 'undefined') return open();
  let close = document.hidden ? null : open();
  const onVisibility = () => {
    if (document.hidden) {
      close?.();
      close = null;
    } else if (!close) close = open();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    close?.();
  };
}

// The signed-in person's Inbox count, from the one shared inbox stream that App opens.
/** @type {Set<(data: { needs_you?: number }) => void>} */
const inboxListeners = new Set();
/** @param {{ needs_you?: number }} data */
export function emitInboxCount(data) {
  for (const fn of [...inboxListeners]) fn(data);
}
/** Call `fn` with { needs_you } whenever the Inbox count changes. Returns an unsubscribe function. */
/** @param {(data: { needs_you?: number }) => void} fn */
export function onInboxCount(fn) {
  inboxListeners.add(fn);
  return () => inboxListeners.delete(fn);
}
