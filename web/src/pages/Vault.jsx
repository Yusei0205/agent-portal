import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Button, ErrorNote, Field, Modal, Note, PageHeader, Progress, Segmented, Spinner, useUi } from '../components/ui.jsx';

const SCOPES = [
  { value: 'project', label: 'Project vault', hint: 'For this project only: its members can see these, editors can change them. Every run in the project gets a copy under vault/project.' },
  { value: 'mine', label: 'My vault', hint: 'Only you can see these. Every run you start, in any project, gets a copy in its folder under vault/mine.' },
  { value: 'team', label: 'Team vault', hint: 'Everyone can see and change these. Every run in every project gets a copy in its folder under vault/team.' },
];

const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Vault: files uploaded once and given to every run. Opened from a project, it starts on that project's vault; on
 * the portal page you pick which project's vault to show.
 */
export function Vault({ projectId: fixedProject = null }) {
  const { toast, confirm } = useUi();
  // The project list is null until it has loaded.
  const projects = useApp()?.projects || [];
  const [scope, setScope] = useState(fixedProject ? 'project' : 'mine');
  const [pickedProject, setPickedProject] = useState(fixedProject || '');
  const pid = fixedProject || pickedProject || projects[0]?.id || '';
  const q = scope === 'project' ? `scope=project&projectId=${encodeURIComponent(pid)}` : `scope=${scope}`;
  const projectName = projects.find((p) => p.id === pid)?.name || 'project';
  const vaultName = scope === 'project' ? `${projectName} vault` : scope === 'team' ? 'team vault' : 'vault';
  const list = useLoad(() => (scope === 'project' && !pid ? Promise.resolve({ files: [], used: 0, limit: 1 }) : api.get(`/api/vault?${q}`)), [q]);
  const [busy, setBusy] = useState('');
  const [drag, setDrag] = useState(false);
  const [folder, setFolder] = useState(false);
  const filesInput = useRef(null);
  const folderInput = useRef(null);
  const info = SCOPES.find((s) => s.value === scope);
  const files = list.data?.files || [];

  const upload = async (items) => {
    const all = [...items];
    if (!all.length) return;
    setBusy(`Uploading 0 of ${all.length}…`);
    let done = 0;
    try {
      for (const file of all) {
        const p = file.webkitRelativePath || file.relPath || file.name;
        await api.upload(`/api/vault/file?${q}&path=${encodeURIComponent(p)}`, file);
        setBusy(`Uploading ${++done} of ${all.length}…`);
      }
      toast(`Uploaded ${done} file${done === 1 ? '' : 's'}`);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
      list.reload(true);
    }
  };
  // Dropped folders: walk them so their structure is kept.
  const fromDrop = async (dt) => {
    const out = [];
    const walk = (entry, prefix) =>
      new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((f) => {
            f.relPath = prefix + f.name;
            out.push(f);
            resolve();
          }, resolve);
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const read = () =>
            reader.readEntries(async (entries) => {
              if (!entries.length) return resolve();
              for (const e of entries) await walk(e, `${prefix}${entry.name}/`);
              read();
            }, resolve);
          read();
        } else resolve();
      });
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const e of entries) await walk(e, '');
    else out.push(...dt.files);
    upload(out);
  };
  const remove = async (p, dir) => {
    if (!(await confirm({ title: 'Delete', message: `Delete ${p}${dir ? ' and everything in it' : ''} from the ${vaultName}?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/vault/file?${q}&path=${encodeURIComponent(p)}`);
      list.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  return (
    <div className="page">
      <PageHeader title="Vault" sub="Files you upload once and use in every run: documents, templates, test data, evidence. Agents can read everything in the vaults their run gets, so keep secrets you would not show an agent out of them." />
      <div className="row tight wrap">
        <Segmented value={scope} onChange={setScope} label="Vault" options={SCOPES.map(({ value, label }) => ({ value, label }))} />
        {scope === 'project' && !fixedProject ? (
          <label className="row tight small">
            <span className="field-label" style={{ marginBottom: 0 }}>Project</span>
            <select className="input input-sm" value={pid} onChange={(e) => setPickedProject(e.target.value)} aria-label="Project whose vault to show">
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p className="muted small">{info.hint}</p>
      <div
        className={cx('panel stack vault-drop', drag && 'is-over')}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          fromDrop(e.dataTransfer);
        }}
      >
        <div className="row tight wrap">
          <Button icon="upload" onClick={() => filesInput.current?.click()} disabled={Boolean(busy)}>
            Upload files
          </Button>
          <Button icon="upload" onClick={() => folderInput.current?.click()} disabled={Boolean(busy)}>
            Upload folder
          </Button>
          <Button icon="plus" onClick={() => setFolder(true)}>
            New folder
          </Button>
          {files.some((f) => !f.dir) ? (
            <a className="btn btn-default" href={`/api/vault/zip?${q}`} download>
              <Icon name="download" size={15} />
              <span>Download all</span>
            </a>
          ) : null}
          <input ref={filesInput} type="file" multiple hidden aria-label="Files to upload" onChange={(e) => upload(e.target.files)} />
          <input ref={folderInput} type="file" multiple hidden webkitdirectory="" directory="" aria-label="Folder to upload" onChange={(e) => upload(e.target.files)} />
        </div>
        {busy ? <p className="small">{busy}</p> : <p className="muted small">Drag files or folders here, or use the buttons. Up to 100 MB per file.</p>}
        {list.data ? (
          <div className="vault-usage">
            <span className="muted small">
              {size(list.data.used)} of {size(list.data.limit)} used
            </span>
            <Progress value={(list.data.used / list.data.limit) * 100} label="Vault space used" />
          </div>
        ) : null}
        {list.loading && !list.data ? (
          <Spinner />
        ) : list.error ? (
          <ErrorNote error={list.error} />
        ) : !files.length ? (
          <p className="muted">The {vaultName} is empty.</p>
        ) : (
          <ul className="cfg-files vault-files">
            {files.map((f) => (
              <li key={f.path} className={cx('cfg-file', f.dir && 'is-dir')} style={{ paddingLeft: 6 + (f.path.split('/').length - 1) * 14 }}>
                <span className="cfg-name">
                  <Icon name={f.dir ? 'projects' : 'file'} size={14} /> {f.path.split('/').pop()}
                </span>
                {!f.dir ? (
                  <span className="muted small vault-meta">
                    {size(f.size)} · {timeAgo(f.modified)}
                  </span>
                ) : null}
                {!f.dir ? (
                  <a className="icon-btn" href={`/api/vault/download?${q}&path=${encodeURIComponent(f.path)}`} download aria-label={`Download ${f.path}`} title="Download">
                    <Icon name="download" size={13} />
                  </a>
                ) : null}
                <button type="button" className="icon-btn cfg-del" aria-label={`Delete ${f.path}`} title="Delete" onClick={() => remove(f.path, f.dir)}>
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Note tone="info" icon="lock">
        Each run gets its own copy, so agents can read and even change their copy without touching the vault.
      </Note>
      {folder ? <NewFolder q={q} onClose={() => setFolder(false)} onDone={() => list.reload(true)} /> : null}
    </div>
  );
}

function NewFolder({ q, onClose, onDone }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const create = async () => {
    setBusy(true);
    try {
      await api.post(`/api/vault/folder?${q}`, { path: name });
      onDone();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New folder"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Folder" hint="Use / for folders inside folders, like templates/word.">{(id) => <input id={id} className="input mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
