import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import ModelOptions from './ModelOptions.jsx';

/**
 * Which credential and model an AI feature (for example test generation) should use, like the New session dialog.
 *
 * Lists the person's own Claude Code credentials and the models they can use, and reports { credentialId, model }
 * through onChange. With no credential of their own the portal's provider is used, and the picker says so.
 * "Portal default" for the model leaves it to the portal setting.
 *
 * With `allowPortalDefault` the first choice is "Portal default" (no sign-in of the person's own), and it stays selected until
 * they pick one: for features that already work without a choice (code review) and must not change for people who do not care.
 */
export function AiChoicePicker({ onChange, disabled = false, idPrefix = 'ai', allowPortalDefault = false }) {
  const [creds, setCreds] = useState(null);       // null while loading
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState(null);

  // The person's Claude Code credentials; their default one is selected first.
  useEffect(() => {
    let cancelled = false;
    api.get('/api/credentials/summary')
      .catch(() => ({ summary: [] }))
      .then((cs) => {
        if (cancelled) return;
        // Claude Code credentials first (they also give a choice of model), then Kiro ones.
        const list = [];
        for (const engine of ['claude-code', 'kiro']) {
          const entry = (cs.summary || []).find((e) => e.engine === engine);
          for (const c of entry?.credentials || []) list.push({ ...c, engine });
        }
        if ((cs.summary || []).some(e => e.engine === 'codex' && e.configured)) list.push({ id: 'codex-account', name: 'My ChatGPT account', engine: 'codex' });
        setCreds(list);
        const def = list.find((c) => c.engine === 'claude-code' && c.isDefault) || list[0];
        if (def && !allowPortalDefault) setCredentialId(def.id);
      });
    return () => { cancelled = true; };
  }, []);

  const chosen = (creds || []).find((c) => c.id === credentialId) || null;
  const isKiro = chosen?.engine === 'kiro';

  const loadModels = useCallback(async () => {
    if (creds === null || !chosen) { setModels([]); return; }
    setModelsLoading(true);
    setModelError(null);
    try {
      const qs = credentialId && chosen.engine !== 'codex' ? `?credentialId=${encodeURIComponent(credentialId)}` : '';
      const data = await api.get(`/api/engines/${chosen.engine}/models${qs}`);
      setModels(data.models || []);
      if (data.error) setModelError(data.error);
    } catch (e) {
      setModels([]);
      setModelError(e.message || 'Could not load the models');
    } finally {
      setModelsLoading(false);
    }
  }, [creds, credentialId, isKiro, chosen]);

  useEffect(() => { loadModels(); }, [loadModels]);

  useEffect(() => {
    onChange?.({ credentialId: credentialId || undefined, model: model || undefined });
  }, [credentialId, model]); // eslint-disable-line react-hooks/exhaustive-deps

  if (creds === null) return null;

  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-cred`}>Credential</label>
        {creds.length === 0 ? (
          <p className="field-hint" id={`${idPrefix}-cred`}>
            You have no credential of your own, so the portal&rsquo;s AI provider is used. Add one under{' '}
            <a href="#/config/sign-ins">Agent setup › Sign-ins</a> to choose here.
          </p>
        ) : (
          <select
            id={`${idPrefix}-cred`}
            value={credentialId}
            onChange={(e) => { setCredentialId(e.target.value); setModel(''); }}
            disabled={disabled}
          >
            {allowPortalDefault && <option value="">Portal default</option>}
            {creds.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.engine === 'kiro' ? 'Kiro' : c.engine === 'codex' ? 'Codex' : 'Claude'}){c.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        )}
      </div>
      {(!allowPortalDefault || credentialId) && <div className="field">
        <label htmlFor={`${idPrefix}-model`}>Model</label>
        {modelsLoading ? (
          <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading models…" />
        ) : (
          <select
            id={`${idPrefix}-model`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={disabled}
          >
            <option value="">{isKiro ? 'Kiro default' : chosen?.engine === 'codex' ? 'Codex default' : 'Portal default'}</option>
            <ModelOptions models={models} />
          </select>
        )}
        {modelError && <p className="field-hint" style={{ color: 'var(--danger)' }}>{modelError}</p>}
      </div>}
    </>
  );
}
