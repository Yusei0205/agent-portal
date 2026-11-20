import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { buildNavItems } from './CommandPalette.jsx';
import { navigate } from '../lib/router.js';
import { CAT_GREETING, catActions, fallbackReply, matchCatInput } from '../lib/cat-actions.js';

/**
 * The cat's shortcut panel (phase B1): a greeting, quick-action chips for the current page, and a box where typed text is matched to an
 * action or a page and opened. It answers no questions (no model, no network). Non-modal: the page behind stays usable. Escape closes
 * it; the cat gives focus to the input on open and takes it back on close. On a phone it is a full-width sheet at the bottom.
 */
export function CatChatPanel({ route, user, roam, onRoamChange, onClose, notice }) {
  const [messages, setMessages] = useState([{ id: 0, role: 'cat', text: CAT_GREETING }]);
  const [text, setText] = useState('');
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

  const say = (m) => setMessages((all) => [...all, { id: seq.current++, ...m }]);

  const submit = (e) => {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setText('');
    say({ role: 'me', text: q });
    const hit = matchCatInput(q, actions, buildNavItems(route, user));
    if (hit.kind === 'none') { say({ role: 'cat', text: fallbackReply(actions), }); return; }
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
            <p>{m.text}{m.href && <> <a className="cat-bubble-link" href={m.href} onClick={() => onClose({ restoreFocus: false })}>Open</a></>}</p>
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
          placeholder="Type a page or action, like inbox"
          aria-label="Tell the cat where to go"
          autoComplete="off"
          maxLength={120}
        />
        <button type="submit" className="cat-panel-send" aria-label="Go" disabled={!text.trim()}><Icon name="send" size={14} /></button>
      </form>
      <footer className="cat-panel-foot">
        <label className="cat-panel-roam">
          <input type="checkbox" checked={roam} onChange={(e) => onRoamChange(e.target.checked)} /> Allow cat to roam
        </label>
        <span className="cat-panel-note">Shortcuts only for now</span>
      </footer>
    </div>
  );
}
