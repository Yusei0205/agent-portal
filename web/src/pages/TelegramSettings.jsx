/**
 * Connect > Telegram: set up the Telegram bot that controls this portal from a chat.
 *
 * Everything is saved encrypted in the portal and the bot restarts at once, so .env is not needed
 * (it still works when nothing is saved here). Tokens are write-only: only their last characters are shown.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { SectionHead } from '../components/PageHeader.jsx';
import { useConfirm, ConfirmDialog } from '../components/ConfirmDialog.jsx';

function StatusLine({ data }) {
  const s = data.status || {};
  if (s.running) {
    return (
      <p className="success-note" role="status">
        The bot <strong>@{s.botUsername}</strong> is on and answers {s.allowedChats} allowed chat{s.allowedChats === 1 ? '' : 's'}.
        {s.source === 'env' ? ' Its settings come from the .env file.' : ''}
      </p>
    );
  }
  if (s.error) return <p className="error-note" role="alert">The bot is not running: {s.error}</p>;
  if (data.saved && !data.enabled) return <p className="muted" role="status">The bot is turned off.</p>;
  return <p className="muted" role="status">The bot is not set up yet. Follow the steps below.</p>;
}

export function TelegramSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ botToken: '', chatIds: '', engine: '', enabled: true });
  const [busy, setBusy] = useState(null); // null | 'save' | 'test' | 'token' | 'clear'
  const [note, setNote] = useState(null); // { ok, text }
  const { confirmState, requestConfirm } = useConfirm();

  const apply = (d) => {
    setData(d);
    setForm({ botToken: '', chatIds: (d.allowedChatIds || []).join(', '), engine: d.defaultEngine || '', enabled: d.enabled !== false });
  };

  const load = useCallback(async () => {
    try { apply(await api.get('/api/telegram')); setError(null); }
    catch (e) { setError(e.status === 403 ? 'Only an admin can set up the Telegram bot.' : (e.message || 'Could not load the Telegram settings')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (kind, fn) => {
    setBusy(kind); setNote(null); setError(null);
    try { await fn(); } catch (e) { setError(e.message || 'Something went wrong'); } finally { setBusy(null); }
  };

  const save = (e) => {
    e.preventDefault();
    run('save', async () => {
      const body = { allowedChatIds: form.chatIds, defaultEngine: form.engine, enabled: form.enabled };
      if (form.botToken.trim()) body.botToken = form.botToken.trim();
      const d = await api.put('/api/telegram', body);
      apply(d);
      setNote({ ok: true, text: d.status?.running ? 'Saved. The bot restarted with the new settings.' : 'Saved.' });
    });
  };

  const test = () => run('test', async () => {
    const r = await api.post('/api/telegram/test', form.botToken.trim() ? { botToken: form.botToken.trim() } : {});
    setNote(r.ok ? { ok: true, text: `Telegram knows this bot: @${r.botUsername}.` } : { ok: false, text: r.error });
  });

  const makeToken = () => run('token', async () => {
    apply(await api.post('/api/telegram/token'));
    setNote({ ok: true, text: 'Created the bot\'s access to the portal (read and write, valid for a year).' });
  });

  const clear = async () => {
    const ok = await requestConfirm('Forget the Telegram settings saved here? The bot stops (unless .env sets one up) and its portal access is revoked.', 'Forget settings', 'danger');
    if (!ok) return;
    run('clear', async () => { apply(await api.delete('/api/telegram')); setNote({ ok: true, text: 'Settings forgotten.' }); });
  };

  if (error && !data) return <div className="error-note" role="alert">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.available) {
    return <p className="muted">The Telegram bot runs only in a portal on your own computer, not in the cloud deployment.</p>;
  }

  const pt = data.portalToken;
  return (
    <div className="telegram-settings">
      <ConfirmDialog state={confirmState} />
      <SectionHead description="Control this portal from a Telegram chat: pick a project, start or message a session, stop it, and get the agent's reply. The portal asks Telegram for new messages, so no public address is needed." />
      <StatusLine data={data} />

      <form className="aws-form" onSubmit={save} autoComplete="off">
        <div className="field">
          <label htmlFor="tg-token">1. Bot token</label>
          <input
            id="tg-token" type="password" value={form.botToken} spellCheck={false} autoComplete="new-password"
            placeholder={data.botTokenHint ? `Saved (${data.botTokenHint}). Leave empty to keep it` : '123456789:AAE…'}
            onChange={(e) => setForm((f) => ({ ...f, botToken: e.target.value }))}
          />
          <p className="field-hint">In Telegram, message @BotFather, send /newbot and copy the token it gives you.</p>
          <button type="button" className="btn btn-sm" style={{ justifySelf: 'start' }} onClick={test} disabled={busy !== null}>
            {busy === 'test' ? 'Testing…' : 'Test bot token'}
          </button>
        </div>

        <div className="field">
          <label htmlFor="tg-chats">2. Allowed chat IDs</label>
          <input
            id="tg-chats" type="text" inputMode="numeric" value={form.chatIds} spellCheck={false} placeholder="123456789"
            onChange={(e) => setForm((f) => ({ ...f, chatIds: e.target.value }))}
          />
          <p className="field-hint">Only these private chats get an answer; everyone else is ignored. Get your ID from @userinfobot. Separate several with commas.</p>
        </div>

        <div className="field">
          <span className="field-label">3. The bot's access to the portal</span>
          {pt
            ? <p className={pt.valid ? 'muted small' : 'error-note'}>
                {pt.valid
                  ? `Set (${pt.hint}), acting as ${pt.owner || 'you'} with read and write${pt.expiresAt ? `, until ${new Date(pt.expiresAt).toLocaleDateString()}` : ''}.`
                  : 'The bot\'s API token was revoked or has expired. Create a new one.'}
              </p>
            : <p className="muted small">Not created yet. The bot acts as you with read and write only (it can't merge, and like every API token it can't approve tool calls).</p>}
          <button type="button" className="btn btn-sm" style={{ justifySelf: 'start' }} onClick={makeToken} disabled={busy !== null}>
            {busy === 'token' ? 'Creating…' : pt ? 'Replace access token' : 'Create access token'}
          </button>
        </div>

        <div className="aws-form-row">
          <div className="field">
            <label htmlFor="tg-engine">Engine for /new</label>
            <select id="tg-engine" value={form.engine} onChange={(e) => setForm((f) => ({ ...f, engine: e.target.value }))}>
              <option value="">Same as the project's latest session</option>
              {(data.engines || []).map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div className="field">
            <span className="field-label">Bot</span>
            <label className="choice">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
              <span>On</span>
            </label>
          </div>
        </div>

        {note && <p className={note.ok ? 'success-note' : 'error-note'} role="status">{note.text}</p>}
        {error && <div className="error-note" role="alert">{error}</div>}
        <div className="aws-form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save and restart the bot'}</button>
          {data.saved && <button type="button" className="btn" onClick={clear} disabled={busy !== null}>Forget settings</button>}
        </div>
        {data.envConfigured && !data.saved && (
          <p className="field-hint">The .env file sets up a bot now. Saving here takes over from it.</p>
        )}
      </form>
    </div>
  );
}

export default TelegramSettings;
