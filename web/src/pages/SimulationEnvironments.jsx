/**
 * Environments of a simulated API (dev, UAT, prod).
 *
 *   EnvironmentBar      under the page header: the base URL in use, and the environment to switch to
 *   EnvironmentsEditor  on the Settings tab: each environment's base URL, variables and login, and import from files
 *
 * Secret values and login header values are never sent to the browser: a saved one shows as "Saved" and keeps its value
 * when the field is left empty.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';

const newKey = () => `n${Math.random().toString(36).slice(2, 8)}`;

// ── Under the header ────────────────────────────────────────────────────────────────────────────────────────────────

export function EnvironmentBar({ data, projectId, reload, toast, onManage }) {
  const a = data.api;
  const envs = a.environments || [];
  const active = envs.find((e) => e.id === a.activeEnvironment);
  const [busy, setBusy] = useState(false);

  const choose = async (id) => {
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/sim/apis/${a.id}/environments/active`, { active: id });
      await reload();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="sim-envbar" aria-label="Base URL and environment">
      <span className="sim-envbar-label">Base URL</span>
      {a.liveBaseUrl
        ? <code className="sim-envbar-url" title={a.liveBaseUrl}>{a.liveBaseUrl}</code>
        : <span className="muted small">Not set yet</span>}
      {envs.length > 0 && (
        <label className="sim-version small">
          Environment
          <select value={a.activeEnvironment || ''} disabled={busy} onChange={(e) => choose(e.target.value)} aria-label="Environment">
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      )}
      <button type="button" className="btn btn-sm btn-ghost" onClick={onManage}>{envs.length > 0 ? 'Manage environments' : 'Add environments'}</button>
      {active?.problem && <span className="sim-envbar-problem small" role="alert"><Icon name="warning" size={13} /> {active.problem}</span>}
      <span className="sim-envbar-note muted small">
        {a.mode === 'mock'
          ? 'Calls are answered by the portal. This address is used when you switch to the client’s real API.'
          : 'Live calls go to this address.'}
      </span>
    </div>
  );
}

// ── Settings: edit and import ───────────────────────────────────────────────────────────────────────────────────────

const fromServer = (list) => (list || []).map((e) => ({
  id: e.id, name: e.name, baseUrl: e.baseUrl, resolved: e.resolvedBaseUrl, problem: e.problem,
  variables: e.variables.map((v) => ({ key: v.key, value: v.value, secret: v.secret, saved: v.saved, rid: newKey() })),
  headers: e.headers.map((h) => ({ name: h.name, value: '', saved: true, rid: newKey() })),
}));

export function EnvironmentsEditor({ data, projectId, reload, toast }) {
  const a = data.api;
  const serverKey = JSON.stringify(a.environments || []);
  const [envs, setEnvs] = useState(() => fromServer(a.environments));
  const [active, setActive] = useState(a.activeEnvironment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef(null);

  // After a save, an import or a switch in the bar the server's copy replaces the form (unless there are unsaved edits).
  useEffect(() => {
    if (!dirty) { setEnvs(fromServer(a.environments)); setActive(a.activeEnvironment || ''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey, a.activeEnvironment]);

  const edit = (fn) => { setEnvs(fn); setDirty(true); };
  const patchEnv = (id, p) => edit((list) => list.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const patchVar = (id, rid, p) => edit((list) => list.map((e) => (e.id === id ? { ...e, variables: e.variables.map((v) => (v.rid === rid ? { ...v, ...p } : v)) } : e)));
  const patchHeader = (id, rid, p) => edit((list) => list.map((e) => (e.id === id ? { ...e, headers: e.headers.map((h) => (h.rid === rid ? { ...h, ...p } : h)) } : e)));

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.put(`/api/projects/${projectId}/sim/apis/${a.id}/environments`, {
        active,
        environments: envs.map((e) => ({
          id: String(e.id).startsWith('new-') ? undefined : e.id,
          name: e.name, baseUrl: e.baseUrl,
          variables: e.variables.map((v) => ({ key: v.key, value: v.value, secret: v.secret })),
          headers: e.headers.map((h) => ({ name: h.name, value: h.value })),
        })),
      });
      setDirty(false);
      toast('Environments saved.', 'ok');
      await reload();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const importFiles = async (fileList) => {
    const files = [...(fileList || [])];
    if (files.length === 0) return;
    setBusy(true); setError('');
    try {
      const payload = [];
      for (const f of files) payload.push({ name: f.name, content: await f.text() });
      const r = await api.post(`/api/projects/${projectId}/sim/apis/${a.id}/environments/import`, { files: payload });
      const bits = [];
      if (r.added?.length) bits.push(`added ${r.added.join(', ')}`);
      if (r.updated?.length) bits.push(`updated ${r.updated.join(', ')}`);
      if (r.skipped?.length) bits.push(`no room for ${r.skipped.join(', ')} (10 at most)`);
      toast(`Environments: ${bits.join('; ') || 'nothing new'}.`, 'ok');
      if (r.notes?.length) toast(r.notes.join(' '), 'ok');
      setDirty(false);
      await reload();
    } catch (e) { setError(e.message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const addEnv = () => {
    const id = `new-${newKey()}`;
    edit((list) => [...list, { id, name: '', baseUrl: '', resolved: '', problem: '', variables: [], headers: [] }]);
    if (!active) setActive(id);
  };
  const removeEnv = (id) => {
    edit((list) => list.filter((e) => e.id !== id));
    if (active === id) setActive('');
  };

  return (
    <div className="card stack" aria-label="Environments">
      <h3 className="sim-h3">Environments</h3>
      <p className="muted small" style={{ margin: 0 }}>
        The client’s API has a different address and login in dev, UAT and prod. The environment chosen at the top of the page is
        the one live calls use. Write <code>{'{{name}}'}</code> in a base URL or a login value to use a variable.
      </p>

      {envs.length === 0 && <p className="muted small">No environments yet. Add one, or import a Postman environment, a Postman collection, an OpenAPI file or a .env file.</p>}

      {envs.map((e) => (
        <div key={e.id} className={`sim-env${active === e.id ? ' is-active' : ''}`}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="text" aria-label="Environment name" placeholder="dev, uat, prod" style={{ maxWidth: 200 }} value={e.name} maxLength={60} disabled={busy} onChange={(ev) => patchEnv(e.id, { name: ev.target.value })} />
            {active === e.id
              ? <span className="badge badge-ok">In use</span>
              : <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setActive(e.id); setDirty(true); }}>Use this environment</button>}
            <span className="spacer" style={{ flex: 1 }} />
            <button type="button" className="btn-icon" aria-label={`Remove ${e.name || 'environment'}`} disabled={busy} onClick={() => removeEnv(e.id)}><Icon name="trash" size={14} /></button>
          </div>

          <div className="field">
            <label>Base URL</label>
            <input type="text" aria-label={`Base URL of ${e.name || 'the environment'}`} value={e.baseUrl} placeholder="https://api.client.example/v1  or  {{baseUrl}}" spellCheck={false} disabled={busy} onChange={(ev) => patchEnv(e.id, { baseUrl: ev.target.value })} />
            {e.resolved && e.resolved !== e.baseUrl && !dirty && <span className="field-hint">Becomes <code>{e.resolved}</code></span>}
            {e.problem && !dirty && <span className="field-hint sim-envbar-problem">{e.problem}</span>}
          </div>

          <div className="field">
            <span className="field-label">Variables</span>
            {e.variables.map((v) => (
              <div key={v.rid} className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="text" aria-label="Variable name" style={{ width: 180 }} value={v.key} placeholder="name" disabled={busy} onChange={(ev) => patchVar(e.id, v.rid, { key: ev.target.value })} />
                <input type={v.secret ? 'password' : 'text'} aria-label={`Value of ${v.key || 'the variable'}`} autoComplete="off" style={{ flex: 1, minWidth: 160 }} value={v.value} disabled={busy}
                  placeholder={v.secret && v.saved ? 'Saved. Type to replace' : 'value'} onChange={(ev) => patchVar(e.id, v.rid, { value: ev.target.value })} />
                <label className="sim-check small" title="Secret values are stored encrypted and never shown again">
                  <input type="checkbox" checked={v.secret} disabled={busy} onChange={(ev) => patchVar(e.id, v.rid, { secret: ev.target.checked })} /> <span>Secret</span>
                </label>
                <button type="button" className="btn-icon" aria-label={`Remove variable ${v.key || ''}`} disabled={busy} onClick={() => edit((list) => list.map((x) => (x.id === e.id ? { ...x, variables: x.variables.filter((y) => y.rid !== v.rid) } : x)))}><Icon name="trash" size={14} /></button>
              </div>
            ))}
            <div><button type="button" className="btn btn-sm" disabled={busy || e.variables.length >= 100} onClick={() => edit((list) => list.map((x) => (x.id === e.id ? { ...x, variables: [...x.variables, { key: '', value: '', secret: false, saved: false, rid: newKey() }] } : x)))}><Icon name="plus" size={12} /> Add variable</button></div>
          </div>

          <div className="field">
            <span className="field-label">Login headers <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></span>
            {e.headers.map((h) => (
              <div key={h.rid} className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input type="text" aria-label="Header name" style={{ width: 180 }} value={h.name} placeholder="Authorization" disabled={busy || h.saved} onChange={(ev) => patchHeader(e.id, h.rid, { name: ev.target.value })} />
                <input type="password" aria-label={`Value of ${h.name || 'the header'}`} autoComplete="off" style={{ flex: 1, minWidth: 160 }} value={h.value} disabled={busy}
                  placeholder={h.saved ? 'Saved. Type to replace' : 'Bearer {{token}}'} onChange={(ev) => patchHeader(e.id, h.rid, { value: ev.target.value })} />
                <button type="button" className="btn-icon" aria-label={`Remove ${h.name || 'header'}`} disabled={busy} onClick={() => edit((list) => list.map((x) => (x.id === e.id ? { ...x, headers: x.headers.filter((y) => y.rid !== h.rid) } : x)))}><Icon name="trash" size={14} /></button>
              </div>
            ))}
            {e.headers.length < 5 && <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => edit((list) => list.map((x) => (x.id === e.id ? { ...x, headers: [...x.headers, { name: '', value: '', saved: false, rid: newKey() }] } : x)))}><Icon name="plus" size={12} /> Add login header</button></div>}
            <span className="field-hint">When this environment is in use, these replace the login under “Login for the live API”. Stored encrypted and never shown again.</span>
          </div>
        </div>
      ))}

      {error && <p className="error-note" role="alert">{error}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn" disabled={busy || envs.length >= 10} onClick={addEnv}><Icon name="plus" size={14} /> Add environment</button>
        <label className={`btn${busy ? ' disabled' : ''}`} style={{ position: 'relative' }}>
          <Icon name="upload" size={14} /> Import from files
          <input ref={fileRef} type="file" multiple accept=".json,.env,.txt,text/plain,application/json" className="sim-visually-hidden" disabled={busy}
            aria-label="Import environments from files" onChange={(ev) => importFiles(ev.target.files)} />
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save environments'}</button>
      </div>
      <span className="field-hint">Import reads Postman environments (.json), a Postman collection’s variables, an OpenAPI file’s servers, and .env files. One file can make one or several environments; one with the same name is updated.</span>
    </div>
  );
}
