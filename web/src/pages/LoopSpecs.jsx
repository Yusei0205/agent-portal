/**
 * Loop specs — library + editor for a project.
 *
 * Library: built-in templates + saved specs. Each card shows trigger kind,
 * last-run metrics, and a "Run now" button.
 *
 * Editor: full-featured form with:
 *   - Goal template with variable hints
 *   - Repositories
 *   - Engine / model / lead
 *   - Trigger builder (manual / schedule / webhook / GitHub / Jira)
 *   - Verification pipeline builder (ordered steps, required/optional, advisory LLM judge)
 *   - Stop rules
 *   - Planning gate, escalation, push mode, budget
 *   - Trigger history
 *   - Per-spec metrics
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { cx, money, timeAgo } from '../lib/util.js';
import { go } from '../lib/router.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Note, PageHeader, Spinner, Toggle, useUi } from '../components/ui.jsx';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TRIGGER_LABELS = {
  manual: 'Manual',
  cron: 'Schedule',
  interval: 'Interval',
  webhook: 'Webhook',
  github_event: 'GitHub event',
  jira_event: 'Jira',
};

const TRIGGER_ICONS = {
  manual: 'play',
  cron: 'settings',
  interval: 'settings',
  webhook: 'branch',
  github_event: 'branch',
  jira_event: 'inbox',
};

/** Parse a 5-field cron into human-readable English (best-effort). */
function describeCron(cron = '') {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  if (dom === '*' && dow === '*') {
    if (min === '0' && hour !== '*') return `Daily at ${hour}:00`;
    if (min !== '*' && hour !== '*') return `Daily at ${hour}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && dow !== '*') {
    const dayName = dow.split(',').map((d) => days[parseInt(d)] ?? d).join(', ');
    if (min === '0' && hour !== '*') return `Every ${dayName} at ${hour}:00`;
  }
  return cron;
}

function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v * 100)}%`;
}

function fmtAvgCost(v) {
  if (v === null || v === undefined) return '—';
  return money(v, 3);
}

// ─── Variable hints ────────────────────────────────────────────────────────────

const TEMPLATE_VARS = [
  { v: '{{ticket.key}}', desc: 'Jira ticket key, e.g. PAY-123' },
  { v: '{{ticket.summary}}', desc: 'Jira ticket summary' },
  { v: '{{ticket.description}}', desc: 'Jira ticket description' },
  { v: '{{ticket.status}}', desc: 'Jira ticket status' },
  { v: '{{repo.name}}', desc: 'Repository name' },
  { v: '{{date}}', desc: 'Today\'s date, YYYY-MM-DD' },
  { v: '{{pr.title}}', desc: 'Pull request title (GitHub event)' },
  { v: '{{pr.number}}', desc: 'Pull request number (GitHub event)' },
];

function TemplateVarHints({ onInsert }) {
  return (
    <div className="ls-var-hints">
      <p className="field-hint">Click a variable to insert it into the template:</p>
      <div className="ls-var-chips">
        {TEMPLATE_VARS.map((v) => (
          <button
            key={v.v}
            type="button"
            className="ls-var-chip"
            title={v.desc}
            onClick={() => onInsert(v.v)}
          >
            {v.v}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Trigger builder ──────────────────────────────────────────────────────────

function TriggerBuilder({ kind, config, onKind, onConfig, baseUrl }) {
  const specId = config._specId ?? ''; // set by parent when editing an existing spec

  return (
    <div className="ls-trigger-wrap">
      <Field label="Trigger type">
        {(id) => (
          <div className="segmented" role="tablist" aria-labelledby={id}>
            {Object.entries(TRIGGER_LABELS).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                className={cx(kind === k && 'is-active')}
                onClick={() => onKind(k)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </Field>

      {kind === 'cron' ? (
        <div className="stack-sm">
          <Field label="Cron expression" hint="5-field POSIX cron: minute hour day-of-month month day-of-week">
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder="0 2 * * *"
                value={config.cron ?? ''}
                onChange={(e) => onConfig({ ...config, cron: e.target.value })}
              />
            )}
          </Field>
          {config.cron && (
            <p className="field-hint">
              ↳ <strong>{describeCron(config.cron)}</strong>
            </p>
          )}
          <Field label="Max sessions per hour" hint="Default: 3. Set to 0 for no limit.">
            {(id) => (
              <input
                id={id}
                type="number"
                className="input input-sm"
                min={0}
                max={100}
                value={config.maxPerHour ?? 3}
                onChange={(e) => onConfig({ ...config, maxPerHour: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
      ) : kind === 'interval' ? (
        <div className="stack-sm">
          <Field label="Run every (minutes)">
            {(id) => (
              <input
                id={id}
                type="number"
                className="input input-sm"
                min={1}
                max={1440}
                value={config.intervalMinutes ?? 60}
                onChange={(e) => onConfig({ ...config, intervalMinutes: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
      ) : kind === 'webhook' ? (
        <div className="stack-sm">
          {specId ? (
            <div className="panel stack-sm">
              <Field label="Webhook URL">
                {(id) => (
                  <div className="row tight">
                    <input
                      id={id}
                      className="input"
                      readOnly
                      value={`${baseUrl}/api/loop-specs/${specId}/webhook`}
                    />
                    <CopyBtn value={`${baseUrl}/api/loop-specs/${specId}/webhook`} />
                  </div>
                )}
              </Field>
              <Field label="Webhook secret (HMAC)">
                {(id) => (
                  <div className="row tight">
                    <input
                      id={id}
                      className="input input-mono"
                      readOnly
                      value={config.secret ?? '(generated on save)'}
                    />
                    {config.secret && <CopyBtn value={config.secret} />}
                  </div>
                )}
              </Field>
              <Note tone="info">
                Sign your requests with <code>X-Hub-Signature-256: sha256=HMAC_SHA256(secret, body)</code>.
                The body must be valid JSON; its fields are injected as template variables.
              </Note>
            </div>
          ) : (
            <Note tone="info">Save the spec first to get the webhook URL and secret.</Note>
          )}
          <Field label="Max sessions per hour" hint="Default: 3.">
            {(id) => (
              <input
                id={id}
                type="number"
                className="input input-sm"
                min={0}
                max={100}
                value={config.maxPerHour ?? 3}
                onChange={(e) => onConfig({ ...config, maxPerHour: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
      ) : kind === 'github_event' ? (
        <div className="stack-sm">
          {specId ? (
            <div className="panel stack-sm">
              <Field label="GitHub webhook URL">
                {(id) => (
                  <div className="row tight">
                    <input
                      id={id}
                      className="input"
                      readOnly
                      value={`${baseUrl}/api/loop-specs/${specId}/github`}
                    />
                    <CopyBtn value={`${baseUrl}/api/loop-specs/${specId}/github`} />
                  </div>
                )}
              </Field>
              <Field label="Webhook secret">
                {(id) => (
                  <div className="row tight">
                    <input
                      id={id}
                      className="input input-mono"
                      readOnly
                      value={config.secret ?? '(generated on save)'}
                    />
                    {config.secret && <CopyBtn value={config.secret} />}
                  </div>
                )}
              </Field>
              <details className="panel">
                <summary className="small">GitHub setup instructions</summary>
                <ol className="ls-webhook-steps">
                  <li>Go to your GitHub repository → Settings → Webhooks → Add webhook.</li>
                  <li>Paste the URL above into <em>Payload URL</em>.</li>
                  <li>Set <em>Content type</em> to <code>application/json</code>.</li>
                  <li>Paste the secret above into <em>Secret</em>.</li>
                  <li>Choose <em>Let me select individual events</em> and tick <strong>Pull requests</strong>, <strong>Workflow runs</strong>.</li>
                  <li>Click <em>Add webhook</em>.</li>
                </ol>
              </details>
            </div>
          ) : (
            <Note tone="info">Save the spec first to get the GitHub webhook URL and secret.</Note>
          )}
        </div>
      ) : kind === 'jira_event' ? (
        <div className="stack-sm">
          <Field label="Status name to watch" hint='e.g. "In Progress". The portal polls Jira every 5 minutes for tickets entering this status.'>
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder="In Progress"
                value={config.statusName ?? ''}
                onChange={(e) => onConfig({ ...config, statusName: e.target.value })}
              />
            )}
          </Field>
          <Field label="JQL filter (advanced, overrides status name)" hint="Leave empty to use the status name above.">
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder={`project = MY-PROJECT AND status = "In Progress"`}
                value={config.jql ?? ''}
                onChange={(e) => onConfig({ ...config, jql: e.target.value })}
              />
            )}
          </Field>
          <Field label="Max sessions per hour" hint="Default: 3.">
            {(id) => (
              <input
                id={id}
                type="number"
                className="input input-sm"
                min={0}
                max={100}
                value={config.maxPerHour ?? 3}
                onChange={(e) => onConfig({ ...config, maxPerHour: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
      ) : /* manual */ (
        <Note tone="info">This spec starts only when you click "Run now" or choose it in the session launcher.</Note>
      )}
    </div>
  );
}

function CopyBtn({ value }) {
  const { toast } = useUi();
  return (
    <Button
      size="sm"
      icon="copy"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => toast('Copied to clipboard', 'ok')).catch(() => toast('Copy failed — select and copy manually', 'warn'));
      }}
      aria-label="Copy to clipboard"
    />
  );
}

// ─── Verification pipeline builder ──────────────────────────────────────────

const EMPTY_STEP = { step: '', cmd: '', timeout: 300, required: true, kind: 'cmd' };

function VerifPipelineBuilder({ steps, onChange }) {
  const addStep = (kind = 'cmd') => onChange([...steps, { ...EMPTY_STEP, kind }]);

  const updateStep = (i, patch) => {
    const next = steps.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    onChange(next);
  };

  const removeStep = (i) => onChange(steps.filter((_, idx) => idx !== i));

  const move = (i, dir) => {
    const next = [...steps];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="ls-pipeline">
      {steps.length === 0 ? (
        <p className="muted small">No steps. Add a command or an LLM judge below.</p>
      ) : (
        steps.map((s, i) => (
          <div key={i} className="ls-step">
            <div className="ls-step-drag" role="presentation">
              <button type="button" className="icon-btn" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className="icon-btn" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
            </div>
            <div className="ls-step-body">
              <div className="row tight">
                <Field label="Step name">
                  {(id) => (
                    <input
                      id={id}
                      className="input input-sm"
                      placeholder="lint"
                      value={s.step}
                      onChange={(e) => updateStep(i, { step: e.target.value })}
                    />
                  )}
                </Field>
                <div className="field">
                  <label className="field-label">Kind</label>
                  <select
                    className="input input-sm"
                    value={s.kind ?? 'cmd'}
                    onChange={(e) => updateStep(i, { kind: e.target.value })}
                    aria-label="Step kind"
                  >
                    <option value="cmd">Command</option>
                    <option value="llm">LLM judge (advisory)</option>
                  </select>
                </div>
              </div>
              {s.kind === 'llm' ? (
                <>
                  <Note tone="info" icon="alert">
                    The LLM judge is <strong>advisory only</strong> — its result is shown to you but never automatically fails the pipeline or blocks the session. Use it for qualitative checks that cannot be scripted.
                  </Note>
                  <Field label="Evaluation rubric">
                    {(id) => (
                      <textarea
                        id={id}
                        className="input"
                        rows={3}
                        placeholder="Does the code follow the project style guide? Are error paths handled?"
                        value={s.rubric ?? ''}
                        onChange={(e) => updateStep(i, { rubric: e.target.value })}
                      />
                    )}
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Shell command">
                    {(id) => (
                      <input
                        id={id}
                        className="input input-sm input-mono"
                        placeholder="npm test"
                        value={s.cmd ?? ''}
                        onChange={(e) => updateStep(i, { cmd: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="row tight">
                    <Field label="Timeout (sec)">
                      {(id) => (
                        <input
                          id={id}
                          type="number"
                          className="input input-sm"
                          min={5}
                          max={3600}
                          value={s.timeout ?? 300}
                          onChange={(e) => updateStep(i, { timeout: Number(e.target.value) })}
                        />
                      )}
                    </Field>
                    <div className="field">
                      <label className="field-label">Stop on fail</label>
                      <Toggle
                        checked={s.required !== false}
                        onChange={(v) => updateStep(i, { required: v })}
                        label={s.required !== false ? 'Yes — stop pipeline' : 'No — continue'}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            <button type="button" className="icon-btn ls-step-remove" aria-label="Remove step" onClick={() => removeStep(i)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))
      )}
      <div className="row tight">
        <Button size="sm" onClick={() => addStep('cmd')}>+ Add command step</Button>
        <Button size="sm" variant="ghost" onClick={() => addStep('llm')}>+ Add LLM judge (advisory)</Button>
      </div>
    </div>
  );
}

// ─── Stop rules ───────────────────────────────────────────────────────────────

function StopRulesEditor({ rules, onChange }) {
  return (
    <div className="stack-sm">
      <div className="row tight wrap">
        <Field label="Max iterations" hint="Maximum loop iterations per burst.">
          {(id) => (
            <input
              id={id}
              type="number"
              className="input input-sm"
              min={1}
              max={50}
              value={rules.maxIterations ?? 10}
              onChange={(e) => onChange({ ...rules, maxIterations: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Budget (USD)" hint="Per-session spending cap.">
          {(id) => (
            <input
              id={id}
              type="number"
              className="input input-sm"
              min={0.1}
              max={1000}
              step={0.5}
              value={rules.budgetUsd ?? ''}
              placeholder="From project default"
              onChange={(e) => onChange({ ...rules, budgetUsd: e.target.value ? Number(e.target.value) : undefined })}
            />
          )}
        </Field>
        <Field label="Stagnation window" hint="Stop after N iterations with the same summary.">
          {(id) => (
            <input
              id={id}
              type="number"
              className="input input-sm"
              min={1}
              max={10}
              value={rules.stagnationWindow ?? 3}
              onChange={(e) => onChange({ ...rules, stagnationWindow: Number(e.target.value) })}
            />
          )}
        </Field>
        <Field label="Max consecutive failures">
          {(id) => (
            <input
              id={id}
              type="number"
              className="input input-sm"
              min={1}
              max={10}
              value={rules.maxConsecutiveFailures ?? 2}
              onChange={(e) => onChange({ ...rules, maxConsecutiveFailures: Number(e.target.value) })}
            />
          )}
        </Field>
      </div>
      <Toggle
        checked={rules.requireVerification !== false}
        onChange={(v) => onChange({ ...rules, requireVerification: v })}
        label="Require all required verification steps to pass before accepting 'done'"
      />
    </div>
  );
}

// ─── Full spec editor form ────────────────────────────────────────────────────

const PUSH_MODES = [
  { value: '', label: 'From project settings' },
  { value: 'never', label: 'Never — agents cannot push' },
  { value: 'ask', label: 'Ask me before pushing' },
  { value: 'auto', label: 'Auto-push without asking' },
];

function blankSpec() {
  return {
    name: '',
    description: '',
    trigger_kind: 'manual',
    trigger_config: { maxPerHour: 3 },
    goal_template: '',
    verification: [],
    stop_rules: { maxIterations: 10, stagnationWindow: 3, requireVerification: true },
    memory_config: { progressFile: true, maxEntries: 20 },
    escalation: { onBlocked: true, onFail: true, webhook: false },
    push_mode: '',
    trust_tools: 0,
    lead_agent: '',
    engine: '',
    monthly_budget_usd: '',
    planning_gate: false,
  };
}

function SpecEditor({ spec, projectId, onSaved, onCancel }) {
  const { toast } = useUi();
  const [form, setForm] = useState(() => spec ? {
    name: spec.name,
    description: spec.description ?? '',
    trigger_kind: spec.trigger_kind,
    trigger_config: { ...spec.trigger_config, _specId: spec.id },
    goal_template: spec.goal_template,
    verification: spec.verification ?? [],
    stop_rules: spec.stop_rules ?? {},
    memory_config: spec.memory_config ?? {},
    escalation: spec.escalation ?? {},
    push_mode: spec.push_mode ?? '',
    trust_tools: spec.trust_tools ?? 0,
    lead_agent: spec.lead_agent ?? '',
    engine: spec.engine ?? '',
    monthly_budget_usd: spec.monthly_budget_usd ?? '',
    planning_gate: Boolean(spec.planning_gate),
  } : blankSpec());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [history, setHistory] = useState(null);
  const [advOpen, setAdvOpen] = useState(false);

  const baseUrl = window.location.origin;

  useEffect(() => {
    if (!spec?.id) return;
    api.get(`/api/projects/${projectId}/loop-specs/${spec.id}/metrics`).then(setMetrics).catch(() => {});
    api.get(`/api/projects/${projectId}/loop-specs/${spec.id}/trigger-history`).then((r) => setHistory(r.history)).catch(() => {});
  }, [spec?.id, projectId]);

  const goalRef = useRef(null);
  const insertVar = (v) => {
    const el = goalRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + v + el.value.slice(end);
    setForm((f) => ({ ...f, goal_template: next }));
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + v.length, start + v.length);
    }, 0);
  };

  const save = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        triggerKind: form.trigger_kind,
        triggerConfig: { ...form.trigger_config },
        goalTemplate: form.goal_template,
        verification: form.verification,
        stopRules: form.stop_rules,
        memoryConfig: form.memory_config,
        escalation: form.escalation,
        pushMode: form.push_mode || null,
        trustTools: Number(form.trust_tools),
        leadAgent: form.lead_agent || null,
        engine: form.engine || null,
        monthlyBudgetUsd: form.monthly_budget_usd ? Number(form.monthly_budget_usd) : null,
        planningGate: form.planning_gate ? 1 : 0,
      };
      // Remove the internal _specId from triggerConfig before sending
      delete payload.triggerConfig._specId;

      if (spec?.id) {
        await api.patch(`/api/projects/${projectId}/loop-specs/${spec.id}`, payload);
        toast('Spec saved', 'ok');
      } else {
        await api.post(`/api/projects/${projectId}/loop-specs`, payload);
        toast('Spec created', 'ok');
      }
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!spec?.id) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/loop-specs/${spec.id}/run`, {});
      toast('Session started', 'ok');
      go(projectId, 'sessions');
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ls-editor" onSubmit={save} noValidate>
      <div className="ls-editor-head">
        <h2>{spec ? 'Edit loop spec' : 'New loop spec'}</h2>
        <div className="row tight">
          {spec?.id ? <Button type="button" variant="ghost" size="sm" onClick={runNow} busy={busy}>▶ Run now</Button> : null}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" size="sm" busy={busy}>Save spec</Button>
        </div>
      </div>

      <ErrorNote error={error} onClose={() => setError(null)} />

      <div className="stack-lg">
        {/* Basic info */}
        <section className="ls-section">
          <h3 className="ls-section-title">Name and description</h3>
          <Field label="Spec name" error={!form.name.trim() && busy ? 'Name is required' : undefined}>
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder="Feature branch loop"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            )}
          </Field>
          <Field label="Description (optional)">
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder="What does this spec do?"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            )}
          </Field>
        </section>

        {/* Goal template */}
        <section className="ls-section">
          <h3 className="ls-section-title">Goal template</h3>
          <Field label="Goal template" hint="Use {{variable}} placeholders. The agent sees the filled template as its goal.">
            {(id) => (
              <textarea
                id={id}
                ref={goalRef}
                className="input ls-goal-textarea"
                rows={6}
                placeholder="Implement {{ticket.summary}} ({{ticket.key}}) in {{repo.name}}."
                value={form.goal_template}
                onChange={(e) => setForm((f) => ({ ...f, goal_template: e.target.value }))}
              />
            )}
          </Field>
          <TemplateVarHints onInsert={insertVar} />
        </section>

        {/* Trigger */}
        <section className="ls-section">
          <h3 className="ls-section-title">Trigger</h3>
          <TriggerBuilder
            kind={form.trigger_kind}
            config={form.trigger_config}
            onKind={(k) => setForm((f) => ({ ...f, trigger_kind: k }))}
            onConfig={(c) => setForm((f) => ({ ...f, trigger_config: c }))}
            baseUrl={baseUrl}
          />
        </section>

        {/* Verification pipeline */}
        <section className="ls-section">
          <h3 className="ls-section-title">Verification pipeline</h3>
          <p className="field-hint">Run after each iteration. Pass/fail determines whether the agent carries on.</p>
          <VerifPipelineBuilder
            steps={form.verification}
            onChange={(v) => setForm((f) => ({ ...f, verification: v }))}
          />
        </section>

        {/* Stop rules */}
        <section className="ls-section">
          <h3 className="ls-section-title">Stop rules</h3>
          <StopRulesEditor
            rules={form.stop_rules}
            onChange={(r) => setForm((f) => ({ ...f, stop_rules: r }))}
          />
        </section>

        {/* Advanced (collapsed by default) */}
        <section className="ls-section">
          <button
            type="button"
            className="ls-adv-toggle"
            aria-expanded={advOpen}
            onClick={() => setAdvOpen((v) => !v)}
          >
            <Icon name={advOpen ? 'chevronDown' : 'chevronRight'} size={14} />
            {advOpen ? 'Hide' : 'Show'} advanced settings
          </button>

          {advOpen ? (
            <div className="stack-lg ls-advanced">
              {/* Planning gate */}
              <div className="field">
                <Toggle
                  checked={form.planning_gate}
                  onChange={(v) => setForm((f) => ({ ...f, planning_gate: v }))}
                  label="Require plan approval — pause after the first planning iteration and wait for a human to approve before continuing"
                />
              </div>

              {/* Push mode */}
              <Field label="Agent push mode">
                {(id) => (
                  <select
                    id={id}
                    className="input"
                    value={form.push_mode ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, push_mode: e.target.value }))}
                  >
                    {PUSH_MODES.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                )}
              </Field>

              {/* Memory config */}
              <div className="stack-sm">
                <label className="field-label">Memory</label>
                <Toggle
                  checked={form.memory_config.progressFile !== false}
                  onChange={(v) => setForm((f) => ({ ...f, memory_config: { ...f.memory_config, progressFile: v } }))}
                  label="Write per-iteration summaries to a progress file"
                />
                <Toggle
                  checked={Boolean(form.memory_config.appendDecisions)}
                  onChange={(v) => setForm((f) => ({ ...f, memory_config: { ...f.memory_config, appendDecisions: v } }))}
                  label="Append agent answers to the project decisions log"
                />
              </div>

              {/* Escalation */}
              <div className="stack-sm">
                <label className="field-label">Escalation</label>
                <Toggle
                  checked={form.escalation.onBlocked !== false}
                  onChange={(v) => setForm((f) => ({ ...f, escalation: { ...f.escalation, onBlocked: v } }))}
                  label="Create an Inbox item when the session is blocked"
                />
                <Toggle
                  checked={form.escalation.onFail !== false}
                  onChange={(v) => setForm((f) => ({ ...f, escalation: { ...f.escalation, onFail: v } }))}
                  label="Create an Inbox item when the session fails"
                />
                <Toggle
                  checked={Boolean(form.escalation.webhook)}
                  onChange={(v) => setForm((f) => ({ ...f, escalation: { ...f.escalation, webhook: v } }))}
                  label="Fire outbound webhook on escalation"
                />
              </div>

              {/* Budget override */}
              <Field label="Monthly budget (USD, overrides project default)">
                {(id) => (
                  <input
                    id={id}
                    type="number"
                    className="input input-sm"
                    min={0}
                    step={1}
                    value={form.monthly_budget_usd ?? ''}
                    placeholder="Leave empty to use project default"
                    onChange={(e) => setForm((f) => ({ ...f, monthly_budget_usd: e.target.value }))}
                  />
                )}
              </Field>
            </div>
          ) : null}
        </section>

        {/* Trigger history */}
        {spec?.id && history ? (
          <section className="ls-section">
            <h3 className="ls-section-title">Trigger history</h3>
            {history.length === 0 ? (
              <p className="muted small">No triggers fired yet.</p>
            ) : (
              <table className="table" aria-label="Trigger history">
                <thead>
                  <tr>
                    <th>Fired</th>
                    <th>Kind</th>
                    <th>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 20).map((h, i) => (
                    <tr key={i}>
                      <td className="small muted">{timeAgo(h.fired_at)}</td>
                      <td><Badge status={h.kind}>{h.kind}</Badge></td>
                      <td>
                        {h.workflow_id ? (
                          <a href={`#/p/${projectId}/sessions/${h.workflow_id}`} className="small">
                            {h.workflow_id.slice(0, 8)}…
                          </a>
                        ) : <span className="muted small">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ) : null}

        {/* Per-spec metrics */}
        {spec?.id && metrics ? (
          <section className="ls-section">
            <h3 className="ls-section-title">Metrics (last 30 days)</h3>
            <div className="row tight wrap ls-metrics">
              <div className="ls-metric">
                <span className="ls-metric-val">{metrics.total ?? 0}</span>
                <span className="ls-metric-label">runs</span>
              </div>
              <div className="ls-metric">
                <span className="ls-metric-val">{fmtPct(metrics.success_rate)}</span>
                <span className="ls-metric-label">success rate</span>
              </div>
              <div className="ls-metric">
                <span className="ls-metric-val">{fmtPct(metrics.autonomy_rate)}</span>
                <span className="ls-metric-label">autonomy rate</span>
              </div>
              <div className="ls-metric">
                <span className="ls-metric-val">{fmtAvgCost(metrics.avg_cost_usd)}</span>
                <span className="ls-metric-label">avg cost / done</span>
              </div>
              <div className="ls-metric">
                <span className="ls-metric-val">{metrics.avg_iterations ? metrics.avg_iterations.toFixed(1) : '—'}</span>
                <span className="ls-metric-label">avg iterations</span>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </form>
  );
}

// ─── Spec card in the library ─────────────────────────────────────────────────

function SpecCard({ spec, projectId, onEdit, onDelete, onRunNow }) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState('');

  const del = async () => {
    if (!(await confirm({ title: 'Delete spec', message: `Delete "${spec.name}"? This will not affect running sessions.`, confirmLabel: 'Delete', danger: true }))) return;
    setBusy('del');
    try {
      await api.del(`/api/projects/${projectId}/loop-specs/${spec.id}`);
      onDelete();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };

  const run = async () => {
    setBusy('run');
    try {
      await api.post(`/api/projects/${projectId}/loop-specs/${spec.id}/run`, {});
      toast('Session started', 'ok');
      go(projectId, 'sessions');
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="ls-card" role="article">
      <div className="ls-card-head">
        <div className="ls-card-title">
          {spec.is_template ? <Badge tone="muted">Template</Badge> : null}
          <h3>{spec.name}</h3>
        </div>
        <div className="ls-card-trigger">
          <Icon name={TRIGGER_ICONS[spec.trigger_kind] ?? 'play'} size={14} />
          <span>{TRIGGER_LABELS[spec.trigger_kind] ?? spec.trigger_kind}</span>
          {spec.trigger_kind === 'cron' && spec.trigger_config?.cron ? (
            <span className="muted small">· {describeCron(spec.trigger_config.cron)}</span>
          ) : null}
        </div>
      </div>
      {spec.description ? <p className="ls-card-desc muted small">{spec.description}</p> : null}
      <div className="ls-card-foot">
        <div className="row tight">
          <Button size="sm" onClick={run} busy={busy === 'run'} icon="play">Run now</Button>
          {!spec.is_template ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => onEdit(spec)}>Edit</Button>
              <Button size="sm" variant="danger" busy={busy === 'del'} onClick={del}>Delete</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onEdit({ ...spec, id: null, name: `${spec.name} (copy)`, is_template: 0 })}>Customise</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function LoopSpecs() {
  const { project } = useProject();
  const [specs, setSpecs] = useState(null);
  const [editing, setEditing] = useState(null); // null = list, false = new, spec obj = editing
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { toast } = useUi();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/api/projects/${project.id}/loop-specs`);
      setSpecs(r.specs);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  const seed = async () => {
    try {
      const r = await api.post(`/api/projects/${project.id}/loop-specs/seed`, {});
      if (r.created?.length) toast(`Added ${r.created.length} template(s)`, 'ok');
      else toast('Built-in templates already added', 'info');
      load();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  if (editing !== null) {
    return (
      <div className="page-wrap">
        <SpecEditor
          spec={editing || null}
          projectId={project.id}
          onSaved={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="page-wrap">
      <PageHeader
        title="Loop specs"
        sub="Reusable configurations that run sessions automatically"
        actions={
          <div className="row tight">
            <Button variant="ghost" size="sm" onClick={seed}>Add built-in templates</Button>
            <Button variant="primary" size="sm" onClick={() => setEditing(false)}>New spec</Button>
          </div>
        }
      />

      {loading ? (
        <div className="pad"><Spinner /></div>
      ) : error ? (
        <ErrorNote error={error} onClose={() => setError(null)} />
      ) : !specs?.length ? (
        <Empty icon="settings" title="No loop specs yet">
          <p>Loop specs let sessions run automatically from a schedule, webhook, or Jira status change.</p>
          <div className="row tight">
            <Button variant="primary" onClick={() => setEditing(false)}>Create a spec</Button>
            <Button variant="ghost" onClick={seed}>Add built-in templates</Button>
          </div>
        </Empty>
      ) : (
        <div className="ls-library">
          {specs.map((spec) => (
            <SpecCard
              key={spec.id}
              spec={spec}
              projectId={project.id}
              onEdit={setEditing}
              onDelete={load}
              onRunNow={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}
