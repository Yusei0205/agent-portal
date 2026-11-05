/**
 * Switch engine — continue a session with another provider (e.g. Kiro credits are used up → Claude Code).
 *
 * The session keeps its conversation, repositories and work folder. The next turn starts on the chosen
 * engine with a recap of earlier turns (POST /api/projects/:id/workflows/:wid/engine).
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';
import { ENGINES, AgentPicker, ModelPicker, CredentialPicker } from './NewSessionDialog.jsx';

/**
 * @param {{
 *   workflow: { id: string, engine?: string, credential_id?: string | null },
 *   projectId: string,
 *   onClose: () => void,
 *   onSwitched: (workflow: object) => void,
 * }} props
 */
export function SwitchEngineDialog({ workflow, projectId, onClose, onSwitched }) {
  const current = workflow.engine || 'demo';
  // Default to the other real engine: the usual reason to switch is that the current one can't go on.
  const [engine, setEngine] = useState(current === 'kiro' ? 'claude-code' : current === 'claude-code' ? 'kiro' : 'claude-code');
  const [credSummary, setCredSummary] = useState(null);
  const [portalMode, setPortalMode] = useState('demo');
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('');
  const [leadAgent, setLeadAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const trapRef = useFocusTrap();
  const overlayDismiss = useOverlayDismiss(onClose);

  useEffect(() => {
    Promise.all([
      api.get('/api/credentials/summary').catch(() => ({ summary: [] })),
      api.get('/api/settings').catch(() => ({ provider: { mode: 'demo' } })),
    ]).then(([cs, s]) => {
      const map = {};
      for (const entry of cs.summary || []) map[entry.engine] = entry.credentials || [];
      setCredSummary(map);
      setPortalMode(s.provider?.mode || 'demo');
    });
  }, []);

  // Pick the default sign-in for the chosen engine; agent and model belong to the engine, so start over.
  useEffect(() => {
    if (!credSummary) return;
    const creds = credSummary[engine] || [];
    const def = creds.find((c) => c.isDefault) || creds[0];
    setCredentialId(def?.id || '');
  }, [engine, credSummary]);
  useEffect(() => { setModel(''); setLeadAgent(''); }, [engine]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isAvailable = (id) => {
    if (id === 'demo' || !credSummary) return true;
    const hasCreds = (credSummary[id] || []).length > 0;
    return hasCreds || Boolean(ENGINES.find((e) => e.id === id)?.providerModes?.includes(portalMode));
  };
  const credentials = credSummary ? (credSummary[engine] || []).map((c) => ({ ...c, engine })) : [];
  const unchanged = engine === current && (credentialId || null) === (workflow.credential_id || null) && !model && !leadAgent;

  const submit = async () => {
    if (busy || unchanged || !isAvailable(engine)) return;
    setBusy(true);
    setError(null);
    try {
      const { workflow: updated } = await api.post(`/api/projects/${projectId}/workflows/${workflow.id}/engine`, {
        engine,
        credentialId: credentialId || undefined,
        model: engine !== 'demo' && model ? model : undefined,
        leadAgent: engine !== 'demo' && leadAgent ? leadAgent : undefined,
      });
      onSwitched(updated);
      onClose();
    } catch (e) {
      setError(e.message || 'Could not switch engine');
      setBusy(false);
    }
  };

  const label = (id) => ENGINES.find((e) => e.id === id)?.label || id;

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={overlayDismiss.onMouseDown} onClick={overlayDismiss.onClick}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="switch-engine-title" style={{ maxWidth: 540 }} ref={trapRef}>
        <div className="dialog-head">
          <h2 className="dialog-title" id="switch-engine-title">Switch engine</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="dialog-body stack">
          <p className="muted" style={{ fontSize: '0.84rem', margin: 0 }}>
            Carry on with this session on another engine, for example when your Kiro credits are used up.
            The conversation, repositories and files stay. The next message starts on the new engine
            with a recap of earlier turns. It is now on <strong>{label(current)}</strong>.
          </p>

          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, fontSize: '0.86rem', marginBottom: 6 }}>Engine</legend>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {ENGINES.map((opt) => {
                const available = isAvailable(opt.id);
                return (
                  <label
                    key={opt.id}
                    className={`choice${engine === opt.id ? ' is-checked' : ''}${!available ? ' is-disabled' : ''}`}
                    style={{ flex: '1 1 140px' }}
                  >
                    <input
                      type="radio"
                      name="se-engine"
                      value={opt.id}
                      checked={engine === opt.id}
                      disabled={!available}
                      onChange={() => setEngine(opt.id)}
                    />
                    <span>
                      <strong>{opt.label}</strong>
                      {opt.id === current && <span className="muted"> (now)</span>}
                      <br />
                      <span className="muted small">
                        {available ? opt.hint : <a href="#/connect/sign-ins">Not set up yet</a>}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {engine !== 'demo' && (
            <>
              <CredentialPicker engine={engine} credentials={credentials} value={credentialId} onChange={setCredentialId} />
              <AgentPicker engine={engine} value={leadAgent} onChange={setLeadAgent} />
              <ModelPicker engine={engine} credentialId={credentialId} value={model} onChange={setModel} />
            </>
          )}

          <p className="field-hint" style={{ margin: 0 }}>
            Changes the agent has not committed stay in the session&rsquo;s folder on this server. In cloud sessions
            each engine has its own workspace, so ask the agent to commit and push first.
          </p>

          {error && <div className="error-note" role="alert">{error}</div>}
        </div>

        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || unchanged || !isAvailable(engine)}>
            {busy
              ? <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Switching…</>
              : <>Switch to {label(engine)}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SwitchEngineDialog;
