import { Icon } from './Icon.jsx';

/**
 * Workspace panel header bar.
 *
 * @param {{
 *   title: string,
 *   status?: string,
 *   engine?: 'kiro' | 'claude' | string,
 *   project?: string,
 *   onEdit?: () => void,
 *   meta?: string,
 * }} props
 */
export function WorkspaceHeader({ title, status, engine, project, onEdit, meta }) {
  return (
    <div className="ws-header">
      {status && (
        <span
          className={`dot ${
            status === 'running'
              ? 'dot-running'
              : status === 'failed'
              ? 'dot-failed'
              : status === 'pending'
              ? 'dot-pending'
              : 'dot-stopped'
          }`}
          title={status}
        />
      )}
      <span className="ws-header-title" title={title}>
        {title}
      </span>
      {engine && (
        <span
          className={
            engine === 'kiro' ? 'badge badge-engine-kiro' : 'badge badge-engine-claude'
          }
        >
          {engine === 'kiro' ? 'Kiro' : engine === 'claude' ? 'Claude' : engine}
        </span>
      )}
      {project && (
        <span className="badge" title="Project">
          {project}
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          className="btn-icon"
          onClick={onEdit}
          aria-label="Edit"
        >
          <Icon name="edit" size={14} />
        </button>
      )}
      {meta && <span className="ws-header-meta">{meta}</span>}
    </div>
  );
}
