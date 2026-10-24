import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/context.js';
import { useProject } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { go, href } from '../../lib/router.js';
import { cx } from '../../lib/util.js';
import { MODES } from '../../components/run/RunViewer.jsx';
import { ModelPicker } from '../../components/ModelPicker.jsx';
import { ConnectionBadge } from '../../components/ConnectionBadge.jsx';
import { JiraTicketPicker } from '../../components/JiraTicketPicker.jsx';
import { ContextChips, ContextPicker, sendFiles } from '../../components/ContextPicker.jsx';
import { IntegrationPicker } from '../Integrations.jsx';
import { Button, ErrorNote, Field, Modal, Segmented, useUi } from '../../components/ui.jsx';
import { ENGINE_LABEL, LeadField, LimitFields, LoopSpecPicker, PushModeField, SessionToolsRow, SettingsPrecedenceRow, TrustToolsField, useLeads } from './NewSessionFields.jsx';
import { KINDS, RepoRows, useProjectProvider } from './NewSessionRepos.jsx';
import { fillGoalVars, ticketKeyFrom } from './ticketVars.js';

export { ticketKeyFrom, fillGoalVars } from './ticketVars.js';
export { SessionSettings } from './SessionSettings.jsx';

export function NewSessionDialog({ prefill, onClose }) {
  const { project } = useProject();
  const { user } = useApp();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const jira = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const jiraReady = Boolean(jira.data?.connected && jira.data?.mapping);
  const kiro = useProjectProvider(project.id) === 'kiro';
  // Tool packs: for the "Tools for this session" row and Kiro disabled hint
  const packsLoad = useLoad(() => api.get('/api/tool-packs'), []);
  const packs = packsLoad.data?.packs;
  const builtinBrowserId = packsLoad.data?.builtinBrowserId;
  const kiroPack = (packs || []).find((p) => p.id === 'kiro');
  const kiroMissing = kiroPack && kiroPack.status !== 'available';
  // AWS integrations (team-scoped, kind='aws'): shown when any exist; needs uv
  const allIntegrations = useLoad(() => api.get('/api/integrations'), []);
  const awsIntegrations = (allIntegrations.data?.integrations || []).filter((i) => i.kind === 'aws' && i.scope === 'team');
  const isAdmin = Boolean(user?.is_admin);
  const ready = (repos.data?.repos || []).filter((r) => r.status === 'ready');
  // Loop spec: picked at the top, pre-fills form fields
  const [loopSpec, setLoopSpec] = useState(null);
  const applySpec = (spec) => {
    const prevTemplate = loopSpec?.goal_template || '';
    setLoopSpec(spec);
    // Switching specs replaces the goal unless the person has written or edited it since the last spec filled it in.
    setF((cur) => {
      const untouched = !cur.goal.trim() || cur.goal === prevTemplate;
      return untouched ? { ...cur, goal: spec?.goal_template || '' } : cur;
    });
    if (!spec) return;
    if (spec.push_mode) setF((cur) => ({ ...cur, pushMode: spec.push_mode }));
    if (spec.lead_agent) setF((cur) => ({ ...cur, leadAgent: spec.lead_agent }));
    if (spec.trust_tools !== null && spec.trust_tools !== undefined) setTrustTools(Boolean(spec.trust_tools));
  };
  // Save-as-spec modal
  const [savingAsSpec, setSavingAsSpec] = useState(false);
  const [specName, setSpecName] = useState('');
  const [specDesc, setSpecDesc] = useState('');
  const { toast: toast2 } = useUi();

  const [kind, setKind] = useState('session');
  // '' follows the project's connection; 'claude' or 'kiro' picks the engine for this work.
  const engines = useLoad(() => api.get(`/api/projects/${project.id}/engines`), [project.id]);
  const [engine, setEngine] = useState('');
  const effectiveKiro = engine ? engine === 'kiro' : kiro;
  const team = useLeads(project.id, effectiveKiro);
  // When the engine changes, clear the lead if it is no longer valid for the new engine.
  const prevTeamRef = useRef(null);
  useEffect(() => {
    if (team === prevTeamRef.current) return;
    prevTeamRef.current = team;
    if (team && f.leadAgent && !team.some((a) => a.name === f.leadAgent)) {
      setF((cur) => ({ ...cur, leadAgent: '' }));
    } else if (team && !f.leadAgent && project.default_lead_agent && team.some((a) => a.name === project.default_lead_agent)) {
      // Back on an engine the project's default lead can lead on: pick it again.
      setF((cur) => ({ ...cur, leadAgent: project.default_lead_agent }));
    }
  }, [team]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState({
    goal: '',
    repoId: prefill?.repoId || '',
    branch: '',
    // Project defaults (Project and team › Defaults for new work); a lead that cannot lead on the engine is cleared below.
    model: project.default_model || 'sonnet',
    budgetUsd: 5,
    budgetCredits: 20,
    maxIterations: 8,
    leadAgent: project.default_lead_agent || '',
    permissionMode: 'default',
    docScope: '',
    docOutput: 'markdown-word',
    pushMode: 'never',
  });
  const [ticket, setTicket] = useState(prefill?.jiraKey ? { key: prefill.jiraKey, summary: prefill.jiraSummary || prefill.jiraKey, status: null, url: prefill.jiraUrl || null } : null);
  const [ticketText, setTicketText] = useState(prefill?.jiraKey || '');
  const [playground, setPlayground] = useState(false);
  const [trustTools, setTrustTools] = useState(false);
  const [more, setMore] = useState(false);
  const [context, setContext] = useState([]);
  const [picking, setPicking] = useState(false);
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Repositories to work in, each with the branch its working copy starts from ('' = its default branch).
  const [rows, setRows] = useState(() => (prefill?.repoId ? [{ repoId: prefill.repoId, branch: '' }] : []));
  // A workspace fills in the repositories; they can still be changed for this one session.
  const workspaces = useLoad(() => api.get(`/api/projects/${project.id}/workspaces`), [project.id]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [integrations, setIntegrations] = useState([]);
  const pickWorkspace = (id) => {
    setWorkspaceId(id);
    const w = (workspaces.data?.workspaces || []).find((x) => x.id === id);
    if (w) {
      setRows(w.repos.filter((r) => r.status !== 'missing').map((r) => ({ repoId: r.repoId, branch: r.branch })));
      setIntegrations(w.integrations);
    }
  };
  useEffect(() => {
    if (prefill?.workspaceId && workspaces.data && !workspaceId) pickWorkspace(prefill.workspaceId);
  }, [workspaces.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = rows.filter((r) => r.repoId).map(({ repoId, branch }) => ({ repoId, branch: branch || undefined }));
  const hasRepos = chosen.length > 0 || Boolean(workspaceId);
  // New sessions start with the portal's default for agent pushes (Settings › Agent defaults).
  // When repos are chosen, default to 'ask'; the server mirrors this behaviour.
  const [pushTouched, setPushTouched] = useState(false);
  useEffect(() => {
    if (!pushTouched && engines.data?.pushMode) {
      // Use the server/settings default push mode (from /api/projects/:id/engines → pushMode)
      // whenever the user hasn't manually chosen a value yet.
      setF((cur) => ({ ...cur, pushMode: engines.data.pushMode }));
    }
  }, [engines.data?.pushMode, hasRepos, pushTouched]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const isDoc = kind === 'document';
  const isSingle = kind === 'single';
  // Sessions require either repos/workspace or the Playground checkbox.
  // Single runs and document runs have their own repo requirements.
  const sessionReady = hasRepos || playground;
  const canStart = isDoc
    ? Boolean(f.repoId)
    : isSingle
    ? Boolean(f.goal.trim() || ticket)
    : Boolean((f.goal.trim() || ticket) && sessionReady);
  // Track the last created workflow ID so "Save as spec" knows which session to use.
  const [lastWorkflowId, setLastWorkflowId] = useState(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'session') {
        // With files the session starts paused, gets its files, then starts, so the first iteration sees them all.
        const files = context.filter((c) => c.kind === 'file');
        const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, {
          context: context.filter((c) => c.kind !== 'file').map(({ kind: k, ref, title, body }) => ({ kind: k, ref, title, body })),
          start: files.length ? false : undefined,
          goal: fillGoalVars(f.goal, ticket, jira.data?.site?.url),
          repos: chosen,
          playground: chosen.length === 0 && !workspaceId ? true : undefined,
          workspaceId: workspaceId || undefined,
          pushMode: f.pushMode,
          trustTools: trustTools || undefined,
          integrations,
          engine: engine || undefined,
          model: f.model,
          budgetUsd: effectiveKiro ? undefined : Number(f.budgetUsd),
          budgetCredits: effectiveKiro ? Number(f.budgetCredits) : undefined,
          maxIterations: Number(f.maxIterations),
          leadAgent: f.leadAgent,
          jiraKey: ticket?.key || undefined,
          loopSpecId: loopSpec?.id || undefined,
        });
        setLastWorkflowId(workflow.id);
        if (files.length) {
          try {
            await sendFiles(workflow.id, files);
            await api.post(`/api/workflows/${workflow.id}/resume`);
          } catch (e) {
            toast(`The session was created but not started: ${e.message}`, 'danger');
          }
        }
        go(project.id, 'sessions', workflow.id);
      } else {
        // A single run is a session with one iteration (the server limits it to that).
        const body = isDoc
          ? { singleRun: true, document: { repoId: f.repoId, scope: f.docScope, output: f.docOutput }, model: f.model, permissionMode: 'acceptEdits' }
          : {
              singleRun: true,
              prompt: fillGoalVars(f.goal, ticket, jira.data?.site?.url).trim() || undefined,
              jiraKey: ticket?.key || undefined,
              repos: chosen,
              integrations,
              engine: engine || undefined,
              model: f.model,
              permissionMode: f.permissionMode,
            };
        const { workflow } = await api.post(`/api/projects/${project.id}/workflows`, body);
        go(project.id, 'sessions', workflow.id);
      }
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const kindInfo = KINDS.find((k) => k.value === kind);

  const saveAsSpec = async () => {
    if (!lastWorkflowId) return;
    try {
      await api.post(`/api/workflows/${lastWorkflowId}/save-as-spec`, { name: specName, description: specDesc });
      toast2('Loop spec saved', 'ok');
      setSavingAsSpec(false);
    } catch (e) {
      toast2(e.message, 'danger');
    }
  };

  return (
    <>
    <Modal
      wide
      title="Start agent work"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {kind === 'session' && lastWorkflowId ? (
            <Button variant="ghost" size="sm" onClick={() => { setSpecName(f.goal.slice(0, 50) || 'My loop spec'); setSavingAsSpec(true); }}>
              Save as loop spec
            </Button>
          ) : null}
          <Button variant="primary" icon="play" busy={busy} disabled={!canStart} onClick={start}>
            {kind === 'session' ? 'Start session' : isDoc ? 'Start documentation run' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {kind === 'session' ? (
          <LoopSpecPicker projectId={project.id} value={loopSpec} onChange={applySpec} />
        ) : null}
        <div className="row between wrap">
          <Segmented value={kind} onChange={setKind} label="Kind of work" options={KINDS.map(({ value, label }) => ({ value, label }))} />
          <span className="row tight">
            <span className="muted small">Connection:</span>
            <ConnectionBadge projectId={project.id} />
          </span>
        </div>
        <p className="muted small">{kindInfo.hint}</p>
        {engines.data && engines.data.default !== 'demo' ? (
          <div className="stack tight">
            <div className="row tight wrap engine-pick">
              <span className="field-label">Engine</span>
              <Segmented
                size="sm"
                value={engine}
                onChange={(e) => {
                  setEngine(e);
                  // The project's default model is meant for its default engine; another engine starts on Sonnet.
                  setF((cur) => ({ ...cur, model: (!e && project.default_model) || 'sonnet' }));
                }}
                label="Engine"
                options={[
                  { value: '', label: `Project default (${ENGINE_LABEL[engines.data.default] ?? engines.data.default})` },
                  ...(engines.data.claude ? [{ value: 'claude', label: `Claude Code (${ENGINE_LABEL[engines.data.claude]})` }] : []),
                  { value: 'kiro', label: 'Kiro', disabled: kiroMissing },
                ]}
              />
            </div>
            {kiroMissing && engine === 'kiro' ? (
              <p className="muted small" role="alert">
                Kiro CLI is not installed.{' '}
                {isAdmin
                  ? <><a href="#/settings">Install it under Settings › Tools.</a></>
                  : 'Ask an admin to install it under Settings › Tools.'}
              </p>
            ) : kiroMissing ? (
              <p className="muted small">Kiro is not installed — to use Kiro, <a href="#/settings">{isAdmin ? 'install it under Settings › Tools' : 'ask an admin'}</a>.</p>
            ) : null}
          </div>
        ) : null}
        {/* Effective settings line — expands into precedence table */}
        {kind === 'session' && engines.data ? (
          <SettingsPrecedenceRow
            engines={engines.data}
            engine={engine}
            f={f}
            effectiveKiro={effectiveKiro}
            project={project}
            setMore={setMore}
          />
        ) : null}

        {isDoc ? (
          <>
            <div className="row wrap">
              <Field label="Repository" hint={ready.length ? 'Uses the default branch.' : 'Connect and sync a repository on the Repositories page first.'}>
                {(id) => (
                  <select id={id} className="input" value={f.repoId} onChange={set('repoId')}>
                    <option value="">Choose a repository…</option>
                    {ready.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Output" hint="Word and PowerPoint use the make-documents skill.">
                {(id) => (
                  <select id={id} className="input" value={f.docOutput} onChange={set('docOutput')}>
                    <option value="markdown">Markdown files</option>
                    <option value="word">Word document</option>
                    <option value="markdown-word">Markdown and Word</option>
                    <option value="slides">PowerPoint overview</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label="Focus (optional)" hint="Leave empty to cover the whole repository.">
              {(id) => <textarea id={id} className="input" rows={3} value={f.docScope} onChange={set('docScope')} placeholder="For example: the Lambda functions, the DynamoDB tables and how a payment flows through them" />}
            </Field>
          </>
        ) : (
          <>
            {/* A spec whose goal has {{ticket}}: one box for the ticket key or link; it becomes the session's ticket. */}
            {/\{\{ticket(\.[a-z]+)?\}\}/.test(f.goal) ? (
              <Field
                label="Ticket"
                hint={
                  ticket
                    ? `Using ${ticket.key}. The agents read the whole ticket and its attachments, screenshots included.`
                    : 'Type the ticket key (RLP-2884) or paste its link. It fills {{ticket}} in the goal.'
                }
              >
                {(id) => (
                  <input
                    id={id}
                    className="input mono"
                    value={ticketText}
                    placeholder="RLP-2884 or https://…/browse/RLP-2884"
                    onChange={(e) => {
                      const text = e.target.value;
                      setTicketText(text);
                      const key = ticketKeyFrom(text);
                      setTicket(key ? { key, summary: key, status: null, url: /^https?:\/\//i.test(text.trim()) ? text.trim() : null } : null);
                    }}
                  />
                )}
              </Field>
            ) : jiraReady ? (
              <Field label="Jira ticket (optional)" hint={ticket ? 'The agents read the full ticket. The goal below becomes optional.' : 'Pick a ticket and the agents work on it.'}>
                {() => <JiraTicketPicker projectId={project.id} value={ticket} onChange={setTicket} />}
              </Field>
            ) : null}
            <Field label={ticket ? 'Goal (optional)' : 'Goal'} hint="What should be true when this is done? Mention the outcome and anything the agents must not change.">
              {(id) => (
                <textarea
                  id={id}
                  className="input"
                  rows={5}
                  value={f.goal}
                  onChange={set('goal')}
                  autoFocus
                  aria-required={!ticket}
                  placeholder="Fix the refund limit bug in RLP-2683 and add tests for amounts around 500"
                />
              )}
            </Field>
            {workspaces.data?.workspaces?.length ? (
              <Field label="Workspace (optional)" hint="Fills in the repositories below; you can still change them for this one.">
                {(id) => (
                  <select id={id} className="input" value={workspaceId} onChange={(e) => pickWorkspace(e.target.value)}>
                    <option value="">No workspace: pick repositories yourself</option>
                    {workspaces.data.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} · {w.repos.length} repo{w.repos.length === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            <RepoRows rows={rows} setRows={setRows} ready={ready} session={kind === 'session'} projectId={project.id} onRepoAdded={() => repos.reload(true)} />
            {kind === 'session' && !hasRepos ? (
              <label className="choice">
                <input
                  type="checkbox"
                  checked={playground}
                  onChange={(e) => setPlayground(e.target.checked)}
                />
                <span>
                  <strong>Playground</strong>{' '}
                  <span className="muted">No repository — the agents work with project documents only and can't push changes.</span>
                </span>
              </label>
            ) : null}
            {kind === 'session' ? (
              <div className="ctx-field">
                <div className="row between wrap">
                  <span className="field-label">Context for the agents (optional)</span>
                  <Button size="sm" icon="plus" onClick={() => setPicking(true)}>
                    Add context
                  </Button>
                </div>
                {context.length ? (
                  <ContextChips items={context} onRemove={(i) => setContext((c) => c.filter((_, j) => j !== i))} />
                ) : (
                  <p className="muted small">Documents, files, notes, links or earlier work the agents should read first.</p>
                )}
              </div>
            ) : null}
            {kind === 'single' ? (
              <fieldset className="mode-pick">
                <legend className="field-label">Changes</legend>
                {MODES.map((m) => (
                  <label key={m.value} className={cx('choice', f.permissionMode === m.value && 'is-checked')}>
                    <input type="radio" name="mode" checked={f.permissionMode === m.value} onChange={() => setF({ ...f, permissionMode: m.value })} />
                    <span>
                      <strong>{m.label}</strong> <span className="muted">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </>
        )}

        {/* Tools for this session — browser + AWS quick-attach, shown for session and single run */}
        {!isDoc ? (
          <SessionToolsRow
            integrations={integrations}
            setIntegrations={setIntegrations}
            packs={packs}
            awsIntegrations={awsIntegrations}
            builtinBrowserId={builtinBrowserId}
          />
        ) : null}

        <details className="ws-more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary>More options</summary>
          <div className="stack">
            <Field label="Model" hint="Pick a tier or any model your provider offers, or paste a model ID.">
              {(id) => <ModelPicker id={id} value={f.model} projectId={project.id} engine={engine || undefined} onChange={(model) => setF((cur) => ({ ...cur, model }))} />}
            </Field>
            {!isDoc ? (
              <Field label={`Integrations${integrations.length ? ` (${integrations.length})` : ''}`} hint="MCP tools the agents may use in this work: Jira, AWS, a browser… Read-only unless writes are allowed.">
                {() => <IntegrationPicker value={integrations} onChange={setIntegrations} packs={packs} />}
              </Field>
            ) : null}
            {kind === 'session' ? (
              <>
                <LeadField team={team} value={f.leadAgent} onChange={(leadAgent) => setF((cur) => ({ ...cur, leadAgent }))} kiro={effectiveKiro} />
                <LimitFields f={f} set={set} kiro={effectiveKiro} />
                {hasRepos ? <PushModeField value={f.pushMode} onChange={(pushMode) => (setPushTouched(true), setF((cur) => ({ ...cur, pushMode })))} /> : null}
                <TrustToolsField value={trustTools} onChange={setTrustTools} hasRepos={hasRepos} />
              </>
            ) : null}
          </div>
        </details>
        {!ready.length && !isDoc ? (
          <p className="muted small">
            To let agents change code,{' '}
            <a href={href(project.id, 'repos')} onClick={() => {}}>
              connect a repository
            </a>{' '}
            or use the <em>Connect repo</em> button above.
          </p>
        ) : null}
        <ErrorNote error={error} />
      </div>
      {picking ? <ContextPicker projectId={project.id} onAdd={(item) => setContext((c) => [...c, item])} onClose={() => setPicking(false)} /> : null}
    </Modal>
    {savingAsSpec ? (
      <Modal title="Save as loop spec" onClose={() => setSavingAsSpec(false)} footer={
        <>
          <Button variant="ghost" onClick={() => setSavingAsSpec(false)}>Cancel</Button>
          <Button variant="primary" disabled={!specName.trim()} onClick={saveAsSpec}>Save spec</Button>
        </>
      }>
        <div className="stack">
          <p className="muted small">Save this session's settings as a reusable loop spec for future use.</p>
          <Field label="Spec name">
            {(id) => <input id={id} className="input" value={specName} onChange={(e) => setSpecName(e.target.value)} placeholder="Feature branch loop" autoFocus />}
          </Field>
          <Field label="Description (optional)">
            {(id) => <input id={id} className="input" value={specDesc} onChange={(e) => setSpecDesc(e.target.value)} placeholder="What does this spec do?" />}
          </Field>
        </div>
      </Modal>
    ) : null}
    </>
  );
}
