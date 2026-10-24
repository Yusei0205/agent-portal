import { useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { saveFromApi } from '../lib/download.js';
import { useLoad } from '../lib/useAsync.js';
import { bytes, dateTime, plural, timeAgo } from '../lib/util.js';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, PageHeader, Spinner, useUi } from '../components/ui.jsx';

const KIND_LABEL = { pptx: 'PowerPoint', docx: 'Word' };
const ACCEPT = '.pptx,.potx,.docx,.dotx';

/** @param {string | null} projectId */
const baseOf = (projectId) => (projectId ? `/api/projects/${encodeURIComponent(projectId)}/templates` : '/api/templates');

/** Where the template that applies comes from, in words. */
function sourceWords(t) {
  return t.scope === 'portal' ? 'the portal default' : "this project's default";
}

/** The one-line answer to "which template do my files follow?" for one kind. */
function Winner({ kind, eff }) {
  return (
    <li>
      <strong>{KIND_LABEL[kind]}:</strong>{' '}
      {eff ? (
        <>
          <span className="tpl-winner">{eff.name}</span> <span className="muted">({sourceWords(eff)})</span>
        </>
      ) : (
        <span className="muted">built-in look (no template uploaded yet)</span>
      )}
    </li>
  );
}

/** Layout details of a PowerPoint template; Word templates have no layout details to show. */
function TemplateDetails({ t }) {
  const info = t.info || {};
  const who = (
    <>
      Uploaded {t.uploaded_by_name ? `by ${t.uploaded_by_name} ` : ''}
      <span title={dateTime(t.created_at)}>{timeAgo(t.created_at)}</span>.
    </>
  );
  if (t.kind === 'docx') {
    return (
      <p className="muted small">
        A Word template. Generated documents follow its fonts, colours, header and footer; styles it lacks are filled in from the built-in look. {who}
      </p>
    );
  }
  const roles = Object.entries(info.mapping || {});
  return (
    <div className="stack tpl-details">
      <div className="muted small">
        {info.slideWidthIn && info.slideHeightIn ? `Slide size ${info.slideWidthIn} × ${info.slideHeightIn} in. ` : ''}
        {info.fonts ? `Fonts: ${info.fonts.major} (headings), ${info.fonts.minor} (text). ` : ''}
        {who}
      </div>
      {roles.length ? (
        <dl className="kv tpl-roles" aria-label="Layout for each role">
          {roles.map(([role, layout]) => (
            <div key={role}>
              <dt>{role}</dt>
              <dd>{layout || <span className="muted">none, a fallback is used</span>}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {info.layouts?.length ? (
        <p className="small">
          <strong>Layouts:</strong> {info.layouts.map((l) => l.name).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Upload, list and manage templates. Without `portal` it manages the current project's templates (and shows the portal
 * ones it can use); with `portal` it manages the portal-wide defaults (the server allows admins only).
 */
export function Templates({ portal = false }) {
  const project = useProject();
  const projectId = portal ? null : project.project.id;
  const canEdit = portal ? true : project.canEdit;
  const { toast, confirm } = useUi();
  const base = baseOf(projectId);
  const list = useLoad(() => api.get(base), [base]);
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(null);
  const templates = list.data?.templates || [];
  const eff = list.data?.effective;
  const baseFor = (t) => baseOf(t.scope === 'portal' ? null : projectId);

  const act = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  const toggleDefault = (t) =>
    act(`default-${t.id}`, async () => {
      await api.patch(`${baseFor(t)}/${t.id}`, { isDefault: !t.is_default });
      toast(t.is_default ? 'Default cleared' : `${t.name} is now the default`);
      await list.reload(true);
    });
  const remove = async (t) => {
    const ok = await confirm({
      title: 'Delete this template?',
      message: `"${t.name}" will be deleted. Decks already made keep their look; new ones use ${t.is_default ? 'the next template that applies, or the built-in look' : 'the template that applies now'}.`,
      confirmLabel: 'Delete template',
      danger: true,
    });
    if (!ok) return;
    await act(`delete-${t.id}`, async () => {
      await api.del(`${baseFor(t)}/${t.id}`);
      toast('Template deleted');
      await list.reload(true);
    });
  };
  const download = (t) => act(`download-${t.id}`, () => saveFromApi(`${baseFor(t)}/${t.id}/download`, t.filename));

  const uploadButton = (
    <Button variant="primary" icon="upload" onClick={() => setUploading(true)}>
      Upload template
    </Button>
  );
  const actions = canEdit ? uploadButton : null;
  const sub = portal
    ? 'The default every project falls back to when it has no template of its own.'
    : 'Word and PowerPoint templates that generated files follow. A project default beats the portal default, which beats the built-in look.';

  return (
    <div className="stack" data-testid="templates">
      {portal ? (
        <div className="row between wrap">
          <div>
            <h2>Templates</h2>
            <p className="muted small">{sub}</p>
          </div>
          {actions}
        </div>
      ) : (
        <PageHeader title="Templates" sub={sub} actions={actions} />
      )}
      {list.error && !list.data ? <ErrorNote error={list.error} /> : null}
      {list.loading && !list.data ? <Spinner /> : null}
      {list.data ? (
        <>
          <Note tone="info" icon="file">
            <strong>Which template wins:</strong> {portal ? "a project's own default" : "this project's default"}, then the portal default, then the built-in look.
            <ul className="tpl-winners">
              <Winner kind="pptx" eff={eff?.pptx} />
              <Winner kind="docx" eff={eff?.docx} />
            </ul>
          </Note>
          {!templates.length ? (
            <Empty icon="file" title="No templates yet" action={canEdit ? uploadButton : null}>
              {canEdit
                ? `Upload a PowerPoint (.pptx, .potx) or Word (.docx, .dotx) file with your brand's fonts, colours and logo. The first one of each kind becomes the default, and new decks and documents follow it. Files up to ${bytes(list.data.limits.bytes)}; files with macros are refused.`
                : portal
                  ? 'No portal template has been uploaded yet.'
                  : 'No template has been uploaded yet. Editors can upload one for this project.'}
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Templates">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Scope</th>
                    <th>Size</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => {
                    // In a project, portal templates can be used and downloaded but only changed in Settings.
                    const editable = canEdit && (t.scope === 'portal' ? portal : true);
                    const warnings = t.info?.warnings || [];
                    return (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.name}</strong>
                          <div className="muted small">
                            {t.filename}
                            {t.info?.layouts?.length ? ` · ${plural(t.info.layouts.length, 'layout')}` : ''}
                          </div>
                          {warnings.length ? (
                            <ul className="tpl-warnings small" aria-label={`Warnings for ${t.name}`}>
                              {warnings.map((w) => (
                                <li key={w}>{w}</li>
                              ))}
                            </ul>
                          ) : null}
                          <Button size="sm" variant="ghost" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                            {open === t.id ? 'Hide details' : 'Layout details'}
                          </Button>
                          {open === t.id ? <TemplateDetails t={t} /> : null}
                        </td>
                        <td>{KIND_LABEL[t.kind]}</td>
                        <td>{t.scope === 'portal' ? 'Portal' : 'This project'}</td>
                        <td>{bytes(t.size)}</td>
                        <td>
                          <span className="row tight wrap">
                            {t.is_default ? <Badge tone="accent">Default</Badge> : null}
                            {t.effective ? <Badge tone="ok">In use</Badge> : null}
                            {!t.is_default && !t.effective ? <span className="muted small">-</span> : null}
                          </span>
                        </td>
                        <td>
                          <span className="row tight wrap">
                            <Button size="sm" icon="download" busy={busy === `download-${t.id}`} onClick={() => download(t)} aria-label={`Download ${t.name}`}>
                              Download
                            </Button>
                            {editable ? (
                              <>
                                <Button size="sm" busy={busy === `default-${t.id}`} onClick={() => toggleDefault(t)} aria-label={`${t.is_default ? 'Unset' : 'Set'} ${t.name} as default`}>
                                  {t.is_default ? 'Unset default' : 'Set as default'}
                                </Button>
                                <Button size="sm" icon="edit" onClick={() => setRenaming(t)} aria-label={`Rename ${t.name}`}>
                                  Rename
                                </Button>
                                <Button size="sm" variant="danger" icon="trash" busy={busy === `delete-${t.id}`} onClick={() => remove(t)} aria-label={`Delete ${t.name}`}>
                                  Delete
                                </Button>
                              </>
                            ) : t.scope === 'portal' && !portal ? (
                              <span className="muted small">Managed in Settings</span>
                            ) : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      {uploading ? (
        <UploadTemplate
          base={base}
          limits={list.data?.limits}
          onClose={() => setUploading(false)}
          onDone={(name) => {
            setUploading(false);
            toast(`${name} uploaded`);
            list.reload(true);
          }}
        />
      ) : null}
      {renaming ? (
        <RenameTemplate
          template={renaming}
          base={baseFor(renaming)}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            toast('Renamed');
            list.reload(true);
          }}
        />
      ) : null}
    </div>
  );
}

function UploadTemplate({ base, limits, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) {
      setError(new Error('Choose a file first.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ filename: file.name });
      if (name.trim()) q.set('name', name.trim());
      if (makeDefault) q.set('default', '1');
      // A raw-body upload: api.postRaw sends the file as is, with the x-requested-with header every change needs.
      const r = await api.postRaw(`${base}?${q}`, file);
      onDone(r.template?.name || file.name);
    } catch (err) {
      // The server explains a refusal in plain words (a macro, the wrong kind of file, too big); show it as it is.
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Upload template"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="upload-template-form" busy={busy}>
            Upload
          </Button>
        </>
      }
    >
      <form id="upload-template-form" className="stack" onSubmit={submit} noValidate>
        <Field label="Template file" hint={`PowerPoint (.pptx, .potx) or Word (.docx, .dotx), up to ${bytes(limits?.bytes || 25 * 1024 * 1024)}. Files with macros are refused.`}>
          {(id) => (
            <input
              id={id}
              type="file"
              className="input"
              accept={ACCEPT}
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                setError(null);
              }}
            />
          )}
        </Field>
        <Field label="Name (optional)" hint="Leave empty to use the file name.">
          {(id) => <input id={id} className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <label className="choice">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          <span>Make it the default for its kind (the first one of a kind always is).</span>
        </label>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}

function RenameTemplate({ template, base, onClose, onDone }) {
  const [name, setName] = useState(template.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base}/${template.id}`, { name: name.trim() });
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Rename template"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename-template-form" busy={busy} disabled={!name.trim()}>
            Rename
          </Button>
        </>
      }
    >
      <form id="rename-template-form" className="stack" onSubmit={submit} noValidate>
        <Field label="Name">{(id) => <input id={id} className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}
