import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { cx, money } from '../../lib/util.js';
import { useSortable } from '../../lib/useSortable.js';
import { SortHeader } from '../../components/SortHeader.jsx';
import { Button, ErrorNote, Field, Toggle } from '../../components/ui.jsx';
import { PUSH_MODES } from '../sessions/status.js';
import { useSave } from './useSave.js';

export function ModelsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const isKiro = s.provider.mode === 'kiro';
  const sourceModels = isKiro ? (s.kiro?.models ?? { sonnet: '', haiku: '', opus: '' }) : s.provider.models;
  const [m, setM] = useState(sourceModels);
  useEffect(() => setM(isKiro ? (s.kiro?.models ?? { sonnet: '', haiku: '', opus: '' }) : s.provider.models), [s.provider.models, s.kiro?.models, isKiro]);
  const dirty = JSON.stringify(m) !== JSON.stringify(sourceModels);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const canLoad = s.provider.mode !== 'demo';
  const loadModels = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get('/api/settings/models');
      setList(data.models);
    } catch (e) {
      setList(null);
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (canLoad) loadModels();
    else setList(null);
  }, [s.provider.mode, s.aws.region, s.aws.auth]);
  return (
    <section className="panel">
      <h2>Model versions</h2>
      <p className="muted small">
        {isKiro
          ? 'Agents ask for "sonnet", "haiku" or "opus". Leave these blank and Kiro will pick its newest model of that family.'
          : 'Agents ask for "sonnet", "haiku" or "opus". Leave these on the default to use the latest versions. On Bedrock, pick the model or inference profile your account has enabled.'}
      </p>
      <div className="model-grid">
        {['haiku', 'sonnet', 'opus'].map((k) => {
          const own = (list ?? []).filter((o) => o.family === k);
          const options = own.length ? own : list ?? [];
          const missing = m[k] && !options.some((o) => o.id === m[k]);
          const kiroPlaceholder = k === 'sonnet' ? 'claude-sonnet-5.5' : k === 'haiku' ? 'claude-haiku-4.5' : 'claude-opus-5.5';
          return (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
              {(id) =>
                list ? (
                  <select id={id} className="input mono" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })}>
                    <option value="">{isKiro ? 'Kiro picks newest (default)' : 'Latest (default)'}</option>
                    {missing ? <option value={m[k]}>{m[k]} (current)</option> : null}
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name === o.id ? o.id : `${o.name} — ${o.id}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id={id} className="input mono" value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value.trim() })} placeholder={isKiro ? kiroPlaceholder : s.provider.mode === 'bedrock' ? `global.anthropic.claude-${k}-...` : `claude-${k}-5-5`} />
                )
              }
            </Field>
          );
        })}
      </div>
      {loadError ? <p className="muted small">Could not load the model list ({loadError.message}). You can type the model IDs instead.</p> : null}
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" disabled={!dirty} busy={busy} onClick={() => save(isKiro ? { kiro: { command: s.kiro?.command ?? '', models: m } } : { provider: { models: m } })}>
          Save model versions
        </Button>
        {canLoad ? (
          <Button variant="ghost" busy={loading} onClick={loadModels}>
            Reload model list
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function BudgetSection({ s, usage, reload }) {
  const { busy, error, save } = useSave(reload);
  const [cap, setCap] = useState(s.budget.monthlyUsd ?? '');
  useEffect(() => setCap(s.budget.monthlyUsd ?? ''), [s.budget.monthlyUsd]);
  const used = usage?.totalUsd ?? s.usage.monthUsd;
  const pct = s.budget.monthlyUsd ? Math.min(100, Math.round((100 * used) / s.budget.monthlyUsd)) : null;

  const BUDGET_COLS = [
    { key: 'name',  label: 'Project', accessor: 'name', type: 'text' },
    { key: 'runs',  label: 'Runs',    accessor: 'runs', type: 'number' },
    { key: 'spend', label: 'Spend',   accessor: 'usd',  type: 'number' },
  ];
  const { sorted: sortedBudget, sortKey: bSortKey, sortDir: bSortDir, toggle: bToggle } = useSortable(
    usage?.byProject || [],
    { columns: BUDGET_COLS, storageKey: 'sort:settings:budget' }
  );

  return (
    <section className="panel">
      <h2>Budget</h2>
      <p className="lead-num">
        {money(used, 2)} <span className="muted">spent this month{s.budget.monthlyUsd ? ` of ${money(s.budget.monthlyUsd, 0)}` : ''}</span>
      </p>
      {pct !== null ? (
        <div className={cx('budget-bar', pct >= 90 && 'is-hot')}>
          <div style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <p className="muted small">New runs are refused once the cap is reached. Demo runs are free and do not count.</p>
      {s.provider.mode === 'kiro' ? <p className="muted small">Kiro runs are billed as Kiro credits, not dollars. This dollar cap does not apply to them.</p> : null}
      <div className="row">
        <Field label="Monthly cap in USD" hint="Empty means no cap.">
          {(id) => <input id={id} type="number" min={0} step={1} className="input input-num" value={cap} onChange={(e) => setCap(e.target.value)} />}
        </Field>
        <Button variant="primary" busy={busy} onClick={() => save({ budget: { monthlyUsd: cap === '' ? null : Number(cap) } })}>
          Save cap
        </Button>
      </div>
      <ErrorNote error={error} />
      {usage?.byProject?.length ? (
        <table className="table compact">
          <thead>
            <tr>
              <SortHeader col={BUDGET_COLS[0]} sortKey={bSortKey} sortDir={bSortDir} onSort={bToggle} />
              <SortHeader col={BUDGET_COLS[1]} sortKey={bSortKey} sortDir={bSortDir} onSort={bToggle} className="num" />
              <SortHeader col={BUDGET_COLS[2]} sortKey={bSortKey} sortDir={bSortDir} onSort={bToggle} className="num" />
            </tr>
          </thead>
          <tbody>
            {sortedBudget.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{p.runs}</td>
                <td className="num">{money(p.usd, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function AgentsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [a, setA] = useState(s.agents);
  useEffect(() => setA(s.agents), [s.agents]);
  return (
    <section className="panel">
      <h2>Agent defaults</h2>
      <div className="row wrap">
        <Field label="Changes, unless a run says otherwise">
          {(id) => (
            <select id={id} className="input" value={a.defaultPermissionMode} onChange={(e) => setA({ ...a, defaultPermissionMode: e.target.value })}>
              <option value="default">Ask before changes</option>
              <option value="acceptEdits">Auto-accept edits</option>
              <option value="plan">Plan only</option>
            </select>
          )}
        </Field>
        <Field label="Maximum turns per run" hint="Stops runaway runs.">
          {(id) => <input id={id} type="number" min={1} max={500} className="input input-num" value={a.maxTurns} onChange={(e) => setA({ ...a, maxTurns: Number(e.target.value) })} />}
        </Field>
        <Field label="Minutes for one integration tool call" hint="An integration that does not answer in time fails that call instead of holding the run.">
          {(id) => (
            <input
              id={id}
              type="number"
              min={1}
              max={240}
              className="input input-num"
              value={a.mcpToolTimeoutMinutes ?? 10}
              onChange={(e) => setA({ ...a, mcpToolTimeoutMinutes: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Minutes a question or approval waits" hint="Then the agent carries on without it (an approval counts as declined). 0 waits until the run is stopped.">
          {(id) => (
            <input
              id={id}
              type="number"
              min={0}
              max={10080}
              className="input input-num"
              value={a.approvalExpiryMinutes ?? 60}
              onChange={(e) => setA({ ...a, approvalExpiryMinutes: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Agent pushes for new sessions" hint="Only ever to the session's own new branch, never to the base or shared branches. Each session can change it.">
          {(id) => (
            <select id={id} className="input" value={a.defaultPushMode || 'ask'} onChange={(e) => setA({ ...a, defaultPushMode: e.target.value })}>
              {PUSH_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Toggle
        checked={a.resumeAfterRestart !== false}
        onChange={(resumeAfterRestart) => setA({ ...a, resumeAfterRestart })}
        label="Sessions that were running carry on by themselves after the server restarts (within their budget)"
      />
      <Toggle
        checked={Boolean(a.allowReadsOutsideProject)}
        onChange={(allowReadsOutsideProject) => setA({ ...a, allowReadsOutsideProject })}
        label="Let agents read files outside their project folder (off is safer: other projects and the portal's own files stay out of reach)"
      />
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} onClick={() => save({ agents: a })} disabled={JSON.stringify(a) === JSON.stringify(s.agents)}>
        Save defaults
      </Button>
    </section>
  );
}

/** Extra Claude models for the picker, added without a deploy. */
export function ExtraModelsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [text, setText] = useState(s.modelList?.extra ?? '');
  useEffect(() => setText(s.modelList?.extra ?? ''), [s.modelList?.extra]);
  return (
    <section className="panel stack">
      <h2>Extra Claude models</h2>
      <p className="muted small">
        Models for the picker of Claude sessions and runs (Anthropic API or Amazon Bedrock), for example one released after the provider's list was read. One per line: <code>model id | label</code>. The id goes to the provider as written, like <code>global.anthropic.claude-opus-5-5</code> on Bedrock. New runs see them at once.
      </p>
      <textarea className="input mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-label="Extra models" placeholder={'global.anthropic.claude-opus-5-5 | Claude Opus 5.5\nclaude-sonnet-5-5'} />
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} onClick={() => save({ modelList: { extra: text } })} disabled={text === (s.modelList?.extra ?? '')}>
        Save models
      </Button>
    </section>
  );
}

/** Limits for sessions handing tasks to separate sessions. */
export function DelegationSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [d, setD] = useState(s.delegation);
  useEffect(() => setD(s.delegation), [s.delegation]);
  const num = (k, min, max) => (id) => <input id={id} type="number" min={min} max={max} className="input input-num" value={d[k]} onChange={(e) => setD({ ...d, [k]: Number(e.target.value) })} />;
  return (
    <section className="panel stack">
      <h2>Delegated sessions</h2>
      <p className="muted small">A session (its agents, or a person) can hand a task to a separate session with its own working copy and branch. These limits apply to everyone.</p>
      <Toggle checked={d.enabled} onChange={(enabled) => setD({ ...d, enabled })} label="Delegation is on" />
      <div className="row wrap">
        <Field label="Running per session" hint="Delegated sessions one session can have running at once (0–10).">{num('maxPerParent', 0, 10)}</Field>
        <Field label="Running per person" hint="Across all of one person's sessions (0–20).">{num('maxPerUser', 0, 20)}</Field>
        <Field label="Subagent advice" hint="Above this many subagents at once, agents are told to delegate heavy work instead (0: never).">{num('nudgeThreshold', 0, 20)}</Field>
      </div>
      <Toggle checked={d.allowNested} onChange={(allowNested) => setD({ ...d, allowNested })} label="A delegated session may delegate further" />
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} onClick={() => save({ delegation: d })} disabled={JSON.stringify(d) === JSON.stringify(s.delegation)}>
        Save limits
      </Button>
    </section>
  );
}

/**
 * Off by default. The multi-user features (teams, SCIM provisioning, Google sign-in setup) stay in the code and the
 * API; this switch only decides whether the Admin panel offers them.
 */
export function AdvancedSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const advanced = Boolean(s.ui?.advanced);
  return (
    <section className="panel stack">
      <h2>Advanced</h2>
      <p className="muted small">
        Shows the multi-user features in the Admin panel: teams, SCIM provisioning and Google sign-in. Leave this off for a
        small group. Turning it off hides them without removing anything that is already set up.
      </p>
      <Toggle checked={advanced} disabled={busy} onChange={(on) => save({ ui: { advanced: on } }, on ? 'Advanced features shown' : 'Advanced features hidden')} label="Show advanced multi-user features" />
      <ErrorNote error={error} />
    </section>
  );
}
