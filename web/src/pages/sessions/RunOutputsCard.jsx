/**
 * RunOutputsCard — card shown in the chat feed right after a run completes or fails.
 *
 * Lists the output files produced by that run, with:
 *  - File-type icon or image thumbnail
 *  - Labelled Preview and Download buttons
 *  - "Show all N" when more than 4 files
 *  - Footer: Download all (ZIP) and Open in Vault
 */

import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import { navigate } from '../../lib/router.js';
import { formatBytes, getFileTypeMeta, isImageFile, isExcerptable, excerptLines } from '../../lib/outputFileUtils.js';
import { AddToVaultButton } from './AddToVaultButton.jsx';
import { ArtifactHeading } from '../../components/ArtifactCard.jsx';
import { useArtifactReveal } from '../../lib/artifact-reveal.js';

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

// ── Excerpt of the first text or code file ────────────────────────────────────

/** The first lines of a small text or code file, with line numbers and a copy button. Fetched when the card is shown. */
function FileExcerpt({ file, onOpen }) {
  const [state, setState] = useState({ status: 'loading', text: '' });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    // Give up quietly after a few seconds: the card is complete without the excerpt.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(`${file.download_url}?inline=1`, { credentials: 'same-origin', signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => { if (live) setState({ status: 'ready', text }); })
      .catch(() => { if (live) setState({ status: 'error', text: '' }); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); ctrl.abort(); };
  }, [file.download_url]);
  if (state.status === 'error') return null;
  if (state.status === 'loading') return <div className="run-outputs-excerpt run-outputs-excerpt--loading muted">Loading {file.name}…</div>;
  const ex = excerptLines(state.text);
  return (
    <div className="run-outputs-excerpt">
      <div className="run-outputs-excerpt-head">
        <span className="run-outputs-excerpt-name">{file.name} <span className="muted">(excerpt)</span></span>
        <button
          type="button" className="btn-icon" aria-label={`Copy ${file.name}`} title="Copy the whole file"
          onClick={() => { navigator.clipboard?.writeText(state.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
        <button type="button" className="btn-icon" aria-label={`Open ${file.name}`} title="Open" onClick={() => onOpen(file)}>
          <Icon name="external" size={13} />
        </button>
      </div>
      <pre className="run-outputs-excerpt-code">
        {ex.lines.map((l, i) => (<span key={i} className="run-outputs-excerpt-line"><i>{i + 1}</i>{l}</span>))}
        {ex.truncated && <span className="run-outputs-excerpt-line run-outputs-excerpt-more">⋯ {ex.total - ex.lines.length} more lines</span>}
      </pre>
    </div>
  );
}

// ── File row ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   file: object,
 *   onPreview: (file: object) => void,
 * }} props
 */
function FileRow({ file, workflowId, onPreview, index = 0 }) {
  const isImg = isImageFile(file);
  const fresh = useArtifactReveal(`${workflowId}:${file.id}:v${file.version || 1}`, true, file.created_at);
  const { icon, label } = getFileTypeMeta(file.mime_type, file.name);

  return (
    <li
      className={`run-outputs-card-item${fresh ? ' is-new' : ''}`}
      style={fresh ? { '--reveal-delay': `${Math.min(index, 6) * 80}ms` } : undefined}
    >
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
        <AddToVaultButton workflowId={workflowId} file={file} />
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
  const excerptFile = files.find(isExcerptable) ?? null;
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
        <ArtifactHeading title={`${files.length} output file${files.length !== 1 ? 's' : ''} created`} kind="Session outputs" state="ready" />
      </div>

      {/* File list */}
      <ul className="run-outputs-card-list" role="list" aria-label="Output files">
        {displayFiles.map((file, i) => (
          <FileRow
            key={file.id}
            index={i}
            file={file}
            workflowId={workflowId}
            onPreview={(f) => onPreview(f, files)}
          />
        ))}
      </ul>

      {/* An excerpt of the first text or code file */}
      {excerptFile && <FileExcerpt key={excerptFile.id} file={excerptFile} onOpen={(f) => onPreview(f, files)} />}

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
