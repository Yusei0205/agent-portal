/**
 * New session dialog (F6 parity).
 *
 * Enhancements:
 *   - Workspace picker with "Playground (no workspace)" option
 *   - Engine cards disabled with setup link when no credential AND no portal provider
 *   - Agent picker from GET /api/user-config/agents?engine=
 *   - Model picker for Kiro and Claude Code: calls GET /api/engines/:engine/models,
 *     shows inline spinner while loading, error hint + Refresh button on failure,
 *     and a "Runs as: {label}" hint once loaded; "Engine default" always selectable
 *   - Credential picker when >1 credential for the engine
 *   - Trust all tools toggle with one-line explanation
 *   - model sent for both Kiro and Claude Code sessions when chosen
 *   - Alt+N shortcut handled at App level (existing behaviour preserved)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { navigate, href } from '../../lib/router.js';
import { Icon } from '../../components/Icon.jsx';
import ModelOptions from '../../components/ModelOptions.jsx';
import { useFocusTrap } from '../../lib/useFocusTrap.js';
import { useOverlayDismiss } from '../../lib/useOverlayDismiss.js';
import { JiraTicketPicker } from '../../components/JiraTicketPicker.jsx';
import { fillGoalVars } from './ticketVars.js';

const GOAL_MAX = 8000;

// ── Engine definitions ─────────────────────────────────────────────────────────

export const ENGINES = [
  { id: 'codex', label: 'Codex', hint: 'OpenAI Codex with your ChatGPT sign-in', providerModes: [] },
  {
    id: 'demo',
    label: 'Demo',
    hint: 'Simulated run, no API cost',
    providerModes: ['demo'],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: 'Anthropic Claude via Claude Code SDK',
    providerModes: ['anthropic', 'bedrock', 'litellm'],
  },
  {
    id: 'kiro',
    label: 'Kiro',
    hint: 'Kiro CLI engine',
    providerModes: ['kiro'],
  },
];

// ── Agent select ───────────────────────────────────────────────────────────────

export function AgentPicker({ engine, value, onChange }) {
  const [agents, setAgents] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (engine === 'demo') { setAgents(null); return; }
    setLoading(true);
    try {
      const { agents: list } = await api.get(`/api/user-config/agents?engine=${encodeURIComponent(engine)}`);
      setAgents(list || []);
    } catch {
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [engine]);

  useEffect(() => { load(); }, [load]);

  if (engine === 'demo' || agents === null) return null;

  const count = agents.length;
  const hint = count > 0 ? `${count} from your config` : 'No agents in your config';

  return (
    <div className="field">
      <label htmlFor="ns-agent">Lead agent</label>
      {loading ? (
        <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading agents…" />
      ) : (
        <>
          <select
            id="ns-agent"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby="ns-agent-hint"
          >
            <option value="">Engine default</option>
            {/* Workspace default not in loaded list — keep it selectable */}
            {value && !agents.some((a) => a.name === value) && (
              <option key="__ws_agent__" value={value}>{value} (from workspace)</option>
            )}
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.description ? ` — ${a.description.slice(0, 50)}` : ''}
              </option>
            ))}
          </select>
          <p className="field-hint" id="ns-agent-hint">{hint}</p>
        </>
      )}
    </div>
  );
}

// ── Model picker ───────────────────────────────────────────────────────────────

/**
 * Model picker for Kiro and Claude Code engines.
 * Calls GET /api/engines/:engine/models?credentialId=<id> on mount and whenever
 * engine or credentialId changes. Pass refresh=1 when the Refresh button is clicked.
 * "Engine default" is always available — it remains selectable even when the
 * endpoint returns an error or an empty list.
 */
export function ModelPicker({ engine, credentialId, value, onChange }) {
  const [models, setModels] = useState([]);
  const [runsAs, setRunsAs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Only the newest request may fill the list. The form asks once before the person's sign-in is picked (the portal
  // provider's models) and again with it; the first answer can arrive last, and offered Bedrock models for a Claude plan.
  const latestCall = useRef(0);

  const load = useCallback(async (forceRefresh = false) => {
    const call = ++latestCall.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (credentialId) params.set('credentialId', credentialId);
      if (forceRefresh) params.set('refresh', '1');
      const qs = params.toString();
      const data = await api.get(
        `/api/engines/${encodeURIComponent(engine)}/models${qs ? `?${qs}` : ''}`,
      );
      if (call !== latestCall.current) return;
      setModels(data.models || []);
      setRunsAs(data.runsAs || null);
      // Server may return partial success with a warning in `error`
      if (data.error) setError(data.error);
    } catch (e) {
      if (call !== latestCall.current) return;
      setModels([]);
      setError(e.message || 'Failed to load models');
    } finally {
      if (call === latestCall.current) setLoading(false);
    }
  }, [engine, credentialId]);

  useEffect(() => { load(false); }, [load]);

  // When loading failed or came back empty (e.g. credentials were still being set up), try again
  // automatically when the user comes back to this tab and every 10 seconds while the dialog is open.
  const needsRetry = !loading && (Boolean(error) || models.length === 0);
  useEffect(() => {
    if (!needsRetry) return undefined;
    let attempts = 0;
    const retry = () => {
      if (document.visibilityState !== 'visible' || attempts >= 6) return;
      attempts += 1;
      load(false);
    };
    const timer = setInterval(retry, 10000);
    window.addEventListener('focus', retry);
    return () => { clearInterval(timer); window.removeEventListener('focus', retry); };
  }, [needsRetry, load]);

  return (
    <div className="field">
      <label htmlFor="ns-model">Model</label>
      {loading ? (
        <div className="spinner" style={{ width: 16, height: 16 }} aria-label="Loading models…" />
      ) : (
        <select
          id="ns-model"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={error ? 'ns-model-error' : runsAs ? 'ns-model-hint' : undefined}
        >
          <option value="">Engine default</option>
          {/* Workspace default not in loaded list — keep it selectable */}
          {value && !models.some((m) => m.id === value) && (
            <option key="__ws_model__" value={value}>{value} (from workspace)</option>
          )}
          <ModelOptions models={models} />
        </select>
      )}
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
          <p
            id="ns-model-error"
            className="field-hint"
            style={{ color: 'var(--danger)', flex: 1, margin: 0 }}
          >
            {error}
          </p>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => load(true)}
            aria-label="Refresh model list"
          >
            Refresh
          </button>
        </div>
      )}
      {!error && runsAs && (
        <p id="ns-model-hint" className="field-hint" style={{ marginTop: 4 }}>
          Runs as: {runsAs.label}
        </p>
      )}
    </div>
  );
}

// ── Credential picker ──────────────────────────────────────────────────────────

/** The sign-in a session starts with: the person's default, else their first own sign-in, else none (portal provider). */
export function defaultCredential(creds) {
  return (creds || []).find((c) => c.isDefault) || (creds || []).find((c) => !c.virtual) || null;
}

export function CredentialPicker({ engine, credentials, value, onChange }) {
  // Shown when there is a choice: more than one sign-in, or the cloud portal's own Bedrock choice.
  const filtered = (credentials || []).filter((c) => c.engine === engine);
  const hasBedrockChoice = filtered.some((c) => c.virtual);
  if (filtered.length <= 1 && !hasBedrockChoice) return null;
  // Without a sign-in of their own the portal's AI provider is the other choice, so name it.
  const options = filtered.some((c) => !c.virtual) ? filtered : [{ id: '', name: 'Portal AI provider (set by your admin)' }, ...filtered];

  return (
    <div className="field">
      <label htmlFor="ns-cred">Credential</label>
      <select
        id="ns-cred"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((c) => (
          <option key={c.id || 'portal'} value={c.id}>
            {c.name}
            {c.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Main dialog ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   project: { id: string, name: string },
 *   repos: Array<{ id: string, name: string, status: string }>,
 *   workspaces: Array<{ id: string, name: string }>,
 *   onClose: () => void,
 *   onCreated?: (workflowId: string) => void,
 *   initialTicket?: { key: string, summary?: string, status?: any, priority?: string, url?: string } | null,
 * }} props
 */
export function NewSessionDialog({ project, repos = [], workspaces = [], onClose, onCreated, initialTicket = null, initialGoal = '', initialRepoIds = [] }) {
  const [goal, setGoal] = useState(
    initialTicket
      ? `Investigate and resolve ${initialTicket.key}: ${initialTicket.summary || initialTicket.key}`
      : initialGoal,
  );
  const [engine, setEngine] = useState('demo');
  const [trustTools, setTrustTools] = useState(false);
  const [leadAgent, setLeadAgent] = useState('');
  const [model, setModel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [maxIterations, setMaxIterations] = useState(10);
  const [selectedRepos, setSelectedRepos] = useState(() => new Set(initialRepoIds));
  const [workspaceId, setWorkspaceId] = useState('');
  const [wsDefaultNote, setWsDefaultNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const goalRef = useRef(null);
  const trapRef = useFocusTrap();

  // Jira integration — load status and track selected ticket.
  // When initialTicket is provided we know Jira is connected (the user came from
  // the Tickets page), so we can skip the extra /jira fetch.
  const initialTicketRef = useRef(initialTicket);
  const [jira, setJira] = useState(initialTicket ? { connected: true } : null);
  const [ticket, setTicket] = useState(initialTicket);

  // Credentials summary + settings (loaded once)
  const [credSummary, setCredSummary] = useState(null);
  const [codexReady, setCodexReady] = useState(false);
  const [portalMode, setPortalMode] = useState('demo');
  const [initLoaded, setInitLoaded] = useState(false);

  // Reset model when credential changes manually (engine changes already handled below)
  const handleCredentialChange = useCallback((newCredId) => {
    setPreflight(null);
    setCredentialId(newCredId);
    setModel('');
  }, []);

  // Load credentials summary and portal mode
  useEffect(() => {
    Promise.all([
      api.get('/api/credentials/summary').catch(() => ({ summary: [] })),
      api.get('/api/settings').catch(() => ({ provider: { mode: 'demo' } })),
    ]).then(([cs, s]) => {
      const summary = cs.summary || [];
      // Flatten to { engine → credential[] }
      const map = {};
      for (const entry of summary) {
        map[entry.engine] = entry.credentials || [];
      }
      setCredSummary(map);
      setCodexReady((cs.summary || []).some(e => e.engine === 'codex' && e.configured));
      setPortalMode(s.provider?.mode || 'demo');

      // Auto-select first credential for the current engine
      const def = defaultCredential(map['claude-code']);
      if (def && engine === 'claude-code') setCredentialId(def.id);
      setInitLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update default credential when engine changes.
  // Agent and model are NOT cleared here — clearing happens only in the engine
  // radio onChange handler (manual user change) so that workspace defaults
  // survive the credential-load that follows a workspace-triggered engine switch.
  useEffect(() => {
    if (!credSummary) return;
    const creds = credSummary[engine] || [];
    setCredentialId(defaultCredential(creds)?.id || '');
  }, [engine, credSummary]);

  // Focus goal on open
  useEffect(() => { goalRef.current?.focus(); }, []);

  // Load Jira connection status for this project (skip when we already have a ticket)
  useEffect(() => {
    if (!project?.id || initialTicketRef.current) return;
    api.get(`/api/projects/${project.id}/jira`)
      .then((r) => setJira(r))
      .catch(() => setJira(null));
  }, [project?.id]);

  // When a ticket is chosen, auto-fill the goal if it is empty
  const handleTicketChange = useCallback((t) => {
    setTicket(t);
    if (t && !goal.trim()) {
      setGoal(`Investigate and resolve ${t.key}: ${t.summary || t.key}`);
    }
  }, [goal]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Apply workspace defaults when the selected workspace changes.
  // Playground (workspaceId='') keeps the current choices unchanged.
  // Re-applies every time the workspace picker changes, even if the user
  // already modified a field.
  useEffect(() => {
    if (!workspaceId) { setWsDefaultNote(''); return; }
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) { setWsDefaultNote(''); return; }
    setTrustTools(Boolean(ws.default_trust_tools));
    const defEngine = ws.default_engine || '';
    if (!defEngine) { setWsDefaultNote(''); return; }
    const available = isEngineAvailable(defEngine);
    if (!available) {
      const label = defEngine === 'kiro' ? 'Kiro' : defEngine === 'claude-code' ? 'Claude Code' : defEngine;
      setWsDefaultNote(`Engine "${label}" from workspace "${ws.name}" is not set up — no credential found.`);
      return;
    }
    setEngine(defEngine);
    if (ws.default_agent) setLeadAgent(ws.default_agent);
    if (ws.default_model) setModel(ws.default_model);
    setWsDefaultNote(`Defaults from workspace ${ws.name}`);
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check if engine is available
  const isEngineAvailable = (eng) => {
    if (eng === 'codex') return codexReady;
    if (eng === 'demo') return true;
    if (!initLoaded) return true; // optimistic until loaded
    const hasCreds = (credSummary?.[eng] || []).length > 0;
    const hasPortalProvider = ENGINES.find((e) => e.id === eng)?.providerModes?.includes(portalMode);
    return hasCreds || hasPortalProvider;
  };

  const readyRepos = repos.filter((r) => r.status === 'ready');

  // When a workspace is selected, build a hint showing which repos it includes.
  const workspaceRepoHint = (() => {
    if (!workspaceId) return null;
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const all = ws.repo_ids || [];
    // Repositories that no longer exist in the project cannot be cloned: leave them out and say so.
    const ids = all.filter((id) => repos.some((r) => r.id === id));
    if (all.length > 0 && ids.length === 0) return 'The repositories of this workspace no longer exist. Edit the workspace (Workspaces page) to pick the current ones.';
    if (ids.length === 0) return 'No repositories in this workspace.';
    const names = ids
      .map((id) => repos.find((r) => r.id === id)?.name ?? id)
      .join(', ');
    return `Repos: ${names}`;
  })();

  const toggleRepo = (id) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // A goal is optional: without one the session just opens (and checks out its repositories) and waits for the first message.
  const canSubmit = !busy;

  // Before a real engine starts, check its sign-in. A failure is shown once with the reason; Start again goes ahead.
  const [preflight, setPreflight] = useState(null);
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if ((engine === 'kiro' || engine === 'claude-code') && !preflight) {
        const check = await api.post('/api/credentials/check', { engine, credentialId: credentialId || undefined }).catch(() => null);
        if (check && !check.ok) {
          setPreflight(check);
          setBusy(false);
          return;
        }
      }
      const payload = {
        goal: goal.trim(),
        engine,
        trustTools: engine !== 'demo' ? trustTools : false,
        leadAgent: leadAgent.trim() || undefined,
        maxIterations: Number(maxIterations),
        repoIds: [...selectedRepos],
        workspaceId: workspaceId || undefined,
        credentialId: credentialId || undefined,
        jiraKey: ticket?.key || undefined,
      };
      // Send model for both Kiro and Claude Code when one is chosen
      if (model && engine !== 'demo') {
        payload.model = model;
      }

      const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, payload);
      if (goal.trim() || ticket) await api.post(`/api/projects/${project.id}/workflows/${workflow.id}/start`);
      if (onCreated) onCreated(workflow.id);
      navigate(href(project.id, 'sessions', workflow.id));
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to start session');
      setBusy(false);
    }
  };

  const onOverlayDismiss = useOverlayDismiss(onClose);

  // Credentials for the current engine (flattened from summary)
  const engineCreds = credSummary
    ? (credSummary[engine] || []).map((c) => ({ ...c, engine }))
    : [];

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onMouseDown={onOverlayDismiss.onMouseDown}
      onClick={onOverlayDismiss.onClick}
      aria-hidden="false"
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        style={{ maxWidth: 580, maxHeight: '90vh', overflowY: 'auto' }}
        ref={trapRef}
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
              Goal <span className="muted" style={{ fontWeight: 400 }}>(optional — leave empty to open the session, check out the repositories, and type your first message there)</span>
            </label>
            <textarea
              id="ns-goal"
              ref={goalRef}
              rows={4}
              maxLength={GOAL_MAX}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What should be true when this is done? Describe the outcome."
            />
            <span className="field-hint" aria-live="polite">
              {goal.length}/{GOAL_MAX}
            </span>
          </div>

          {/* Engine */}
          <fieldset>
            <legend style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 8, display: 'block' }}>
              Engine
            </legend>
            <div className="stack" style={{ gap: 6 }}>
              {ENGINES.map((opt) => {
                const available = isEngineAvailable(opt.id);
                return (
                  <label
                    key={opt.id}
                    className={`choice${engine === opt.id ? ' is-checked' : ''}${!available ? ' is-disabled' : ''}`}
                    style={{ cursor: 'pointer', opacity: available ? 1 : 0.65 }}
                    aria-describedby={!available ? `ns-engine-${opt.id}-hint` : undefined}
                  >
                    <input
                      type="radio"
                      name="ns-engine"
                      value={opt.id}
                      checked={engine === opt.id}
                      disabled={!available}
                      onChange={() => {
                        if (available) {
                          setEngine(opt.id);
                          setPreflight(null);
                          setLeadAgent('');
                          setModel('');
                        }
                      }}
                    />
                    <span>
                      <strong>{opt.label}</strong>{' '}
                      <span className="muted">{opt.hint}</span>
                    </span>
                    {!available && (
                      <span
                        id={`ns-engine-${opt.id}-hint`}
                        style={{ fontSize: '0.78rem', color: 'var(--ink-3)', marginLeft: 'auto' }}
                      >
                        Not set up yet —{' '}
                        <a
                          href="#/config/sign-ins"
                          onClick={() => onClose()}
                          style={{ color: 'var(--accent)' }}
                        >
                          Add your sign-in
                        </a>
                        {' '}or ask an admin to set the portal AI provider
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Workspace */}
          {(workspaces.length > 0 || readyRepos.length > 0) && (
            <div className="field">
              <label htmlFor="ns-workspace">Workspace</label>
              <select
                id="ns-workspace"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                <option value="">Playground (no workspace)</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <p className="field-hint">
                Playground sessions run without a git checkout.
              </p>
              {workspaceRepoHint && (
                <p className="field-hint">{workspaceRepoHint}</p>
              )}
              {wsDefaultNote && (
                <p className="field-hint" aria-live="polite">{wsDefaultNote}</p>
              )}
            </div>
          )}

          {/* Hint when the project has no repos or workspaces yet */}
          {workspaces.length === 0 && readyRepos.length === 0 && repos.length === 0 && project?.id && (
            <p className="field-hint" style={{ fontSize: '0.82rem' }}>
              This project has no repositories yet.{' '}
              <a
                href={`#/p/${project.id}/workspaces/repositories`}
                onClick={onClose}
                style={{ color: 'var(--link, var(--accent))' }}
              >
                Add repositories
              </a>{' '}
              to give sessions access to code.
            </p>
          )}

          {/* Agent picker (loaded per engine) */}
          {engine !== 'demo' && (
            <AgentPicker
              engine={engine}
              value={leadAgent}
              onChange={setLeadAgent}
            />
          )}

          {/* Model picker (Kiro and Claude Code) */}
          {engine !== 'demo' && (
            <ModelPicker
              engine={engine}
              credentialId={credentialId}
              value={model}
              onChange={setModel}
            />
          )}

          {/* Credential picker (when >1) */}
          {engine !== 'demo' && initLoaded && (
            <CredentialPicker
              engine={engine}
              credentials={engineCreds}
              value={credentialId}
              onChange={handleCredentialChange}
            />
          )}

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

          {/* Repositories (legacy: shown when no workspaces and repos exist) */}
          {workspaces.length === 0 && readyRepos.length > 0 && (
            <fieldset>
              <legend style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: 6, display: 'block' }}>
                Repositories
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

          {/* Jira ticket — only shown when Jira is connected for this project */}
          {jira?.connected && (
            <div className="field">
              <label htmlFor="ns-jira-ticket">
                Ticket{' '}
                <span className="muted" style={{ fontWeight: 400 }}>
                  (optional)
                </span>
              </label>
              <JiraTicketPicker
                projectId={project.id}
                jiraMapping={jira?.mapping ?? null}
                value={ticket}
                onChange={handleTicketChange}
              />
              {ticket && (
                <p className="field-hint">
                  Ticket context will be sent with the session goal.
                </p>
              )}
            </div>
          )}

          {preflight && !error && (
            <div className="error-note" role="alert">
              <strong>This sign-in did not pass a check ({preflight.runsAs || 'sign-in'}).</strong> {preflight.message}{' '}
              Pick another sign-in or fix it under <a href="#/config/sign-ins" onClick={() => onClose()}>Agent setup › Sign-ins</a>,
              or press Start session again to go ahead anyway.
            </div>
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
