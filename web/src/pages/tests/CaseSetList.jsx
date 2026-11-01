/**
 * CaseSetList — "Test cases" tab.
 *
 * Lists all case sets for a test project, polls while any are running,
 * and allows generating new ones via GenerateCasesDialog.
 *
 * Props:
 *   testProject   - test project object
 *   projectId     - string
 *   onOpenCaseSet(csid) - called when user clicks Open on a case set
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { formatRelative } from '../../lib/util.js';
import { GenerationTracker } from './GenerationTracker.jsx';
import { GenerateCasesDialog } from './GenerateCasesDialog.jsx';
import { useBulkSelect } from '../../lib/useBulkSelect.js';
import { BulkActionBar } from '../../components/BulkActionBar.jsx';
import './tests-cases.css';

// ── Rename dialog ──────────────────────────────────────────────────────────────

function RenameCaseSetDialog({ caseSet, onSave, onClose }) {
  const [name, setName]   = useState(caseSet.name || '');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const trapRef  = useFocusTrap();

  useEffect(() => { inputRef.current?.select(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-cs-title"
        style={{ maxWidth: 400 }}
        ref={trapRef}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="rename-cs-title">Rename case set</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="dialog-body">
            <div className="field">
              <label htmlFor="rename-cs-name">Name</label>
              <input
                id="rename-cs-name"
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
                disabled={busy}
              />
            </div>
            {error && <div className="error-note" role="alert">{error}</div>}
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {busy ? 'Saving\u2026' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const style = {
    display: 'inline-block',
    padding: '1px 8px',
    borderRadius: 10,
    fontSize: '0.72rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    border: '1px solid transparent',
  };
  if (status === 'done') {
    return <span style={{ ...style, background: 'color-mix(in srgb, var(--ok, #16a34a) 15%, transparent)', color: 'color-mix(in srgb, var(--ok, #16a34a) 90%, var(--ink))', borderColor: 'color-mix(in srgb, var(--ok, #16a34a) 30%, transparent)' }}>Done</span>;
  }
  if (status === 'failed') {
    return <span style={{ ...style, background: 'color-mix(in srgb, var(--danger, #dc2626) 12%, transparent)', color: 'color-mix(in srgb, var(--danger, #dc2626) 90%, var(--ink))', borderColor: 'color-mix(in srgb, var(--danger, #dc2626) 25%, transparent)' }}>Failed</span>;
  }
  if (status === 'cancelled') {
    return <span style={{ ...style, background: 'color-mix(in srgb, var(--ink-3) 12%, transparent)', color: 'var(--ink-3)' }}>Cancelled</span>;
  }
  if (status === 'running' || status === 'pending') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span className="spinner" style={{ width: 11, height: 11 }} aria-hidden="true" />
        <span style={{ ...style, border: 'none', padding: 0, fontSize: '0.78rem', fontWeight: 500 }}>Running</span>
      </span>
    );
  }
  return <span style={{ ...style, color: 'var(--ink-3)' }}>{status}</span>;
}

// ── Small progress bar inside card ────────────────────────────────────────────

function CardProgressBar({ progress }) {
  if (!progress) return null;
  const { percent } = progress;
  return (
    <div className="case-set-progress-bar" aria-hidden="true">
      <div
        className={`case-set-progress-fill${percent == null ? ' indeterminate' : ''}`}
        style={percent != null ? { width: `${percent}%` } : undefined}
      />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function CaseSetList({ testProject, projectId, onOpenCaseSet }) {
  const [caseSets, setCaseSets]   = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [resumingId, setResumingId] = useState(null);
  const [bulkBusy, setBulkBusy]   = useState(false);

  // Background generation jobs: { id, kind:'case-set', description, status, progress, startedAt, createdAt }
  const [genJobs, setGenJobsState]  = useState([]);
  const genJobsRef  = useRef([]);
  const genPollRef  = useRef(null);
  const visibilityRef = useRef(document.visibilityState);

  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast }   = useToast();
  const finishedSets = (caseSets || []).filter((cs) => cs.status !== 'pending' && cs.status !== 'running');
  const bulk = useBulkSelect(finishedSets);

  const tpId = testProject.id;
  const listUrl = `/api/projects/${projectId}/tests/${tpId}/case-sets`;

  // Keep genJobsRef in sync for use inside intervals
  const setGenJobs = useCallback((updater) => {
    setGenJobsState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      genJobsRef.current = next;
      return next;
    });
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError(null);
    try {
      const data = await api.get(listUrl);
      setCaseSets(data.caseSets || []);
    } catch (e) {
      if (!silent) setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [listUrl]);

  useEffect(() => { load(); }, [load]);

  // Pause polling when tab is hidden
  useEffect(() => {
    const handler = () => { visibilityRef.current = document.visibilityState; };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const startGenPoll = useCallback(() => {
    if (genPollRef.current) return;
    genPollRef.current = setInterval(async () => {
      if (visibilityRef.current === 'hidden') return;
      const active = genJobsRef.current.filter(
        (j) => j.status === 'pending' || j.status === 'running',
      );
      if (active.length === 0) {
        clearInterval(genPollRef.current);
        genPollRef.current = null;
        return;
      }
      for (const job of active) {
        try {
          const data = await api.get(`${listUrl}/${job.id}`);
          const cs = data.caseSet;
          if (cs.status === 'done') {
            toast(`Generated ${cs.caseCount || 0} test case${cs.caseCount !== 1 ? 's' : ''}`, 'ok');
            setGenJobs((prev) => prev.filter((j) => j.id !== job.id));
            load(true);
          } else if (cs.status === 'failed' || cs.status === 'cancelled') {
            setGenJobs((prev) => prev.map((j) =>
              j.id === job.id ? { ...j, status: cs.status, error: cs.error } : j,
            ));
            load(true);
          } else {
            setGenJobs((prev) => prev.map((j) =>
              j.id === job.id
                ? { ...j, status: cs.status, progress: cs.progress, startedAt: cs.startedAt }
                : j,
            ));
          }
        } catch { /* ignore transient errors */ }
      }
    }, 2500);
  }, [listUrl, load, toast, setGenJobs]);

  const addGenJob = useCallback((csid, name, description) => {
    setGenJobs((prev) => [
      ...prev.filter((j) => j.id !== csid),
      { id: csid, kind: 'case-set', description, name, status: 'pending',
        traceUrl: `${listUrl}/${csid}/trace` },
    ]);
    startGenPoll();
  }, [setGenJobs, startGenPoll, listUrl]);

  const dismissGenJob = useCallback((id) => {
    setGenJobs((prev) => prev.filter((j) => j.id !== id));
  }, [setGenJobs]);

  const cancelGenJob = useCallback(async (id) => {
    try {
      await api.post(`${listUrl}/${id}/cancel`, {});
      setGenJobs((prev) => prev.map((j) => j.id === id ? { ...j, status: 'cancelled' } : j));
      load(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }, [listUrl, load, toast, setGenJobs]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearInterval(genPollRef.current);
      genPollRef.current = null;
    };
  }, []);

  const deleteCaseSet = async (csid, name) => {
    if (!await requestConfirm(`Delete "${name}"? This cannot be undone.`, 'Delete', 'danger')) return;
    try {
      await api.delete(`${listUrl}/${csid}`);
      load(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const handleBulkDelete = async () => {
    const n = bulk.selected.size;
    if (!await requestConfirm(
      `Delete ${n} case set${n === 1 ? '' : 's'}? This cannot be undone.`,
      'Delete', 'danger',
    )) return;
    setBulkBusy(true);
    const ids = [...bulk.selected];
    const failed = [];
    await Promise.all(ids.map(async (id) => {
      try {
        await api.delete(`${listUrl}/${id}`);
      } catch {
        failed.push(id);
      }
    }));
    bulk.clearAll();
    if (failed.length > 0) toast(`${failed.length} case set${failed.length === 1 ? '' : 's'} could not be deleted.`, 'error');
    setBulkBusy(false);
    load(true);
  };

  const renameCaseSet = async (csid, newName) => {
    await api.patch(`${listUrl}/${csid}`, { name: newName });
    setCaseSets((prev) => (prev || []).map((cs) => cs.id === csid ? { ...cs, name: newName } : cs));
  };

  const resumeCaseSet = useCallback(async (cs) => {
    setResumingId(cs.id);
    try {
      await api.post(`${listUrl}/${cs.id}/resume`, {});
      addGenJob(cs.id, cs.name, cs.description || cs.name);
      load(true);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setResumingId(null);
    }
  }, [listUrl, addGenJob, load, toast]);

  if (loading) return <div className="spinner" aria-label="Loading test cases…" />;
  if (error)   return <p className="error-note" role="alert">{error}</p>;

  const running  = (caseSets || []).filter((cs) => cs.status === 'pending' || cs.status === 'running');
  const finished = (caseSets || []).filter((cs) => cs.status !== 'pending' && cs.status !== 'running');

  // Jobs currently showing via GenerationTracker (pending/running/failed gen jobs)
  const trackerJobs = genJobs.filter((j) => j.status === 'pending' || j.status === 'running' || j.status === 'failed');

  return (
    <div>
      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setShowGenerate(true)}
          aria-label="Generate test cases"
        >
          <Icon name="flask" size={13} /> Generate test cases
        </button>
        {finished.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.82rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={bulk.allSelected}
              ref={(el) => { if (el) el.indeterminate = bulk.someSelected; }}
              onChange={bulk.toggleAll}
              aria-label="Select all case sets"
            />
            Select all
          </label>
        )}
        <span className="muted" style={{ fontSize: '0.82rem', marginLeft: 'auto' }}>
          {(caseSets || []).length} set{(caseSets || []).length !== 1 ? 's' : ''}
        </span>
        <button type="button" className="btn-icon" onClick={() => load()} aria-label="Refresh">
          <Icon name="refresh" size={14} />
        </button>
      </div>

      {/* Progress tracker for newly submitted jobs */}
      {trackerJobs.length > 0 && (
        <GenerationTracker
          jobs={trackerJobs}
          onDismiss={dismissGenJob}
          onCancel={cancelGenJob}
        />
      )}

      {/* Running case sets (card view with inline progress) */}
      {running.length > 0 && running.map((cs) => (
        <div
          key={cs.id}
          style={{
            border: '1px solid color-mix(in srgb, var(--accent, #6366f1) 30%, var(--line))',
            borderRadius: 'var(--radius)',
            padding: '10px 12px',
            marginBottom: 8,
            background: 'color-mix(in srgb, var(--accent, #6366f1) 4%, var(--canvas))',
          }}
          aria-label={`Running case set: ${cs.name}`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cs.name}
              </div>
              <div className="muted" style={{ fontSize: '0.77rem' }}>
                <StatusBadge status={cs.status} />
                {cs.progress?.message ? ` \u2014 ${cs.progress.message}` : ''}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onOpenCaseSet(cs.id)}
              aria-label={`Open ${cs.name}`}
            >
              Open
            </button>
          </div>
          <CardProgressBar progress={cs.progress} />
        </div>
      ))}

      {/* Finished / all case sets */}
      {(caseSets || []).length === 0 && trackerJobs.length === 0 && (
        <div className="ws-placeholder">
          <Icon name="flask" size={48} />
          <p>No test case sets yet.</p>
          <p className="muted">Generate test cases from your spec documents to get structured QA test rows.</p>
          <button type="button" className="btn btn-primary" onClick={() => setShowGenerate(true)}>
            Generate test cases
          </button>
        </div>
      )}

      {finished.map((cs) => (
        <div
          key={cs.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            background: 'var(--canvas)',
            marginBottom: 6,
            flexWrap: 'wrap',
          }}
          aria-label={`Case set: ${cs.name}`}
        >
          <input
            type="checkbox"
            aria-label={`Select ${cs.name}`}
            checked={bulk.selected.has(cs.id)}
            onChange={() => bulk.toggle(cs.id)}
            style={{ flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cs.name}
            </div>
            <div className="muted" style={{ fontSize: '0.77rem', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <StatusBadge status={cs.status} />
              {cs.caseCount != null && (
                <span>{cs.caseCount} case{cs.caseCount !== 1 ? 's' : ''}</span>
              )}
              <span>{formatRelative(cs.createdAt)}</span>
              {cs.status === 'failed' && cs.error && (
                <span style={{ color: 'var(--danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                  {cs.error}
                </span>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onOpenCaseSet(cs.id)}
              aria-label={`Open ${cs.name}`}
            >
              Open
            </button>
            {(cs.status === 'failed' || cs.status === 'cancelled') && cs.resumable && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => resumeCaseSet(cs)}
                disabled={resumingId === cs.id}
                aria-label={`Resume generation of ${cs.name}`}
              >
                {resumingId === cs.id ? 'Resuming\u2026' : 'Resume'}
              </button>
            )}
            {(cs.status === 'done' || (cs.caseCount && cs.caseCount > 0)) && (
              <a
                href={`${listUrl}/${cs.id}/export.xlsx`}
                download
                className="btn btn-ghost btn-sm"
                aria-label={`Download ${cs.name} as Excel`}
              >
                <Icon name="download" size={12} /> Excel
              </a>
            )}
            <button
              type="button"
              className="btn-icon"
              onClick={() => setRenameTarget(cs)}
              aria-label={`Rename ${cs.name}`}
              title="Rename"
            >
              <Icon name="rename" size={13} />
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => deleteCaseSet(cs.id, cs.name)}
              aria-label={`Delete ${cs.name}`}
              title="Delete"
              style={{ color: 'var(--danger)' }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      ))}

      {/* Bulk actions for finished case sets */}
      {finished.length > 0 && (
        <div style={{ position: 'relative' }}>
          <BulkActionBar
            selected={bulk.selected}
            onDelete={handleBulkDelete}
            onClear={bulk.clearAll}
            busy={bulkBusy}
            noun="case set"
          />
        </div>
      )}

      {/* Dialogs */}
      {showGenerate && (
        <GenerateCasesDialog
          testProjectId={tpId}
          projectId={projectId}
          onClose={() => setShowGenerate(false)}
          onGenerated={(csid, name, desc) => {
            setShowGenerate(false);
            addGenJob(csid, name, desc);
            load(true);
          }}
        />
      )}

      {renameTarget && (
        <RenameCaseSetDialog
          caseSet={renameTarget}
          onSave={(newName) => renameCaseSet(renameTarget.id, newName)}
          onClose={() => setRenameTarget(null)}
        />
      )}
    </div>
  );
}
