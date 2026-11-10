/**
 * RunOutputsCard — card shown in the chat feed right after a run completes or fails.
 *
 * Lists the output files produced by that run, with:
 *  - File-type icon or image thumbnail
 *  - Labelled Preview and Download buttons
 *  - "Show all N" when more than 4 files
 *  - Footer: Download all (ZIP) and Open in Vault
 */

import { useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import { navigate } from '../../lib/router.js';
import { formatBytes, getFileTypeMeta, isImageFile } from '../../lib/outputFileUtils.js';

const MAX_COLLAPSED = 4;

// ── Internal helpers ──────────────────────────────────────────────────────────

function downloadFile(file) {
  const a = document.createElement('a');
  a.href = file.download_url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── File row ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   file: object,
 *   onPreview: (file: object) => void,
 * }} props
 */
function FileRow({ file, onPreview }) {
  const isImg = isImageFile(file);
  const { icon, label } = getFileTypeMeta(file.mime_type, file.name);

  return (
    <li className="run-outputs-card-item">
      {/* Thumbnail (images) or file-type badge (everything else) */}
      {isImg ? (
        <button
          type="button"
          className="run-outputs-card-thumb-btn"
          onClick={() => onPreview(file)}
          aria-label={`Open preview of ${file.name}`}
          tabIndex={-1}
          aria-hidden="true"
        >
          <img
            src={`${file.download_url}?inline=1`}
            alt={`Thumbnail for ${file.name}`}
            className="run-outputs-card-thumb"
            loading="lazy"
          />
        </button>
      ) : (
        <span className="run-outputs-card-type-badge" aria-hidden="true">
          <Icon name={icon} size={14} />
          <span className="run-outputs-card-type-label">{label}</span>
        </span>
      )}

      {/* File info */}
      <div className="run-outputs-card-item-info">
        <span className="run-outputs-card-item-name" title={file.path}>
          {file.name}
          {file.version > 1 && (
            <span className="ide-outputs-version" aria-label={`Version ${file.version}`}>
              v{file.version}
            </span>
          )}
        </span>
        <span className="run-outputs-card-item-meta muted">{formatBytes(file.size_bytes)}</span>
      </div>

      {/* Actions */}
      <div className="run-outputs-card-item-actions">
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
      </div>
    </li>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {{
 *   files: Array<{id: string, name: string, path: string, size_bytes: number,
 *                  mime_type: string, version: number, run_id: string | null,
 *                  download_url: string, preview_url: string, vault_file_id: string | null}>,
 *   workflowId: string,
 *   projectId: string,
 *   vaultFolder: string | null,
 *   onPreview: (file: object, files: Array<object>) => void,
 * }} props
 */
export function RunOutputsCard({ files, workflowId, projectId, vaultFolder, onPreview }) {
  const [showAll, setShowAll] = useState(false);

  if (!files?.length) return null;

  const displayFiles = showAll ? files : files.slice(0, MAX_COLLAPSED);
  const hiddenCount  = files.length - MAX_COLLAPSED;

  const handleDownloadAll = () => {
    window.open(`/api/workflows/${encodeURIComponent(workflowId)}/output-files/zip`, '_blank');
  };

  const handleOpenVault = () => {
    if (!projectId || !vaultFolder) return;
    navigate(`/p/${encodeURIComponent(projectId)}/vault?folder=${encodeURIComponent(vaultFolder)}`);
  };

  return (
    <div
      className="run-outputs-card"
      role="region"
      aria-label={`${files.length} output file${files.length !== 1 ? 's' : ''} created`}
    >
      {/* Header */}
      <div className="run-outputs-card-header">
        <Icon name="file" size={13} aria-hidden="true" />
        <span>
          {files.length} output file{files.length !== 1 ? 's' : ''} created
        </span>
      </div>

      {/* File list */}
      <ul className="run-outputs-card-list" role="list" aria-label="Output files">
        {displayFiles.map((file) => (
          <FileRow
            key={file.id}
            file={file}
            onPreview={(f) => onPreview(f, files)}
          />
        ))}
      </ul>

      {/* Show all */}
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          className="run-outputs-card-show-more btn btn-sm btn-ghost"
          onClick={() => setShowAll(true)}
          aria-label={`Show all ${files.length} output files`}
        >
          Show all {files.length} files
        </button>
      )}

      {/* Footer */}
      <div className="run-outputs-card-footer">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={handleDownloadAll}
          aria-label="Download all output files as ZIP"
        >
          <Icon name="zip-download" size={12} aria-hidden="true" />
          Download all
        </button>
        {vaultFolder && projectId && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleOpenVault}
            aria-label={`Open vault folder: ${vaultFolder}`}
          >
            <Icon name="archive" size={12} aria-hidden="true" />
            Open in Vault
          </button>
        )}
      </div>
    </div>
  );
}
