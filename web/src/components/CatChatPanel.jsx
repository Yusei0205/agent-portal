import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { buildNavItems } from './CommandPalette.jsx';
import { navigate } from '../lib/router.js';
import { CAT_GREETING, catActions, matchCatInput } from '../lib/cat-actions.js';
import { describeAssistantError, shouldAsk, trimHistory } from '../lib/cat-assistant.js';
import { api } from '../lib/api.js';

/**
 * The cat's panel: a greeting, quick-action chips for the current page, and a box where typed text is matched to an action or a page and
 * opened; anything else is asked of the read-only assistant (POST /api/assistant/chat) and the reply is shown as plain text with link
 * buttons. Non-modal: the page behind stays usable. Escape closes
 * it; the cat gives focus to the input on open and takes it back on close. On a phone it is a full-width sheet at the bottom.
 */
export function CatChatPanel({ route, user, roam, onRoamChange, onClose, notice }) {
  const [messages, setMessages] = useState([{ id: 0, role: 'cat', text: CAT_GREETING }]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const seq = useRef(1);
  const actions = catActions(route);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // A reaction (a session finished, something needs you) that arrives while the panel is open is said here instead of in a bubble.
  useEffect(() => {
    if (notice) setMessages((m) => [...m, { id: seq.current++, role: 'cat', text: notice.text, href: notice.href }]);
  }, [notice]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const go = (item) => {
    onClose({ restoreFocus: false }); // the page we go to takes focus
    navigate(item.href);
    if (item.after === 'new-session') {
      // The Sessions page owns the new-session dialog and opens it on Alt+N; give a page we are navigating to a moment to mount.
      setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true })), 450);
    }
  };

  // Keep the newest 20 messages.
  const push = (all, ...more) => [...all, ...more].slice(-20);

  const ask = async (q) => {
    const history = trimHistory(messages);
    const pendingId = seq.current++;
    const meId = seq.current++;
    setMessages((all) => push(all, { id: meId, role: 'me', text: q }, { id: pendingId, role: 'cat', text: '', pending: true }));
    setPending(true);
    const replace = (m) => setMessages((all) => all.map((x) => (x.id === pendingId ? { id: pendingId, role: 'cat', ...m } : x)));
    try {
      const r = await api.post('/api/assistant/chat', { question: q, projectId: route.projectId ?? undefined, history });
      replace({ text: String(r?.reply ?? ''), links: Array.isArray(r?.links) ? r.links : [] });
    } catch (err) {
      // The unanswered question stays on screen but is not sent as history (no two `me` entries in a row).
      setMessages((all) => all.map((x) => (x.id === meId ? { ...x, error: true } : x)));
      const signIn = err?.data?.code === 'no_sign_in';
      replace({ text: describeAssistantError(err), error: true, links: signIn ? [{ id: 'sign-ins', label: 'Agent sign-ins', href: '#/config/sign-ins' }] : [] });
    } finally {
      setPending(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || pending) return;
    setText('');
    const hit = matchCatInput(q, actions, buildNavItems(route, user));
    if (shouldAsk(hit, q)) { void ask(q); return; }
    setMessages((all) => push(all, { id: seq.current++, role: 'me', text: q }));
    if (hit.kind === 'none') {
      setMessages((all) => push(all, { id: seq.current++, role: 'cat', text: 'Type a page or ask me a question.', error: true }));
      return;
    }
    go(hit.item);
  };

  return (
    <div
      className="cat-panel"
      role="dialog"
      aria-label="Cat assistant"
      data-testid="cat-panel"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <header className="cat-panel-head">
        <span className="cat-panel-title"><Icon name="sparkles" size={14} /> Chat with Agent</span>
        <button type="button" className="cat-panel-close" aria-label="Close the cat assistant" onClick={() => onClose()}><Icon name="x" size={14} /></button>
      </header>
      <div className="cat-panel-log" ref={logRef} role="log" aria-live="polite">
        {messages.map((m) => (
          <div key={m.id} className={`cat-msg cat-msg-${m.role}`}>
            <p className={m.pending ? 'cat-msg-pending' : undefined}>
              {m.pending && <span className="cat-typing" role="status" aria-label="The cat is thinking"><i /><i /><i /></span>}
              {m.text}{m.href && <> <a className="cat-bubble-link" href={m.href} onClick={() => onClose({ restoreFocus: false })}>Open</a></>}
            </p>
            {m.links?.length > 0 && (
              <div className="cat-msg-links">
                {m.links.map((l) => <button key={l.id} type="button" className="cat-chip" onClick={() => go(l)}>{l.label}</button>)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="cat-chips" role="group" aria-label="Quick actions">
        {actions.map((a) => (
          <button key={a.id} type="button" className="cat-chip" onClick={() => go(a)}>{a.label}</button>
        ))}
      </div>
      <form className="cat-panel-form" onSubmit={submit}>
        <input
          ref={inputRef}
          className="cat-panel-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask a question or type a page, like inbox"
          aria-label="Tell the cat where to go"
          autoComplete="off"
          maxLength={1000}
          readOnly={pending}
        />
        <button type="submit" className="cat-panel-send" aria-label="Go" disabled={pending || !text.trim()}><Icon name="send" size={14} /></button>
      </form>
      <footer className="cat-panel-foot">
        <label className="cat-panel-roam">
          <input type="checkbox" checked={roam} onChange={(e) => onRoamChange(e.target.checked)} /> Allow cat to roam
        </label>
        <span className="cat-panel-note">Answers use your own sign-in</span>
      </footer>
    </div>
  );
}
