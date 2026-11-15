/**
 * /clear starts the conversation again: what came before it is no longer sent to the agent, and the chat hides it
 * (with a button to show it). The portal saves the answer to /clear as a "command-result" event whose text starts with "/clear".
 */

const isClearResult = (e) => {
  if (e?.src !== 'w' || e.type !== 'command-result') return false;
  const raw = typeof e.payload === 'string' ? e.payload : (e.payload?.text ?? e.payload?.body ?? '');
  const cut = String(raw).indexOf('\n---\n');
  const command = cut >= 0 ? String(raw).slice(0, cut) : (e.payload?.command ?? '');
  return /^\/clear(\s|$)/i.test(String(command).trim());
};

/** When the latest /clear was answered (an ISO time), or '' when the chat was never cleared. */
export function lastClearAt(events) {
  let at = '';
  for (const e of events) if (isClearResult(e)) { const t = String(e.created_at || ''); if (t > at) at = t; }
  return at;
}

/** The events from the latest /clear on (all of them when there was none). */
export function afterClear(events, at) {
  return at ? events.filter((e) => String(e.created_at || '') >= at) : events;
}
