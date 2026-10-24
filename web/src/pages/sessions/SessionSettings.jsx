import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { ModelPicker } from '../../components/ModelPicker.jsx';
import { Button, ErrorNote, Field, Segmented, useUi } from '../../components/ui.jsx';
import { ENGINE_LABEL, LeadField, LimitFields, PushModeField, TrustToolsField, useLeads } from './NewSessionFields.jsx';
import { RepoRows } from './NewSessionRepos.jsx';

/** A session's goal, lead, model and limits, edited in place. */
export function SessionSettings({ workflow, canEdit, onSaved }) {
  const { project } = useProject();
  const { toast } = useUi();
  const engines = useLoad(() => api.get(`/api/projects/${project.id}/engines`), [project.id]);
  // engine: '' = project default, 'claude' or 'kiro'.
  const [engine, setEngine] = useState(workflow.engine ?? '');
  useEffect(() => setEngine(workflow.engine ?? ''), [workflow.id, workflow.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // Derive kiro-ness from the chosen engine ('' → engines.default, 'claude' → engines.claude provider, 'kiro' → kiro).
  const effectiveKiro = engine === 'kiro' ? true : engine === 'claude' ? false : (engines.data ? engines.data.default === 'kiro' : workflow.provider === 'kiro');
  const team = useLeads(project.id, effectiveKiro);
  const initial = () => ({
    goal: workflow.goal,
    model: workflow.model,
    budgetUsd: workflow.budget_usd,
    budgetCredits: workflow.budget_credits ?? 20,
    maxIterations: workflow.max_iterations,
    leadAgent: workflow.lead_agent ?? '',
    pushMode: workflow.push_mode ?? 'never',
    trustTools: workflow.trust_tools ?? false,
  });
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial()), [workflow.id, workflow.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  // When engine changes, clear the lead if it is no longer valid for the new engine, and reset model.
  const prevTeamRef = useRef(null);
  useEffect(() => {
    if (team === prevTeamRef.current) return;
    prevTeamRef.current = team;
    if (team && f.leadAgent && !team.some((a) => a.name === f.leadAgent)) {
      setF((cur) => ({ ...cur, leadAgent: '' }));
    }
  }, [team]); // eslint-disable-line react-hooks/exhaustive-deps
  // Repositories can be attached or changed while the session is not running.
  const repoList = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const ready = (repoList.data?.repos || []).filter((r) => r.status === 'ready');
  const initialRows = () => (workflow.repos || []).map((r) => ({ repoId: r.repoId, branch: r.branch || '' }));
  const [rows, setRows] = useState(initialRows);
  useEffect(() => setRows(initialRows()), [workflow.id, workflow.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = workflow.status === 'running';
  const repoKey = (list) => JSON.stringify(list.filter((r) => r.repoId).map((r) => [r.repoId, r.branch || '']));
  const reposChanged = repoKey(rows) !== repoKey(initialRows());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/workflows/${workflow.id}`, {
        ...f,
        engine: engine || undefined,
        budgetUsd: effectiveKiro ? undefined : Number(f.budgetUsd),
        budgetCredits: effectiveKiro ? Number(f.budgetCredits) : undefined,
        maxIterations: Number(f.maxIterations),
        trustTools: f.trustTools,
        ...(reposChanged ? { repos: rows.filter((r) => r.repoId).map(({ repoId, branch }) => ({ repoId, branch: branch || undefined })) } : {}),
      });
      toast('Settings saved');
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit) {
    return (
      <div className="stack">
        <h3 className="small">Goal</h3>
        <p className="prompt-box">{workflow.goal}</p>
      </div>
    );
  }
  const showEnginePicker = engines.data && engines.data.default !== 'demo';
  return (
    <div className="stack ws-settings">
      <Field label="Goal" hint="The agents re-read this before every iteration.">
        {(id) => <textarea id={id} className="input" rows={5} value={f.goal} onChange={set('goal')} />}
      </Field>
      {showEnginePicker ? (
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
              disabled={running}
              options={[
                { value: '', label: `Project default (${ENGINE_LABEL[engines.data.default] ?? engines.data.default})` },
                ...(engines.data.claude ? [{ value: 'claude', label: `Claude Code (${ENGINE_LABEL[engines.data.claude]})` }] : []),
                { value: 'kiro', label: 'Kiro' },
              ]}
            />
          </div>
          {running ? <p className="muted small">Engine changes take effect from the next iteration.</p> : null}
        </div>
      ) : null}
      <LeadField team={team} value={f.leadAgent} onChange={(leadAgent) => setF((cur) => ({ ...cur, leadAgent }))} kiro={effectiveKiro} />
      <Field label="Model">{(id) => <ModelPicker id={id} value={f.model} projectId={project.id} engine={engine || undefined} onChange={(model) => setF((cur) => ({ ...cur, model }))} />}</Field>
      <LimitFields f={f} set={set} kiro={effectiveKiro} />
      {running ? (
        workflow.repos?.length ? null : <p className="muted small">Pause or stop the session to attach a repository.</p>
      ) : (
        <>
          <RepoRows rows={rows} setRows={setRows} ready={ready} session />
          {reposChanged ? <p className="muted small">The next iteration starts on fresh working copies of these repositories; the progress summary carries over.</p> : null}
        </>
      )}
      {rows.some((r) => r.repoId) ? <PushModeField value={f.pushMode} onChange={(pushMode) => setF((cur) => ({ ...cur, pushMode }))} /> : null}
      <TrustToolsField value={f.trustTools} onChange={(trustTools) => setF((cur) => ({ ...cur, trustTools }))} hasRepos={rows.some((r) => r.repoId)} />
      {workflow.rules ? (
        <>
          <h3 className="small">Standing rules</h3>
          <p className="prompt-box">{workflow.rules}</p>
        </>
      ) : null}
      {workflow.verify_command ? (
        <>
          <h3 className="small">Check command</h3>
          <p className="mono small">{workflow.verify_command}</p>
        </>
      ) : null}
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!f.goal.trim()} onClick={save}>
          Save settings
        </Button>
      </div>
    </div>
  );
}
