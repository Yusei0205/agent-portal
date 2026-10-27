import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { navigate, href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';

const GOAL_MAX = 8000;

/**
 * New session dialog / modal overlay.
 *
 * @param {{
 *   project: { id: string, name: string },
 *   repos: Array<{ id: string, name: string, status: string }>,
 *   onClose: () => void,
 *   onCreated?: (workflowId: string) => void,
 * }} props
 */
export function NewSessionDialog({ project, repos = [], onClose, onCreated }) {
  const [goal, setGoal] = useState('');
  const [engine, setEngine] = useState('demo');
  const [trustTools, setTrustTools] = useState(false);
  const [leadAgent, setLeadAgent] = useState('');
  const [maxIterations, setMaxIterations] = useState(10);
  const [selectedRepos, setSelectedRepos] = useState(/** @type {Set<string>} */ (new Set()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const goalRef = useRef(null);

  // Focus goal textarea on open
  useEffect(() => {
    goalRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const readyRepos = repos.filter((r) => r.status === 'ready');

  const toggleRepo = (id) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSubmit = goal.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, {
        goal: goal.trim(),
        engine,
        trustTools: engine !== 'demo' ? trustTools : false,
        leadAgent: leadAgent.trim() || undefined,
        maxIterations: Number(maxIterations),
        repoIds: [...selectedRepos],
      });
      // Immediately start the first run
      await api.post(`/api/projects/${project.id}/workflows/${workflow.id}/start`);
      if (onCreated) onCreated(workflow.id);
      navigate(href(project.id, 'sessions', workflow.id));
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to start session');
      setBusy(false);
    }
  };

  const onOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={onOverlayClick}
      aria-hidden="false"
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
      >
        {/* Header */}
        <div className="dialog-head">
          <h2 className="dialog-title" id="new-session-title">
            New session
          </h2>
          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="dialog-body stack">
          {/* Goal */}
          <div className="field">
            <label htmlFor="ns-goal">
              Goal <span aria-hidden="true">*</span>
            </label>
            <textarea
              id="ns-goal"
              ref={goalRef}
              rows={4}
              maxLength={GOAL_MAX}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What should be true when this is done? Describe the outcome."
              aria-required="true"
            />
            <span className="field-hint" aria-live="polite">
              {goal.length}/{GOAL_MAX}
            </span>
          </div>

          {/* Engine */}
          <fieldset>
            <legend className="field" style={{ display: 'contents' }}>
              <label>Engine</label>
            </legend>
            <div className="stack" style={{ gap: 6 }}>
              {[
                { value: 'demo', label: 'Demo', hint: 'Simulated run, no API cost' },
                { value: 'claude-code', label: 'Claude Code', hint: 'Anthropic Claude via Claude Code SDK' },
                { value: 'kiro', label: 'Kiro', hint: 'Kiro CLI engine' },
              ].map((opt) => (
                <label
                  key={opt.value}
                  className={`choice${engine === opt.value ? ' is-checked' : ''}`}
                >
                  <input
                    type="radio"
                    name="ns-engine"
                    value={opt.value}
                    checked={engine === opt.value}
                    onChange={() => setEngine(opt.value)}
                  />
                  <span>
                    <strong>{opt.label}</strong>{' '}
                    <span className="muted">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Trust all tools — hidden for demo */}
          {engine !== 'demo' && (
            <div className="field">
              <label className="choice" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={trustTools}
                  onChange={(e) => setTrustTools(e.target.checked)}
                />
                <span>
                  <strong>Trust all tools</strong>{' '}
                  <span className="muted">
                    Agent may run shell commands and write files without asking first.
                  </span>
                </span>
              </label>
            </div>
          )}

          {/* Lead agent */}
          <div className="field">
            <label htmlFor="ns-lead">Lead agent (optional)</label>
            <input
              id="ns-lead"
              type="text"
              value={leadAgent}
              onChange={(e) => setLeadAgent(e.target.value)}
              placeholder="e.g. backend-engineer"
            />
          </div>

          {/* Max iterations */}
          <div className="field" style={{ maxWidth: 180 }}>
            <label htmlFor="ns-iters">Max iterations</label>
            <input
              id="ns-iters"
              type="number"
              min={1}
              max={100}
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
            />
          </div>

          {/* Repositories */}
          {readyRepos.length > 0 && (
            <fieldset>
              <legend className="field" style={{ display: 'contents' }}>
                <label>Repositories</label>
              </legend>
              <div className="stack" style={{ gap: 4 }}>
                {readyRepos.map((r) => (
                  <label
                    key={r.id}
                    className={`choice${selectedRepos.has(r.id) ? ' is-checked' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedRepos.has(r.id)}
                      onChange={() => toggleRepo(r.id)}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {/* Error */}
          {error && (
            <div className="error-note" role="alert">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="dialog-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!canSubmit}
          >
            {busy ? (
              <>
                <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
                Starting…
              </>
            ) : (
              <>
                <Icon name="play" size={14} />
                Start session
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
