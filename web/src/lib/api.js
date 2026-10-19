// Thin client for the portal API. Every state-changing call carries the CSRF header.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, url, body, { raw } = {}) {
  const headers = { 'x-requested-with': 'agent-portal' };
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

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  del: (u, b) => request('DELETE', u, b),
  upload: (u, file) => request('PUT', u, undefined, { raw: file }),
};

/** Server-sent events with automatic reconnect. Returns a function that closes the stream. */
export function stream(url, handlers) {
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
