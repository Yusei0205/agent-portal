/**
 * Live updates over AWS AppSync Events (cloud portal).
 *
 * When the server reports realtime is enabled (GET /api/realtime/config), the browser keeps ONE WebSocket
 * to AppSync and multiplexes channel subscriptions over it. When it is not enabled (local install, Docker),
 * callers fall back to Server-Sent Events.
 *
 *   subscribeChannel('/project/<id>', onEvent)  ->  unsubscribe()
 *   realtimeAvailable()                         ->  Promise<boolean>
 */

let configPromise = null;
let config = null; // { enabled, httpDomain, realtimeDomain, token, expiresIn, fetchedAt }

async function fetchConfig() {
  const res = await fetch('/api/realtime/config', { credentials: 'include' });
  // Not signed in yet (or a server error): report disabled, but do not remember it.
  if (!res.ok) return { enabled: false, transient: true, fetchedAt: Date.now() };
  const body = await res.json();
  return { ...body, fetchedAt: Date.now() };
}

/** Returns the config, refreshing the token when it is close to expiring. */
async function getConfig() {
  const stale = config && config.enabled && Date.now() - config.fetchedAt > (config.expiresIn - 300) * 1000;
  if (!configPromise || stale) {
    configPromise = fetchConfig().then((c) => { config = c; if (c.transient) configPromise = null; return c; }).catch(() => {
      configPromise = null;
      return { enabled: false };
    });
  }
  return configPromise;
}

export async function realtimeAvailable() {
  const c = await getConfig();
  return Boolean(c.enabled);
}

// ── Shared connection ─────────────────────────────────────────────────────────

const subs = new Map(); // channel -> Set<onEvent>
const wsIds = new Map(); // channel -> subscription id on the current socket
let ws = null;
let ready = false;
let connecting = false;
let retryDelay = 1000;
let retryTimer = null;

const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sendSubscribe(channel) {
  if (!ready || !ws || wsIds.has(channel)) return;
  const id = `s${Math.random().toString(36).slice(2)}`;
  wsIds.set(channel, id);
  ws.send(JSON.stringify({
    type: 'subscribe',
    id,
    channel,
    authorization: { Authorization: config.token, host: config.httpDomain },
  }));
}

async function connect() {
  if (connecting || ws) return;
  connecting = true;
  const c = await getConfig();
  if (!c.enabled || subs.size === 0) { connecting = false; return; }

  const auth = b64url(JSON.stringify({ Authorization: c.token, host: c.httpDomain }));
  const socket = new WebSocket(`wss://${c.realtimeDomain}/event/realtime`, ['aws-appsync-event-ws', `header-${auth}`]);
  ws = socket;

  socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init' }));

  socket.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'connection_ack') {
      ready = true;
      retryDelay = 1000;
      for (const channel of subs.keys()) sendSubscribe(channel);
    } else if (msg.type === 'data') {
      let channel = null;
      for (const [ch, id] of wsIds) if (id === msg.id) { channel = ch; break; }
      if (!channel) return;
      let event = msg.event;
      if (typeof event === 'string') { try { event = JSON.parse(event); } catch { return; } }
      for (const fn of [...(subs.get(channel) ?? [])]) {
        try { fn(event); } catch { /* a broken listener must not stop others */ }
      }
    }
  };

  const drop = () => {
    if (ws !== socket) return;
    ws = null; ready = false; connecting = false;
    wsIds.clear();
    if (subs.size === 0) return;
    // A fresh token is fetched on the next attempt if the old one is close to expiry.
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  };
  socket.onclose = drop;
  socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } };
  connecting = false;
}

/**
 * Subscribe to an AppSync channel. Events are plain objects (already JSON-parsed).
 * @param {string} channel e.g. '/project/<id>', '/global/portal', '/run/<id>'
 * @param {(event: Record<string, unknown>) => void} onEvent
 * @returns {() => void} unsubscribe
 */
export function subscribeChannel(channel, onEvent) {
  let set = subs.get(channel);
  if (!set) { set = new Set(); subs.set(channel, set); }
  set.add(onEvent);
  if (ready) sendSubscribe(channel); else connect();

  return function unsubscribe() {
    const s = subs.get(channel);
    if (!s) return;
    s.delete(onEvent);
    if (s.size > 0) return;
    subs.delete(channel);
    const id = wsIds.get(channel);
    if (id && ws && ready) ws.send(JSON.stringify({ type: 'unsubscribe', id }));
    wsIds.delete(channel);
    if (subs.size === 0 && ws) { clearTimeout(retryTimer); try { ws.close(); } catch { /* ignore */ } }
  };
}
