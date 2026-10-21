import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { useLoad } from '../lib/useAsync.js';
import { cx } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Button, ErrorNote, Field, Modal, PageHeader, Segmented, Spinner, useUi } from '../components/ui.jsx';

const ROOTS = [
  { value: '.claude', label: 'Claude Code (.claude)', hint: 'Agents (agents/*.md), skills (skills/*/SKILL.md), commands and settings that Claude Code loads in this project’s runs.' },
  { value: '.kiro', label: 'Kiro (.kiro)', hint: 'Steering, prompts and settings that kiro-cli loads in this project’s runs. Each run also writes its own agent profiles here; those are hidden.' },
];

/** Configuration: the project's .claude and .kiro folders as files, edited directly. Every save is committed. */
export function Configuration() {
  const { project, canEdit } = useProject();
  const { toast, confirm } = useUi();
  const [root, setRoot] = useState('.claude');
  const files = useLoad(() => api.get(`/api/projects/${project.id}/config/files?root=${root}`), [project.id, root]);
  useProjectEvents(['builder.updated'], () => files.reload(true));
  const [open, setOpen] = useState(null); // path
  const [creating, setCreating] = useState(null); // 'file' | 'folder'
  const importInput = useRef(null);
  const list = files.data?.files || [];
  const rootInfo = ROOTS.find((r) => r.value === root);

  const doImport = async (file) => {
    if (!file) return;
    try {
      const r = await api.upload(`/api/projects/${project.id}/config/import?root=${encodeURIComponent(root)}`, file);
      toast(`Imported ${r.files.length} file${r.files.length === 1 ? '' : 's'}`);
      files.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const remove = async (p) => {
    if (!(await confirm({ title: 'Delete', message: `Delete ${p}${list.some((x) => x.path.startsWith(`${p}/`)) ? ' and everything in it' : ''}? It stays in the project history.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/projects/${project.id}/config/file?path=${encodeURIComponent(p)}`);
      if (open === p || open?.startsWith(`${p}/`)) setOpen(null);
      files.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  return (
    <div className="page wide">
      <PageHeader
        title="Configuration"
        sub="This project's .claude and .kiro folders, as the engines see them in every run. Changes apply to runs started afterwards, and every save is committed to the project's history."
        actions={
          <>
            {canEdit ? (
              <>
                <Button icon="upload" onClick={() => importInput.current?.click()}>
                  Import zip
                </Button>
                <input ref={importInput} type="file" accept=".zip" hidden aria-label="Zip to import" onChange={(e) => doImport(e.target.files?.[0])} />
              </>
            ) : null}
            <a className="btn btn-default" href={`/api/projects/${project.id}/config/export?root=${encodeURIComponent(root)}`} download>
              <Icon name="download" size={15} />
              <span>Export zip</span>
            </a>
          </>
        }
      />
      <Segmented value={root} onChange={(r) => { setRoot(r); setOpen(null); }} label="Folder" options={ROOTS.map(({ value, label }) => ({ value, label }))} />
      <p className="muted small">{rootInfo.hint} Settings, hooks and MCP configuration can only be changed by admins.</p>
      <div className="cfg-layout">
        <nav className="panel cfg-tree" aria-label={`Files in ${root}`}>
          {canEdit ? (
            <div className="row tight wrap">
              <Button size="sm" icon="plus" onClick={() => setCreating('file')}>
                New file
              </Button>
              <Button size="sm" icon="plus" onClick={() => setCreating('folder')}>
                New folder
              </Button>
            </div>
          ) : null}
          {files.loading && !files.data ? (
            <Spinner />
          ) : files.error ? (
            <ErrorNote error={files.error} />
          ) : !list.length ? (
            <p className="muted small">{root} is empty.</p>
          ) : (
            <ul className="cfg-files">
              {list.map((e) => {
                const depth = e.path.split('/').length - 2;
                const name = e.path.split('/').pop();
                return (
                  <li key={e.path} className={cx('cfg-file', e.dir && 'is-dir', open === e.path && 'is-open')} style={{ paddingLeft: 6 + depth * 14 }}>
                    {e.dir ? (
                      <span className="cfg-name">
                        <Icon name="projects" size={14} /> {name}
                      </span>
                    ) : (
                      <button type="button" className="cfg-name linkish" onClick={() => setOpen(e.path)} aria-current={open === e.path ? 'true' : undefined}>
                        <Icon name="file" size={14} /> {name}
                      </button>
                    )}
                    {e.protected ? <Icon name="lock" size={12} /> : null}
                    {canEdit && (!e.protected || files.data.canChangeProtected) ? (
                      <button type="button" className="icon-btn cfg-del" aria-label={`Delete ${e.path}`} title="Delete" onClick={() => remove(e.path)}>
                        <Icon name="trash" size={13} />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
        <section className="panel cfg-editor">
          {open ? <FileEditor key={open} path={open} canEdit={canEdit} canChangeProtected={files.data?.canChangeProtected} onSaved={() => files.reload(true)} /> : <p className="muted pad-sm">Pick a file on the left, or create one.</p>}
        </section>
      </div>
      {creating ? (
        <NewItem
          kind={creating}
          root={root}
          onClose={() => setCreating(null)}
          onDone={(p) => {
            files.reload(true);
            if (creating === 'file') setOpen(p);
          }}
        />
      ) : null}
    </div>
  );
}

function FileEditor({ path, canEdit, canChangeProtected, onSaved }) {
  const { project } = useProject();
  const { toast } = useUi();
  const file = useLoad(() => api.get(`/api/projects/${project.id}/config/file?path=${encodeURIComponent(path)}`), [path]);
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (file.data && !file.data.binary) setText(file.data.content);
  }, [file.data]);
  const isJson = path.toLowerCase().endsWith('.json');
  const jsonError = useMemo(() => {
    if (!isJson || text === null) return null;
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return e.message;
    }
  }, [isJson, text]);
  if (file.error) return <ErrorNote error={file.error} />;
  if (!file.data) return <Spinner />;
  if (file.data.binary) return <p className="muted pad-sm">This is not a text file, so it cannot be edited here.</p>;
  const locked = !canEdit || (file.data.protected && !canChangeProtected);
  const dirty = text !== null && text !== file.data.content;
  const save = async () => {
    if (locked || jsonError || !dirty) return;
    setBusy(true);
    try {
      await api.put(`/api/projects/${project.id}/config/file`, { path, content: text });
      toast(`Saved ${path}`);
      await file.reload(true);
      onSaved();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack cfg-edit">
      <div className="row between wrap">
        <code className="small">{path}</code>
        <span className="row tight">
          {file.data.protected ? <span className="chip-static small"><Icon name="lock" size={12} /> admins only</span> : null}
          {dirty ? <span className="muted small">unsaved changes</span> : null}
          {!locked ? (
            <Button size="sm" variant="primary" busy={busy} disabled={!dirty || Boolean(jsonError)} onClick={save}>
              Save
            </Button>
          ) : null}
        </span>
      </div>
      <textarea
        className="input mono cfg-text"
        value={text ?? ''}
        readOnly={locked}
        spellCheck={false}
        aria-label={`Contents of ${path}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            save();
          }
        }}
      />
      {jsonError ? <p className="danger small">Not valid JSON yet: {jsonError}</p> : isJson ? <p className="muted small">Valid JSON.</p> : null}
      {locked && canEdit ? <p className="muted small">Only admins can change this file.</p> : null}
    </div>
  );
}

function NewItem({ kind, root, onClose, onDone }) {
  const { project } = useProject();
  const [p, setP] = useState(`${root}/${kind === 'file' ? 'agents/new-agent.md' : 'commands'}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'file') {
        const content = p.endsWith('.md') && p.includes('/agents/') ? `---\nname: ${p.split('/').pop().replace(/\.md$/, '')}\ndescription: What this agent does and when to use it\n---\n\nInstructions for the agent.\n` : p.endsWith('.json') ? '{}\n' : '';
        await api.put(`/api/projects/${project.id}/config/file`, { path: p, content });
      } else {
        await api.post(`/api/projects/${project.id}/config/folder`, { path: p });
      }
      onDone(p);
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={kind === 'file' ? 'New file' : 'New folder'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!p.trim().startsWith(`${root}/`)} onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Path" hint={`Inside ${root}/. Folders in the path are created as needed.`}>{(id) => <input id={id} className="input mono" value={p} onChange={(e) => setP(e.target.value)} autoFocus />}</Field>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
