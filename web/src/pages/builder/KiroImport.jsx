import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, useProject } from '../../lib/context.js';
import { Button, ErrorNote, Field, Modal, Segmented, useUi } from '../../components/ui.jsx';

/** The parts of a .kiro folder an import reads (the server applies the same rule). */
const KIRO_IMPORT_TOPS = ['agents', 'skills', 'steering', 'prompts', 'specs', 'docs'];

function kiroUploadPath(raw) {
  let parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  const k = parts.indexOf('.kiro');
  if (k >= 0) parts = parts.slice(k + 1);
  else if (!KIRO_IMPORT_TOPS.includes(parts[0]) && KIRO_IMPORT_TOPS.includes(parts[1])) parts = parts.slice(1);
  if (!KIRO_IMPORT_TOPS.includes(parts[0]) || parts.length < 2 || parts.some((x) => /^(settings|sessions|logs)$/i.test(x) || /mcp\.json$/i.test(x))) return null;
  return parts.join('/');
}

async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function KiroImport({ onClose, onDone }) {
  const { project } = useProject();
  const { user } = useApp();
  const { toast } = useUi();
  const [source, setSource] = useState(user.is_admin ? 'home' : 'folder');
  const [payload, setPayload] = useState(null);
  const [preview, setPreview] = useState(null);
  const [choices, setChoices] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async (body) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/projects/${project.id}/kiro-agents/import`, body);
      setPayload(body);
      setPreview(res);
      setChoices(Object.fromEntries(res.agents.map((a) => [a.name, a.conflict ? 'skip' : 'import'])));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const pickFolder = async (fileList) => {
    const files = [];
    for (const f of fileList) {
      const rel = kiroUploadPath(f.webkitRelativePath || f.name);
      if (rel) files.push({ path: rel, content: await toBase64(f) });
    }
    if (!files.length) return setError(new Error('That folder has no Kiro agents: choose a .kiro folder (or one with an agents folder inside).'));
    load({ files });
  };
  const pickZip = async (file) => file && load({ zip: await toBase64(file) });
  const confirmImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/projects/${project.id}/kiro-agents/import`, { ...payload, choices });
      toast(res.imported.length ? `Imported ${res.imported.join(', ')}` : 'Nothing was imported');
      onDone();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal title="Import Kiro agents" onClose={onClose} wide>
      {!preview ? (
        <div className="stack">
          <p className="muted small">
            Copies each agent with its prompt and the skills and steering it loads into this project’s .kiro folder, rewriting ~/.kiro paths to the project. Settings, sessions, logs, mcp.json and MCP
            credentials are never copied.
          </p>
          <Segmented
            value={source}
            onChange={setSource}
            label="Import from"
            options={[...(user.is_admin ? [{ value: 'home', label: '~/.kiro on the server' }] : []), { value: 'folder', label: 'A folder' }, { value: 'zip', label: 'A zip' }]}
          />
          {source === 'home' ? (
            <Button variant="primary" busy={busy} onClick={() => load({ source: 'home' })}>
              Look in ~/.kiro
            </Button>
          ) : source === 'folder' ? (
            <Field label="Folder" hint="Your .kiro folder, or any folder with an agents folder inside.">
              {(id) => <input id={id} type="file" webkitdirectory="" multiple disabled={busy} onChange={(e) => pickFolder(e.target.files)} />}
            </Field>
          ) : (
            <Field label="Zip" hint="A zip of a .kiro folder.">
              {(id) => <input id={id} type="file" accept=".zip,application/zip" disabled={busy} onChange={(e) => pickZip(e.target.files[0])} />}
            </Field>
          )}
          <ErrorNote error={error} />
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">
            {preview.agents.length} agent{preview.agents.length === 1 ? '' : 's'} in {preview.source}.
          </p>
          <ul className="stack" style={{ gap: '0.5rem' }}>
            {preview.agents.map((a) => (
              <li key={a.name} className="panel stack" style={{ gap: '0.3rem' }}>
                <div className="row between wrap">
                  <strong className="mono">{a.name}</strong>
                  <select className="input input-sm" value={choices[a.name]} onChange={(e) => setChoices({ ...choices, [a.name]: e.target.value })} aria-label={`What to do with ${a.name}`}>
                    <option value="import">{a.conflict ? 'Replace the existing one' : 'Import'}</option>
                    {a.conflict ? <option value="rename">Import under a new name</option> : null}
                    <option value="skip">Skip</option>
                  </select>
                </div>
                {a.description ? <span className="muted small">{a.description}</span> : null}
                {a.conflict ? <span className="small">The project already has an agent called {a.name}.</span> : null}
                {a.team.length ? <span className="small">Team: {a.team.join(', ')}</span> : null}
                {a.files.length ? <span className="muted small">Copies {a.files.join(', ')}</span> : null}
                {a.missing.length ? <span className="small" style={{ color: 'var(--warn)' }}>Not found: {a.missing.join(', ')}</span> : null}
                {a.skipped.length ? <span className="small" style={{ color: 'var(--warn)' }}>Left out (outside .kiro or private): {a.skipped.join(', ')}</span> : null}
                {a.dropped.length ? <span className="muted small">Removed: {a.dropped.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
          <ErrorNote error={error} />
          <div className="row">
            <Button variant="primary" busy={busy} disabled={!Object.values(choices).some((c) => c !== 'skip')} onClick={confirmImport}>
              Import
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
