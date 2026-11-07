/**
 * Tool packs page.
 *
 * Shows a table of the 6 optional tool packs, their status and actions.
 * Installable packs (uv, kiro, drawio) show an Install button that opens
 * an SSE log panel streaming install progress.
 */

import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api.js';

const PACK_NOTES = {
  uv: {
    what: 'AWS integration in agent runs; custom uvx-based MCP servers',
    installNote: null,
    docsNote: null,
  },
  kiro: {
    what: 'Kiro engine (Settings › Provider › Kiro CLI)',
    installNote: 'After installing, run: kiro-cli login --use-device-flow',
    docsNote: null,
  },
  browser: {
    what: 'Web browser integration in agent runs (/browser on)',
    installNote: null,
    docsNote: 'docker compose --profile browser up -d',
  },
  drawio: {
    what: 'Icon-style architecture diagrams with official AWS / Azure / Google Cloud / Kubernetes icons',
    installNote: null,
    docsNote: null,
  },
  docs: {
    what: 'Upload PDF files; generate Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files',
    installNote: null,
    docsNote: 'npm install pdfjs-dist docx exceljs pptxgenjs',
  },
  headroom: {
    what: 'Anthropic API proxy for rate-limit management',
    installNote: null,
    docsNote: 'Set HEADROOM_PROXY_URL environment variable',
  },
};

export default function Secrets() {
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installingId, setInstallingId] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [logDone, setLogDone] = useState(false);
  const logRef = useRef(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.get('/api/settings/packs');
      setPacks(data.packs ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Scroll log to bottom on new lines
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  const startInstall = async (packId) => {
    setInstallingId(packId);
    setLogLines([]);
    setLogDone(false);

    try {
      // Start the install
      await api.post(`/api/settings/packs/${packId}/install`);
    } catch (e) {
      if (e.status !== 409) {
        // 409 = already in progress, which is fine
        setLogLines((l) => [...l, `Error: ${e.message}`]);
        setLogDone(true);
        return;
      }
    }

    // Stream the log
    const es = new EventSource(`/api/settings/packs/${packId}/install/log`);
    es.onmessage = (ev) => {
      let line;
      try {
        line = JSON.parse(ev.data);
      } catch {
        line = ev.data;
      }
      if (line === '\x00done') {
        es.close();
        setLogDone(true);
        // Reload pack statuses
        load();
        return;
      }
      setLogLines((l) => [...l, line]);
    };
    es.onerror = () => {
      es.close();
      setLogDone(true);
      load();
    };
  };

  const closeLog = () => {
    setInstallingId(null);
    setLogLines([]);
    setLogDone(false);
  };

  if (loading) return <div className="spinner" aria-label="Loading tool packs…" />;
  if (error) return <p className="error-note">{error}</p>;

  return (
    <section aria-label="Tool packs">
      <h2>Tool packs</h2>
      <p className="muted">
        Optional packs extend what agents can do. Status updates when you install or configure each pack.
      </p>

      <table className="data-table" aria-label="Tool packs">
        <thead>
          <tr>
            <th scope="col">Pack</th>
            <th scope="col">Status</th>
            <th scope="col">What it enables</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {packs.map((pack) => {
            const note = PACK_NOTES[pack.id] ?? { what: pack.description };
            const isInstalling = installingId === pack.id || pack.status === 'installing';
            return (
              <tr key={pack.id}>
                <td>
                  <strong>{pack.name}</strong>
                </td>
                <td>
                  <PackStatus status={pack.status} />
                </td>
                <td className="muted small">{note.what}</td>
                <td>
                  <PackAction
                    pack={pack}
                    note={note}
                    isInstalling={isInstalling}
                    onInstall={() => startInstall(pack.id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Install log panel */}
      {installingId && (
        <div className="install-log-panel" aria-label="Install log" aria-live="polite">
          <div className="install-log-header">
            <strong>Installing {packs.find((p) => p.id === installingId)?.name ?? installingId}…</strong>
            {logDone && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={closeLog}>
                Close
              </button>
            )}
          </div>
          <div className="install-log-body" ref={logRef}>
            {logLines.map((line, i) => (
              <div key={i} className="install-log-line">
                {line}
              </div>
            ))}
            {!logDone && (
              <div className="install-log-line muted">
                <span className="spinner-inline" aria-hidden="true" /> Waiting for output…
              </div>
            )}
            {logDone && (
              <div className="install-log-line success-note">
                ✓ Install finished.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PackStatus({ status }) {
  const map = {
    'available':     { label: 'Available',     className: 'badge badge-ok' },
    'not-available': { label: 'Not available', className: 'badge badge-neutral' },
    'installing':    { label: 'Installing…',   className: 'badge badge-info' },
    'error':         { label: 'Error',         className: 'badge badge-danger' },
  };
  const info = map[status] ?? map['not-available'];
  return <span className={info.className}>{info.label}</span>;
}

function PackAction({ pack, note, isInstalling, onInstall }) {
  if (pack.installable) {
    return (
      <div className="stack-h">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onInstall}
          disabled={isInstalling || pack.status === 'available'}
          aria-label={`Install ${pack.name}`}
        >
          {isInstalling ? 'Installing…' : pack.status === 'available' ? 'Installed' : 'Install'}
        </button>
        {note.installNote && (
          <span className="muted small">{note.installNote}</span>
        )}
      </div>
    );
  }

  // Non-installable packs: show instruction
  if (note.docsNote) {
    return (
      <span className="muted small">
        <code>{note.docsNote}</code>
      </span>
    );
  }

  if (pack.detail) {
    return <span className="muted small">{pack.detail}</span>;
  }

  return null;
}
