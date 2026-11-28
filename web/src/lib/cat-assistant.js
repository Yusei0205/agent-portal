/** The cat panel's assistant helpers: when to ask the model, which history to send, how errors read. Pure functions. */

/** True when the shortcut matcher found nothing and the text is at least 3 characters: then the question goes to the assistant. */
export function shouldAsk(hit, text) {
  return !!hit && hit.kind === 'none' && String(text ?? '').trim().length >= 3;
}

/**
 * The last 4 exchanges (8 messages), each text cut to 600 characters, as { role, text }. The greeting (id 0), notices (href),
 * pending and error messages are left out.
 */
export function trimHistory(messages) {
  return (messages ?? [])
    .filter((m) => m && (m.role === 'me' || m.role === 'cat') && m.id !== 0 && !m.href && !m.pending && !m.error && typeof m.text === 'string' && m.text)
    .slice(-8)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 600) }));
}

/** A friendly sentence for a failed chat call (an ApiError: `.status`, `.data.code`). */
export function describeAssistantError(err) {
  switch (err?.data?.code) {
    case 'no_sign_in': return 'Connect a sign-in in Agent sign-ins to chat with me.';
    case 'rate_limited': return "That's a lot of questions at once. Try again in a minute.";
    case 'too_long': return "That's too long for me. Try a shorter question.";
    default: return "I couldn't answer that just now. Please try again.";
  }
}

// ── Conversation kept per project, in this browser ─────────────────────────────

const CHAT_MAX = 20;
const CHAT_TTL_MS = 14 * 24 * 3600 * 1000;

/** The browser-storage key for one person's conversation in one project ("portal" outside a project). */
export function chatKey(userId, projectId) {
  return `portal.cat.chat.${userId}.${projectId || 'portal'}`;
}

function cleanMessage(m) {
  if (!m || (m.role !== 'me' && m.role !== 'cat') || typeof m.text !== 'string' || !m.text) return null;
  const out = { role: m.role, text: m.text };
  if (typeof m.href === 'string' && m.href) out.href = m.href;
  if (m.error === true) out.error = true;
  if (Array.isArray(m.links) && m.links.length) {
    const links = m.links.filter((l) => l && typeof l.id === 'string' && typeof l.label === 'string' && typeof l.href === 'string')
      .map((l) => ({ id: l.id, label: l.label, href: l.href }));
    if (links.length) out.links = links;
  }
  return out;
}

/** The conversation as stored: the newest 20 messages, without the greeting (id 0) or a reply still pending. */
export function serialiseChat(messages, now) {
  const kept = (messages ?? []).filter((m) => m && m.id !== 0 && !m.pending).map(cleanMessage).filter(Boolean).slice(-CHAT_MAX);
  return JSON.stringify({ savedAt: now, messages: kept });
}

/** A stored conversation back as messages (without ids), or [] when there is none, it is unreadable or older than 14 days. */
export function parseChat(raw, now) {
  if (typeof raw !== 'string' || !raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!data || typeof data.savedAt !== 'number' || !Array.isArray(data.messages)) return [];
  if (now - data.savedAt > CHAT_TTL_MS) return [];
  return data.messages.map(cleanMessage).filter(Boolean).slice(-CHAT_MAX);
}
