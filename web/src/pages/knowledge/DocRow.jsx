import { useState } from 'react';
import { api } from '../../lib/api.js';
import { go, href } from '../../lib/router.js';
import { cx, timeAgo } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';
import { Badge, Button, IconButton, Modal } from '../../components/ui.jsx';

/* --- Single document row --- */
export function DocRow({ doc: d, project, repoList, repoName, canEdit, showPath, currentFolder, selected, onToggleSelect, onDragStart, onMoveDoc, onRenameDoc, onSetRepo, onDelete }) {
  return (
    <tr
      className={cx('doc-row', selected && 'is-selected')}
      draggable={canEdit && d.kind === 'upload'}
      onDragStart={canEdit ? (e) => onDragStart(e) : undefined}
    >
      {canEdit ? (
        <td>
          {d.kind === 'upload' ? (
            <input
              type="checkbox"
              aria-label={`Select ${d.name}`}
              checked={selected}
              onChange={onToggleSelect}
            />
          ) : <span />}
        </td>
      ) : null}
      <td>
        <a href={href(project.id, 'knowledge', 'doc', d.id)} className="strong-link">
          {d.name}
        </a>
        {d.kind === 'decisions' ? <span className="muted small"> built in</span> : null}
        {d.kind === 'upload' && showPath && (d.folder || '') !== currentFolder ? <div className="muted small mono">{d.folder || 'root'}</div> : null}
        {d.error ? <div className="danger small">{d.error}</div> : null}
      </td>
      <td className="muted">{d.kind === 'decisions' ? 'Log' : TYPE_LABEL[d.mime] || d.mime}{d.size ? `, ${bytes(d.size)}` : ''}</td>
      {repoList.length ? (
        <td>
          {d.kind !== 'upload' ? (
            <span className="muted">—</span>
          ) : canEdit ? (
            <button type="button" className="linkish small" onClick={() => onSetRepo(d)}>
              {repoName(d.repo_id) || <span className="muted">None</span>}
            </button>
          ) : (
            <span className="muted">{repoName(d.repo_id) || '—'}</span>
          )}
        </td>
      ) : null}
      <td className="num">{d.sections_count}</td>
      <td><Badge status={d.status} /></td>
      <td className="muted">{timeAgo(d.updated_at)}</td>
      <td className="actions">
        {d.kind === 'upload' ? (
          <>
            <a className="icon-btn" href={`/api/documents/${d.id}/original`} aria-label={`Download ${d.name}`} title="Download original">
              <Icon name="download" size={17} />
            </a>
            {canEdit ? (
              <>
                <IconButton icon="knowledge" label={`Move ${d.name}`} onClick={() => onMoveDoc(d)} title="Move to folder" />
                <IconButton icon="edit" label={`Rename ${d.name}`} onClick={() => onRenameDoc(d)} />
                <IconButton icon="trash" label={`Delete ${d.name}`} onClick={() => onDelete(d)} />
              </>
            ) : null}
          </>
        ) : null}
      </td>
    </tr>
  );
}

export function RenameDocModal({ doc, onDone, onClose }) {
  const [name, setName] = useState(doc.name);
  return (
    <Modal title="Rename document" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim() || name.trim() === doc.name} onClick={() => onDone(name.trim())}>Rename</Button>
      </>
    }>
      <div className="field">
        <label className="field-label" htmlFor="rename-doc-input">New name</label>
        <input id="rename-doc-input" className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onDone(name.trim()); }} autoFocus />
      </div>
    </Modal>
  );
}

export function SetRepoModal({ doc, repoList, project: _project, onDone, onClose }) {
  const [repoId, setRepoId] = useState(doc.repo_id || '');
  return (
    <Modal title={`Repository for "${doc.name}"`} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onDone(repoId)}>Save</Button>
      </>
    }>
      <div className="field">
        <label className="field-label" htmlFor="set-repo-select">Repository</label>
        <select id="set-repo-select" className="input" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
          <option value="">None</option>
          {repoList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
    </Modal>
  );
}
