/**
 * IdeOutputs — sidebar panel listing session output files.
 *
 * Shows every artifact the agent produced during a session run.
 * Each row has a thumbnail (for images) or type icon, plus labelled
 * Preview, Download, and "Open in Vault" actions.
 * The header has "Download all" (zip) and "Open Vault folder" buttons.
 */

import { Icon } from '../../components/Icon.jsx';
import { formatRelative } from '../../lib/util.js';
import { navigate } from '../../lib/router.js';
import { formatBytes, getFileTypeMeta, isImageFile } from '../../lib/outputFileUtils.js';
import { AddToVaultButton } from './AddToVaultButton.jsx';

/** Returns the folder portion of a file's relative path (everything before the last segment). */
function shortFolder(path) {
  if (!path) return '';
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   outputFiles: Array<{id: string, name: string, path: string, size_bytes: number,
 *                       mime_type: string, version: number, created_at: string,
 *                       run_id: string | null, vault_file_id: string | null,
 *                       download_url: string, preview_url: string}>,
 *   loading: boolean,
 *   workflowId: string,
 *   projectId: string,
 *   vaultFolder: string | null,
 *   onPreview: (file: object) => void,
 * }} props
 */
export function IdeOutputs({ outputFiles = [], loading, workflowId, projectId, vaultFolder, onPreview }) {
  const hasFiles = outputFiles.length > 0;

  const downloadAll = () => {
    window.open(`/api/workflows/${encodeURIComponent(workflowId)}/output-files/zip`, '_blank');
  };

  const openVaultFolder = () => {
    if (!projectId || !vaultFolder) return;
    navigate(`/p/${encodeURIComponent(projectId)}/vault?folder=${encodeURIComponent(vaultFolder)}`);
  };

  const downloadFile = (file) => {
    const a = document.createElement('a');
    a.href = file.download_url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const openInVault = (file) => {
    if (!projectId || !file.vault_file_id) return;
    const folder = vaultFolder || shortFolder(file.path) || null;
    const qs = folder ? `?folder=${encodeURIComponent(folder)}` : '';
    navigate(`/p/${encodeURIComponent(projectId)}/vault${qs}`);
  };

  return (
    <div className="ide-outputs" aria-label="Session output files">
      {/* Panel actions row */}
      <div className="ide-outputs-actions">
        {hasFiles && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={downloadAll}
              aria-label="Download all outputs as ZIP"
              title="Download all as ZIP"
            >
              <Icon name="zip-download" size={13} />
              Download all
            </button>
            {vaultFolder && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={openVaultFolder}
                aria-label={`Open vault folder: ${vaultFolder}`}
                title="Open vault folder"
              >
                <Icon name="archive" size={13} />
                Vault folder
              </button>
            )}
          </>
        )}
      </div>

      {/* Empty / loading states */}
      {loading && !hasFiles && (
        <div className="ide-outputs-empty">
          <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading outputs…" />
        </div>
      )}

      {!loading && !hasFiles && (
        <div className="ide-outputs-empty">
          <Icon name="file" size={24} />
          <p>Output files appear here after the agent creates documents, images, or other artifacts.</p>
        </div>
      )}

      {hasFiles && (
        <ul className="ide-outputs-list" role="list" aria-label="Output files">
          {outputFiles.map((file) => {
            const folder = shortFolder(file.path);
            const isImg  = isImageFile(file);
            const { icon, label } = getFileTypeMeta(file.mime_type, file.name);

            return (
              <li key={file.id} className="ide-outputs-item">
                {/* Leading icon/thumbnail */}
                {isImg ? (
                  <button
                    type="button"
                    className="ide-outputs-thumb-btn"
                    onClick={() => onPreview(file)}
                    aria-label={`Open preview of ${file.name}`}
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    <img
                      src={`${file.download_url}?inline=1`}
                      alt=""
                      className="ide-outputs-thumb"
                      loading="lazy"
                    />
                  </button>
                ) : (
                  <span className="ide-outputs-type-badge" aria-label={label} aria-hidden="true">
                    <Icon name={icon} size={14} />
                    <span className="ide-outputs-type-label">{label}</span>
                  </span>
                )}

                {/* File info + actions */}
                <div className="ide-outputs-item-main">
                  <div className="ide-outputs-item-name" title={file.path}>
                    {file.name}
                    {file.version > 1 && (
                      <span className="ide-outputs-version" aria-label={`Version ${file.version}`}>
                        v{file.version}
                      </span>
                    )}
                  </div>
                  {folder && (
                    <div className="ide-outputs-item-folder muted" title={folder}>{folder}</div>
                  )}
                  <div className="ide-outputs-item-meta muted">
                    <span>{formatBytes(file.size_bytes)}</span>
                    <span>·</span>
                    <span>{formatRelative(file.created_at)}</span>
                  </div>
                  <div className="ide-outputs-item-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => onPreview(file)}
                      aria-label={`Preview ${file.name}`}
                    >
                      <Icon name="eye" size={12} aria-hidden="true" />
                      Preview
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => downloadFile(file)}
                      aria-label={`Download ${file.name}`}
                    >
                      <Icon name="download" size={12} aria-hidden="true" />
                      Download
                    </button>
                    <AddToVaultButton workflowId={workflowId} file={file} />
                    {file.vault_file_id && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => openInVault(file)}
                        aria-label={`Open ${file.name} in Vault`}
                      >
                        <Icon name="archive" size={12} aria-hidden="true" />
                        Vault
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
