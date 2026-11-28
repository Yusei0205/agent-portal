import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { formatRelative } from '../../lib/util.js';
import { Icon } from '../../components/Icon.jsx';

const STATUSES = [
  { id: 'new', label: 'New', tone: 'info' },
  { id: 'triaged', label: 'Triaged', tone: 'info' },
  { id: 'fixing', label: 'Fixing', tone: 'warn' },
  { id: 'pr_open', label: 'PR open', tone: 'ok' },
  { id: 'resolved', label: 'Resolved', tone: 'ok' },
  { id: 'dismissed', label: 'Dismissed', tone: 'muted' },
  { id: 'suppressed', label: 'Suppressed', tone: 'muted' },
  { id: 'needs_human', label: 'Needs a person', tone: 'danger' },
];
const BY_ID = Object.fromEntries(STATUSES.map((s) => [s.id, s]));

function StatusPill({ status }) {
  const s = BY_ID[status] || { label: status, tone: 'muted' };
  return <span className={`af-pill is-${s.tone}`}>{s.label}</span>;
}

// Always part of the protected paths on the server; shown locked here.
const LOCKED_PATHS = ['.github/workflows/**', 'infra/**', '**/.env*', '**/*.pem', 'package-lock.json', '**/package-lock.json'];
const MODES = [
  { id: 'off', label: 'Off', text: 'Failures are not turned into fixes.' },
  { id: 'propose', label: 'Propose', text: 'Fix sessions run; a person approves every pull request in the Inbox.' },
  { id: 'draft_pr', label: 'Draft PR', text: 'Fix sessions run and pull requests are opened as drafts once checks pass.' },
];
const ENGINES = ['demo', 'claude-code', 'kiro', 'codex'];
const LIMIT_FIELDS = [
  ['max_open_prs', 'Open PRs at once', 1],
  ['max_attempts', 'Attempts per finding', 1],
  ['max_cost_per_finding_usd', 'Cost per finding (USD)', 0.5],
  ['max_cost_per_day_usd', 'Cost per day (USD)', 0.5],
  ['cooldown_minutes', 'Cooldown (minutes)', 1],
  ['max_files', 'Max files changed', 1],
  ['max_lines', 'Max lines changed', 1],
];

const lines = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean);
const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

function Field({ id, label, hint, children }) {
  return (
    <div className="field af-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function WebhookPanel({ projectId, canManage, toast }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const url = `${window.location.origin}/api/hooks/autofix/${projectId}`;
  const copy = (text, what) => {
    navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`, 'ok')).catch(() => toast('Could not copy', 'error'));
  };
  const rotate = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${projectId}/autofix/webhook-secret`, {});
      setSecret(r.secret);
    } catch (e) {
      toast(e.message || 'Could not rotate the secret', 'error');
    } finally { setBusy(false); }
  };
  return (
    <section className="af-card" aria-label="GitHub webhook">
      <h3>GitHub webhook</h3>
      <p className="muted small">Add a webhook in the repository settings on GitHub so failed checks reach Auto-fix.</p>
      <Field id="af-hook-url" label="Payload URL">
        <div className="af-copy">
          <input id="af-hook-url" type="text" readOnly value={url} />
          <button type="button" className="btn btn-sm" onClick={() => copy(url, 'URL')}><Icon name="copy" size={14} /> Copy</button>
        </div>
      </Field>
      <p className="small">Content type <code>application/json</code>. Events to enable: <strong>Workflow runs</strong> and <strong>Pull requests</strong>.</p>
      {canManage ? (
        <>
          <button type="button" className="btn btn-sm" onClick={rotate} disabled={busy}>Rotate secret</button>
          {secret && (
            <div className="af-secret" role="status">
              <p className="small"><strong>Copy this secret now.</strong> It is shown once and cannot be read again; paste it into the webhook's Secret field on GitHub. The previous secret stops working.</p>
              <div className="af-copy">
                <input type="text" readOnly value={secret} aria-label="New webhook secret" onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-sm" onClick={() => copy(secret, 'Secret')}><Icon name="copy" size={14} /> Copy</button>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSecret('')}>Hide</button>
            </div>
          )}
        </>
      ) : <p className="muted small">Only a project owner or admin can rotate the secret.</p>}
    </section>
  );
}

function PolicyForm({ projectId, policy, unattended, canManage, isAdmin, currentUserId, members, onSaved, toast }) {
  const [d, setD] = useState(() => structuredClone(policy));
  const [classInput, setClassInput] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [extraText, setExtraText] = useState(policy.branches.extra.join('\n'));
  const [quickText, setQuickText] = useState(policy.verify.quick_commands.join('\n'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ro = !canManage;
  const set = (patch) => setD((cur) => ({ ...cur, ...patch }));
  const extraPaths = d.protected_paths.filter((p) => !LOCKED_PATHS.includes(p));

  const addClass = () => {
    const c = classInput.trim();
    if (c && !d.classes.includes(c)) set({ classes: [...d.classes, c] });
    setClassInput('');
  };
  const addPath = () => {
    const p = pathInput.trim();
    if (p && !d.protected_paths.includes(p)) set({ protected_paths: [...d.protected_paths, p] });
    setPathInput('');
  };

  const runAsChoices = (members || []).filter((m) => ['editor', 'owner'].includes(String(m.access)) && (isAdmin || m.user_id === currentUserId));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    const body = {
      mode: d.mode, classes: d.classes,
      branches: { ...d.branches, extra: lines(extraText) },
      protected_paths: d.protected_paths,
      limits: Object.fromEntries(Object.keys(d.limits).map((k) => [k, Number(d.limits[k])])),
      verify: { command: d.verify.command, quick_commands: lines(quickText) },
      engine: d.engine,
    };
    if (d.run_as && d.run_as !== policy.run_as) body.run_as = d.run_as;
    try {
      const r = await api.put(`/api/projects/${projectId}/autofix/policy`, body);
      onSaved(r.policy);
      setD(structuredClone(r.policy));
      toast('Auto-fix policy saved', 'ok');
    } catch (err) {
      setError(err.message || 'Could not save the policy');
    } finally { setBusy(false); }
  };

  return (
    <form className="af-card af-form" onSubmit={save} data-testid="autofix-policy-form" aria-label="Auto-fix policy">
      <h3>Policy</h3>
      {ro && <p className="muted small">Only a project owner or admin can change the policy.</p>}
      <fieldset disabled={ro || busy} className="af-fieldset">
        <h4 className="af-legend">Mode</h4>
        <div className="af-modes" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <label key={m.id} className={`af-mode${d.mode === m.id ? ' is-on' : ''}`}>
              <input type="radio" name="af-mode" value={m.id} checked={d.mode === m.id} onChange={() => set({ mode: m.id })} />
              <span><strong>{m.label}</strong><span className="af-mode-text">{m.text}</span></span>
            </label>
          ))}
        </div>
        {d.mode === 'draft_pr' && (
          <div className="af-warn" role="note" data-testid="autofix-draftpr-notice">
            <strong>Before you use Draft PR</strong>
            <p>By default a person approves each push in the Inbox. A push without approval only happens when the portal operator sets <code>AUTOFIX_ALLOW_UNATTENDED_PUSH=1</code>, and that is safe only with redeployed runners, a repository ruleset restricting pushes to <code>.github/workflows/**</code>, <code>infra/**</code> and tags, and agent processes isolated from the push credentials.</p>
            <p>{unattended ? 'This portal has unattended push enabled: pushes that pass the checks go ahead without approval.' : 'This portal does not have unattended push enabled: every push still waits for approval in the Inbox.'}</p>
          </div>
        )}

        <h4 className="af-legend">Finding kinds to fix</h4>
        <ul className="af-chips" aria-label="Kinds">
          {d.classes.map((c) => (
            <li key={c} className="af-chip">{c}
              {!ro && <button type="button" aria-label={`Remove ${c}`} onClick={() => set({ classes: d.classes.filter((x) => x !== c) })}>×</button>}
            </li>
          ))}
          {d.classes.length === 0 && <li className="muted small">No kinds: nothing is fixed.</li>}
        </ul>
        <div className="af-copy">
          <input type="text" value={classInput} onChange={(e) => setClassInput(e.target.value)} placeholder="Add a kind, for example lint" aria-label="New kind"
            maxLength={40} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addClass(); } }} />
          <button type="button" className="btn btn-sm" onClick={addClass}>Add</button>
        </div>

        <h4 className="af-legend">Branches</h4>
        <label className="af-check"><input type="checkbox" checked={d.branches.default_branch} onChange={(e) => set({ branches: { ...d.branches, default_branch: e.target.checked } })} /> Default branch</label>
        <label className="af-check"><input type="checkbox" checked={d.branches.portal_prs} onChange={(e) => set({ branches: { ...d.branches, portal_prs: e.target.checked } })} /> Pull requests opened by the portal</label>
        <Field id="af-extra" label="Extra branch patterns" hint="One pattern per line, for example release/*">
          <textarea id="af-extra" rows={2} value={extraText} onChange={(e) => setExtraText(e.target.value)} />
        </Field>

        <h4 className="af-legend">Protected paths</h4>
        <ul className="af-paths" aria-label="Protected paths">
          {LOCKED_PATHS.map((p) => <li key={p} className="af-path is-locked"><code>{p}</code><span className="muted small">always protected</span></li>)}
          {extraPaths.map((p) => (
            <li key={p} className="af-path"><code>{p}</code>
              {!ro && <button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${p}`} onClick={() => set({ protected_paths: d.protected_paths.filter((x) => x !== p) })}>Remove</button>}
            </li>
          ))}
        </ul>
        <div className="af-copy">
          <input type="text" value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder="Add a pattern, for example secrets/**" aria-label="New protected path"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPath(); } }} />
          <button type="button" className="btn btn-sm" onClick={addPath}>Add</button>
        </div>
        <p className="field-hint">Supported glob syntax: <code>*</code>, <code>**</code> and <code>?</code> only. Braces and brackets are rejected.</p>

        <h4 className="af-legend">Limits</h4>
        <div className="af-grid">
          {LIMIT_FIELDS.map(([k, label, step]) => (
            <Field key={k} id={`af-lim-${k}`} label={label}>
              <input id={`af-lim-${k}`} type="number" min={step} step={step} inputMode="decimal" value={d.limits[k]}
                onChange={(e) => set({ limits: { ...d.limits, [k]: e.target.value } })} />
            </Field>
          ))}
        </div>

        <h4 className="af-legend">Checks</h4>
        <Field id="af-verify" label="Verify command" hint="Required before Auto-fix can be turned on. Runs in the repository to check a fix.">
          <input id="af-verify" type="text" value={d.verify.command} placeholder="npm test" onChange={(e) => set({ verify: { ...d.verify, command: e.target.value } })} />
        </Field>
        <Field id="af-quick" label="Quick commands" hint="One per line; run before the verify command.">
          <textarea id="af-quick" rows={2} value={quickText} onChange={(e) => setQuickText(e.target.value)} />
        </Field>

        <h4 className="af-legend">Who runs fixes</h4>
        <div className="af-grid">
          <Field id="af-engine" label="Engine">
            <select id="af-engine" value={d.engine} onChange={(e) => set({ engine: e.target.value })}>
              {ENGINES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Field>
          <Field id="af-runas" label="Run fix sessions as" hint={d.run_as ? '' : 'Set to you when Auto-fix is first turned on, if you are a project editor or owner.'}>
            <select id="af-runas" value={d.run_as} onChange={(e) => set({ run_as: e.target.value })}>
              {!d.run_as && <option value="">Not set yet</option>}
              {d.run_as && !runAsChoices.some((m) => m.user_id === d.run_as) && <option value={d.run_as}>{(members || []).find((m) => m.user_id === d.run_as)?.name || d.run_as}</option>}
              {runAsChoices.map((m) => <option key={m.user_id} value={m.user_id}>{m.name || m.email} ({m.access})</option>)}
            </select>
          </Field>
        </div>
      </fieldset>
      {error && <div className="error-note" role="alert" data-testid="autofix-policy-error">{error}</div>}
      {!ro && <div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button></div>}
    </form>
  );
}

function PausePanel({ projectId, paused, pausedGlobal, canManage, requestConfirm, onChange, toast }) {
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    const next = !paused;
    const ok = await requestConfirm(
      next ? 'Pause Auto-fix for this project? No new fix sessions start until it is resumed.' : 'Resume Auto-fix for this project?',
      next ? 'Pause' : 'Resume', next ? 'danger' : 'primary');
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/autofix/pause`, { paused: next });
      onChange(next);
      toast(next ? 'Auto-fix paused' : 'Auto-fix resumed', 'ok');
    } catch (e) { toast(e.message || 'Could not change the pause', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className="af-card" aria-label="Pause">
      <h3>Pause</h3>
      <p className="small">{paused ? <span className="af-pill is-warn">Paused</span> : <span className="af-pill is-ok">Running</span>}{' '}
        {pausedGlobal && <span className="muted">Auto-fix is also paused for the whole portal.</span>}</p>
      {canManage
        ? <button type="button" className="btn btn-sm" role="switch" aria-checked={paused} onClick={flip} disabled={busy}>{paused ? 'Resume Auto-fix' : 'Pause Auto-fix'}</button>
        : <p className="muted small">Only a project owner or admin can pause.</p>}
    </section>
  );
}

function FindingDetail({ projectId, f }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/autofix/findings/${f.id}`)
      .then((r) => { if (live) setDetail(r.finding); })
      .catch((e) => { if (live) setErr(e.message || 'Could not load the finding'); });
    return () => { live = false; };
  }, [projectId, f.id]);
  return (
    <div className="af-detail">
      <dl className="af-dl">
        <dt>Attempts</dt><dd>{f.attempts}</dd>
        <dt>Cooldown</dt><dd>{f.cooldown_until ? `until ${new Date(f.cooldown_until).toLocaleString()}` : 'none'}</dd>
        <dt>Commit</dt><dd>{f.commit_sha ? <code>{String(f.commit_sha).slice(0, 12)}</code> : 'none'}</dd>
        <dt>Source</dt><dd>{f.source}</dd>
        <dt>Session</dt><dd>{f.workflow_id ? <a href={`#/p/${projectId}/sessions/${f.workflow_id}`}>Open session</a> : 'none'}</dd>
        <dt>Pull request</dt><dd>{isHttpUrl(f.pr_url) ? <a href={f.pr_url} target="_blank" rel="noreferrer">{f.pr_number ? `#${f.pr_number}` : 'Open'}</a> : (f.pr_number ? `#${f.pr_number}` : 'none')}</dd>
      </dl>
      <h4>Evidence</h4>
      {err ? <p className="error-note" role="alert">{err}</p>
        : !detail ? <p className="muted small">Loading…</p>
          : <pre className="af-evidence">{detail.evidence || 'No evidence recorded.'}</pre>}
    </div>
  );
}

/** A project's Auto-fix tab: the policy (editable by an owner or admin), the pause, the webhook and the findings with their actions. */
export function AutoFix({ projectId, canManage = false, isAdmin = false, currentUserId = '', members = [], requestConfirm = async () => true, toast = () => {} }) {
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState('');
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/autofix/policy`)
      .then((r) => { if (live) setMeta(r); })
      .catch(() => { if (live) setMeta(null); });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    let live = true;
    setError(null);
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    api.get(`/api/projects/${projectId}/autofix/findings${q}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setError(e.message || 'Failed to load findings'); });
    return () => { live = false; };
  }, [projectId, status, reload]);

  const act = useCallback(async (f, action, done, confirmText) => {
    if (confirmText && !await requestConfirm(confirmText, 'Never fix', 'danger')) return;
    setBusyId(f.id);
    try {
      const r = await api.post(`/api/projects/${projectId}/autofix/findings/${f.id}/${action}`, {});
      toast(done, 'ok');
      if (action === 'never-fix' && r.classes) setMeta((m) => (m ? { ...m, policy: { ...m.policy, classes: r.classes } } : m));
      setReload((n) => n + 1);
    } catch (e) { toast(e.message || 'Action failed', 'error'); }
    finally { setBusyId(''); }
  }, [projectId, requestConfirm, toast]);

  if (error) return <div className="error-note" role="alert">{error}</div>;
  if (!data) return <div className="spinner-wrap"><div className="spinner" aria-label="Loading…" /></div>;

  const policy = meta?.policy;
  const counts = data.counts || {};
  return (
    <div className="af-root" data-testid="autofix-tab">
      {policy?.mode === 'off' && (
        <p className="af-notice" role="status">
          <strong>Auto-fix is off for this project.</strong> Failures are not being turned into findings or fixes. Findings recorded earlier are shown below.
        </p>
      )}
      <ul className="af-counts" aria-label="Findings by status">
        {STATUSES.map((s) => (
          <li key={s.id} className="af-count">
            <span className="af-count-n">{counts[s.id] ?? 0}</span>
            <StatusPill status={s.id} />
          </li>
        ))}
      </ul>
      <div className="af-filter">
        <label htmlFor="af-status">Status</label>
        <select id="af-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {data.findings.length === 0 ? (
        <p className="muted">No findings{status ? ' with this status' : ' yet'}.</p>
      ) : (
        <div className="af-table-wrap">
          <table className="af-table">
            <thead>
              <tr><th>Kind</th><th>Branch</th><th>Seen</th><th>Status</th><th>Links</th><th>Updated</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {data.findings.flatMap((f) => {
                const finished = f.status === 'dismissed' || f.status === 'resolved';
                const busy = busyId === f.id;
                const rows = [(
                  <tr key={f.id} data-finding-id={f.id}>
                    <td>{f.kind}</td>
                    <td>{f.branch || <span className="muted">none</span>}</td>
                    <td>{f.occurrences}x</td>
                    <td><StatusPill status={f.status} /></td>
                    <td className="af-links">
                      {f.workflow_id && <a href={`#/p/${projectId}/sessions/${f.workflow_id}`}>Session</a>}
                      {isHttpUrl(f.pr_url) && <a href={f.pr_url} target="_blank" rel="noreferrer">PR{f.pr_number ? ` #${f.pr_number}` : ''}</a>}
                      {!f.workflow_id && !isHttpUrl(f.pr_url) && <span className="muted">none</span>}
                    </td>
                    <td className="muted">{formatRelative(f.updated_at)}</td>
                    <td className="af-actions">
                      <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? '' : f.id)}>{open === f.id ? 'Hide' : 'Details'}</button>
                      {canManage && !finished && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(f, 'dismiss', 'Finding dismissed')}>Dismiss</button>}
                      {canManage && !finished && <button type="button" className="btn btn-sm" disabled={busy}
                        onClick={() => act(f, 'never-fix', `${f.kind} removed from the kinds to fix`, `Dismiss this finding and stop Auto-fix acting on "${f.kind}" findings in this project? You can add the kind back in the policy.`)}>Never fix this kind</button>}
                      {canManage && ['needs_human', 'new', 'suppressed'].includes(f.status) && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(f, 'retry', 'Finding queued for another try')}>Retry</button>}
                    </td>
                  </tr>
                )];
                if (open === f.id) rows.push(<tr key={`${f.id}-d`} className="af-detail-row"><td colSpan={7}><FindingDetail projectId={projectId} f={f} /></td></tr>);
                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}
      {policy && (
        <PausePanel projectId={projectId} paused={Boolean(meta.paused)} pausedGlobal={Boolean(meta.paused_global)} canManage={canManage}
          requestConfirm={requestConfirm} onChange={(v) => setMeta((m) => ({ ...m, paused: v }))} toast={toast} />
      )}
      {policy && (
        <PolicyForm key={JSON.stringify(policy)} projectId={projectId} policy={policy} unattended={Boolean(meta.unattended_push_enabled)}
          canManage={canManage} isAdmin={isAdmin} currentUserId={currentUserId} members={members}
          onSaved={(p) => setMeta((m) => ({ ...m, policy: p }))} toast={toast} />
      )}
      {policy && <WebhookPanel projectId={projectId} canManage={canManage} toast={toast} />}
    </div>
  );
}

export default AutoFix;
