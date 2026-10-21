import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { parseUnifiedDiff } from '../../lib/diff.js';
import { Icon } from '../Icon.jsx';
import { Markdown } from '../Markdown.jsx';
import { DiffView } from '../DiffView.jsx';
import { ErrorNote, Modal, Spinner } from '../ui.jsx';

/** Files a run wrote and the diff of its working copy. */
export function Changes({ run }) {
  const { user } = useApp();
  const ch = useLoad(() => api.get(`/api/runs/${run.id}/changes`), [run.id, run.status]);
  const [file, setFile] = useState(null);
  const [copied, setCopied] = useState(false);

  const isAdmin = user?.is_admin;

  const copyPath = () => {
    const p = ch.data?.absPath || ch.data?.worktree || ch.data?.workDir || '';
    navigator.clipboard.writeText(p).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (!ch.data) return ch.error ? <ErrorNote error={ch.error} /> : <Spinner />;
  const files = ch.data.diff ? parseUnifiedDiff(ch.data.diff) : [];
  const hasFiles = ch.data.files.length > 0;

  // Admins see the absolute server path; others see the relative path as before.
  const displayPath = isAdmin && ch.data.absPath ? ch.data.absPath : (ch.data.worktree || ch.data.workDir);

  return (
    <div className="pad-sm stack">
      {displayPath ? (
        <div className="row tight wrap" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted small">{ch.data.worktree ? 'Working copy' : 'Run folder'}:</span>
          <code className="small" style={{ wordBreak: 'break-all' }}>{displayPath}</code>
          <button
            type="button"
            className="icon-btn"
            aria-label={copied ? 'Copied' : 'Copy path to clipboard'}
            title={copied ? 'Copied!' : 'Copy path'}
            onClick={copyPath}
            style={{ flexShrink: 0 }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={15} />
          </button>
          {hasFiles ? (
            <a
              className="btn btn-sm btn-default"
              href={`/api/runs/${run.id}/files/zip`}
              download
              aria-label="Download all run files as a ZIP archive"
              style={{ marginLeft: 'auto' }}
            >
              <Icon name="download" size={15} />
              <span>Download all (.zip)</span>
            </a>
          ) : null}
        </div>
      ) : null}
      {ch.data.repos?.length > 1 ? (
        <ul className="row tight wrap changes-repos" aria-label="Changes per repository">
          {ch.data.repos.map((r) => (
            <li key={r.repoId} className="chip-static small">
              <strong>{r.name}</strong> {r.changed ? `${r.changed} file${r.changed === 1 ? '' : 's'}` : 'no changes'}
            </li>
          ))}
        </ul>
      ) : null}
      {files.length ? <DiffView files={files} /> : null}
      {hasFiles ? (
        <ul className="file-list">
          {ch.data.files.map((f) => (
            <li key={f.path} className="row tight" style={{ alignItems: 'center', gap: 6 }}>
              <button type="button" className="linkish" style={{ flex: 1, textAlign: 'left' }} onClick={() => setFile(f.path)}>
                <Icon name="file" size={15} /> {f.path}
              </button>
              <span className="muted small" style={{ flexShrink: 0 }}>
                {f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}
              </span>
              <a
                className="icon-btn"
                href={`/api/runs/${run.id}/file/download?path=${encodeURIComponent(f.path)}`}
                download={f.path.split('/').pop()}
                aria-label={`Download ${f.path}`}
                title="Download file"
                onClick={(e) => e.stopPropagation()}
              >
                <Icon name="download" size={15} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {!files.length && !hasFiles ? <p className="muted">No files changed.</p> : null}
      {file ? <FileModal run={run} path={file} onClose={() => setFile(null)} /> : null}
    </div>
  );
}

/** Binary file extensions that cannot be shown as text. */
const BINARY_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.zip', '.tar', '.gz', '.bin', '.exe', '.dll', '.so', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi']);

function isBinaryPath(p) {
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTS.has(ext);
}

function FileModal({ run, path, onClose }) {
  const f = useLoad(() => api.get(`/api/runs/${run.id}/file?path=${encodeURIComponent(path)}`), [path]);
  const binary = f.data ? (f.data.binary || isBinaryPath(path)) : isBinaryPath(path);
  const downloadHref = `/api/runs/${run.id}/file/download?path=${encodeURIComponent(path)}`;
  const filename = path.split('/').pop();

  return (
    <Modal title={path} onClose={onClose} wide>
      {f.data ? (
        binary ? (
          <div className="stack" style={{ alignItems: 'center', padding: '24px 0', textAlign: 'center' }}>
            <Icon name="file" size={32} />
            <p className="muted">Preview not available for this file type.</p>
            <a className="btn btn-primary btn-sm" href={downloadHref} download={filename} aria-label={`Download ${filename}`}>
              <Icon name="download" size={15} />
              <span>Download {filename}</span>
            </a>
          </div>
        ) : path.endsWith('.md') ? (
          <Markdown text={f.data.content} />
        ) : (
          <pre className="preview">{f.data.content}</pre>
        )
      ) : f.error ? (
        <div className="stack" style={{ alignItems: 'center', padding: '24px 0', textAlign: 'center' }}>
          <ErrorNote error={f.error} />
          <a className="btn btn-default btn-sm" href={downloadHref} download={filename} aria-label={`Download ${filename}`}>
            <Icon name="download" size={15} />
            <span>Download {filename}</span>
          </a>
        </div>
      ) : (
        <Spinner />
      )}
    </Modal>
  );
}
