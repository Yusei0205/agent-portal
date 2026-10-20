import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, stream } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { buildTree, toolSummary } from '../lib/tree.js';
import { AgentGraph } from '../components/AgentGraph.jsx';
import { TicketPreview } from '../components/TicketPreview.jsx';
import { ModelPicker } from '../components/ModelPicker.jsx';
import { ConnectionBadge } from '../components/ConnectionBadge.jsx';
import { parseUnifiedDiff } from '../lib/diff.js';
import { cx, dateTime, duration, hueFor, money, timeAgo, tokens } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { InputCard } from '../components/InputCard.jsx';
import { JiraRunBar } from './Tickets.jsx';
import { DiffView } from '../components/DiffView.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, Segmented, Spinner, Tabs, Toggle, useUi } from '../components/ui.jsx';

const MODES = [
  { value: 'default', label: 'Ask before changes', hint: 'Edits and commands wait for your approval.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: "File edits in the run's working copy go ahead; commands still ask." },
  { value: 'plan', label: 'Plan only', hint: 'Reads and plans; changes nothing.' },
];
const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.value, m.label]));
const MODELS = [
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'haiku', label: 'Haiku (cheapest)' },
  { value: 'opus', label: 'Opus (hardest tasks)' },
];
const KIND_LABEL = { chat: 'Run', test: 'Test', review: 'Review' };

export function Runs({ route }) {
  const { project } = useProject();
  const [filter, setFilter] = useState('all');
  const runs = useLoad(() => api.get(`/api/projects/${project.id}/runs?kind=${filter === 'all' ? 'chat,test,review' : filter}`), [project.id, filter]);
  useProjectEvents(['run.updated'], () => runs.reload(true));
  const selected = route.rest[0] && route.rest[0] !== 'new' ? route.rest[0] : null;

  // Support ?jiraKey=PAY-123&jiraUrl=...&jiraSummary=... from the Tickets page "Start a coding run" button
  const prefill = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const key = q.get('jiraKey');
    if (!key) return null;
    return { jiraKey: key, jiraUrl: q.get('jiraUrl') || '', jiraSummary: q.get('jiraSummary') || '' };
  }, []);

  return (
    <div className="runs-page">
      <aside className="runs-list" aria-label="Runs">
        <div className="runs-list-head">
          <h1>Agent runs</h1>
          <a className="btn btn-primary btn-sm" href={href(project.id, 'runs', 'new')}>
            <Icon name="plus" size={15} />
            <span>New run</span>
          </a>
        </div>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          label="Show"
          options={[
            { value: 'all', label: 'All' },
            { value: 'chat', label: 'Runs' },
            { value: 'review', label: 'Reviews' },
            { value: 'test', label: 'Tests' },
          ]}
        />
        {runs.loading && !runs.data ? (
          <Spinner />
        ) : (
          <ul className="run-items">
            {(runs.data?.runs || []).map((r) => (
              <li key={r.id}>
                <a href={href(project.id, 'runs', r.id)} className={cx('run-item', selected === r.id && 'is-active')}>
                  <span className={cx('dot', `dot-${r.status}`)} aria-hidden="true" />
                  <span className="run-item-main">
                    <span className="run-item-title">{r.title}</span>
                    <span className="muted small">
                      {KIND_LABEL[r.kind] ?? r.kind}, {timeAgo(r.created_at)}
                      {r.meta?.kiroCredits != null ? `, ${r.meta.kiroCredits} credits` : r.cost_usd ? `, ${money(r.cost_usd)}` : ''}
                    </span>
                  </span>
                  {r.status === 'waiting' ? <Badge status="waiting" /> : null}
                </a>
              </li>
            ))}
            {runs.data && !runs.data.runs.length ? <li className="muted small pad-sm">No runs yet.</li> : null}
          </ul>
        )}
      </aside>
      <section className="runs-main">{selected ? <RunView key={selected} runId={selected} /> : <Composer prefill={prefill} />}</section>
    </div>
  );
}

/* ---------------- Jira ticket picker (free-task form) ---------------- */

/** KEY_RE mirrors the server's pattern: one or more capital letter-digit prefix, dash, digits. */
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;

/**
 * Searchable picker that lets developers select a Jira ticket.
 * Only rendered when the project has Jira connected AND mapped to a project key.
 */
export function JiraTicketPicker({ projectId, value, onChange }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('mine');
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState({ list: [], next: null });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const loadIdRef = useRef(0);

  // Debounce text search
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async ({ more = false } = {}) => {
    const id = ++loadIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = more && pages.next ? `&next=${encodeURIComponent(pages.next)}` : '';
      const r = await api.get(
        `/api/projects/${projectId}/jira/issues?scope=${scope}&q=${encodeURIComponent(debouncedQ)}${next}`,
      );
      if (id !== loadIdRef.current) return;
      setPages((p) => ({ list: more ? [...p.list, ...r.issues] : r.issues, next: r.next }));
    } catch (e) {
      if (id === loadIdRef.current) setLoadError(e);
    } finally {
      if (id === loadIdRef.current) setLoading(false);
    }
  }, [projectId, scope, debouncedQ, pages.next]);

  // Reset and reload on scope/search change
  useEffect(() => {
    setPages({ list: [], next: null });
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, debouncedQ, open]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); listRef.current?.querySelector('[role="option"]')?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const select = (issue) => {
    onChange({ key: issue.key, summary: issue.summary, status: issue.status, url: null });
    setOpen(false);
    setQ('');
  };

  // If user types a valid key directly (e.g. PAY-123) and blurs, accept it
  const handleInputBlur = () => {
    const trimmed = q.trim().toUpperCase();
    if (JIRA_KEY_RE.test(trimmed) && !value) {
      onChange({ key: trimmed, summary: '(key entered manually — details loaded when run starts)', status: null, url: null });
      setQ('');
      setOpen(false);
    }
  };

  const resultCount = pages.list.length;

  if (value) {
    // Show the selected ticket card
    return (
      <div className="stack" style={{ gap: 8 }}>
      <div className="jira-ticket-card" role="status" aria-label={`Selected Jira ticket: ${value.key}`}>
        <span className="jira-ticket-card-key mono">{value.key}</span>
        <span className="jira-ticket-card-summary">{value.summary}</span>
        {value.status ? (
          <Badge tone={value.status.category === 'done' ? 'ok' : value.status.category === 'indeterminate' ? 'accent' : 'muted'}>
            {value.status.name}
          </Badge>
        ) : null}
        {value.url ? (
          <a href={value.url} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label={`Open ${value.key} in Jira`} title="Open in Jira">
            <Icon name="external" size={14} />
          </a>
        ) : null}
        <button type="button" className="linkish small" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`Remove selected ticket ${value.key}`}
          onClick={() => onChange(null)}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      {showDetails ? <div className="panel"><TicketPreview projectId={projectId} ticketKey={value.key} /></div> : null}
      </div>
    );
  }

  return (
    <div className="jira-picker" style={{ position: 'relative' }}>
      <div className="row tight" style={{ gap: 6 }}>
        <input
          ref={inputRef}
          type="search"
          className="input"
          placeholder="Search tickets or type a key (e.g. PAY-123)"
          aria-label="Search Jira tickets"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls="jira-picker-list"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={handleInputBlur}
          autoComplete="off"
        />
        <Segmented
          size="sm"
          value={scope}
          onChange={(v) => { setScope(v); setOpen(true); }}
          label="Scope"
          options={[
            { value: 'mine', label: 'Mine' },
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      {/* Live region for screen reader announcements */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {loading ? 'Loading tickets…' : open ? `${resultCount} ticket${resultCount === 1 ? '' : 's'} found` : ''}
      </div>
      {open ? (
        <div
          id="jira-picker-list"
          role="listbox"
          aria-label="Jira tickets"
          ref={listRef}
          className="jira-picker-dropdown"
          onMouseDown={(e) => e.preventDefault()} // prevent blur before click
        >
          {loading && !pages.list.length ? (
            <div className="jira-picker-state"><Spinner small /> Loading…</div>
          ) : loadError ? (
            <div className="jira-picker-state danger"><Icon name="alert" size={14} /> {loadError.message || 'Could not load tickets'}</div>
          ) : !pages.list.length ? (
            <div className="jira-picker-state muted">No tickets found</div>
          ) : (
            pages.list.map((issue) => (
              <button
                key={issue.key}
                role="option"
                aria-selected="false"
                type="button"
                className="jira-picker-option"
                onClick={() => select(issue)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.nextElementSibling?.focus(); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling || inputRef.current)?.focus(); }
                  if (e.key === 'Enter') { e.preventDefault(); select(issue); }
                  if (e.key === 'Escape') { setOpen(false); inputRef.current?.focus(); }
                }}
              >
                <span className="jira-picker-option-key mono">{issue.key}</span>
                <span className="jira-picker-option-summary">{issue.summary}</span>
                <Badge tone={issue.status.category === 'done' ? 'ok' : issue.status.category === 'indeterminate' ? 'accent' : 'muted'}>
                  {issue.status.name}
                </Badge>
                {issue.type ? <span className="muted small">{issue.type}</span> : null}
              </button>
            ))
          )}
          {pages.next ? (
            <button type="button" className="jira-picker-more" onClick={() => load({ more: true })} disabled={loading}>
              {loading ? <Spinner small /> : 'Load more'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Start a run ---------------- */

const EXAMPLES = [
  'Design and build the refund approval flow described in the FSD',
  'Write user stories and acceptance criteria for the notifications section',
  'Map the code structure of the main repository: endpoints, services and tests',
  'Compare the TSD with the code and list what is missing',
];

function Composer({ prefill }) {
  const { project, canEdit } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const jiraStatus = useLoad(() => api.get(`/api/projects/${project.id}/jira`), [project.id]);
  const [form, setForm] = useState({ prompt: '', repoId: '', branch: '', permissionMode: 'default', model: 'sonnet' });
  // "Document a repository": the agent reads the repo's copy in place and writes only to its own run folder.
  const [kind, setKind] = useState('task');
  const [doc, setDoc] = useState({ repoId: '', scope: '', output: 'markdown-word' });
  const isDoc = kind === 'document';
  const chooseKind = (k) => {
    setKind(k);
    // Writing documents to the run folder is safe, so default to not asking for every file.
    setForm((f) => ({ ...f, permissionMode: k === 'document' ? 'acceptEdits' : 'default' }));
  };
  const [branches, setBranches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Jira ticket selection state
  const [jiraTicket, setJiraTicket] = useState(null);

  // Prefill from Tickets page "Start a coding run" button
  useEffect(() => {
    if (prefill?.jiraKey) {
      setJiraTicket({ key: prefill.jiraKey, summary: prefill.jiraSummary || prefill.jiraKey, status: null, url: prefill.jiraUrl || null });
      // Clear the query params so a reload doesn't re-prefill
      const clean = new URL(window.location.href);
      clean.searchParams.delete('jiraKey');
      clean.searchParams.delete('jiraUrl');
      clean.searchParams.delete('jiraSummary');
      clean.searchParams.delete('repoId');
      window.history.replaceState(null, '', clean.pathname + clean.search + clean.hash);
      // Also pre-select the repo if provided
      const q = new URLSearchParams(window.location.search);
      const repoId = prefill.repoId || q.get('repoId');
      if (repoId) setForm((f) => ({ ...f, repoId }));
    }
  }, [prefill]);

  useEffect(() => {
    if (!form.repoId) return setBranches([]);
    api.get(`/api/repos/${form.repoId}/branches`).then((r) => {
      setBranches(r.branches);
      setForm((f) => ({ ...f, branch: f.branch || r.defaultBranch }));
    });
  }, [form.repoId]);
  const readyRepos = (repos.data?.repos || []).filter((r) => r.status === 'ready');

  // Show the Jira picker only when Jira is connected AND mapped
  const jiraReady = Boolean(jiraStatus.data?.connected && jiraStatus.data?.mapping);

  if (!canEdit) {
    return (
      <div className="pad-lg">
        <Empty icon="runs" title="Pick a run to follow it">You have view access, so you can watch runs and answer questions, but not start runs.</Empty>
      </div>
    );
  }

  // Instruction is optional when a Jira ticket is selected
  const promptRequired = !jiraTicket;
  const promptEmpty = !form.prompt.trim();

  const start = async (e) => {
    e?.preventDefault();
    if (!isDoc && promptRequired && promptEmpty) return;
    setBusy(true);
    setError(null);
    try {
      let body;
      if (isDoc) {
        body = { document: { repoId: doc.repoId, scope: doc.scope, output: doc.output }, model: form.model, permissionMode: form.permissionMode };
      } else if (jiraTicket) {
        body = {
          jiraKey: jiraTicket.key,
          prompt: form.prompt.trim() || undefined,
          repoId: form.repoId || undefined,
          branch: form.repoId ? form.branch : undefined,
          model: form.model,
          permissionMode: form.permissionMode,
        };
      } else {
        body = { ...form, repoId: form.repoId || undefined, branch: form.repoId ? form.branch : undefined };
      }
      const { run } = await api.post(`/api/projects/${project.id}/runs`, body);
      go(project.id, 'runs', run.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="composer" onSubmit={start}>
      <h2>What should the agents do?</h2>
      <div className="row tight wrap" style={{ marginBottom: 4 }}>
        <span className="muted small">Connection:</span>
        <ConnectionBadge projectId={project.id} />
      </div>
      <Segmented
        value={kind}
        onChange={chooseKind}
        label="Kind of run"
        options={[
          { value: 'task', label: 'Free task' },
          { value: 'document', label: 'Document a repository' },
        ]}
      />
      {isDoc ? (
        <div className="stack">
          <p className="muted">The agent maps the repository's code and writes cited documentation. It reads a fresh copy of the repository and writes only to its own run folder, so no code changes.</p>
          <div className="composer-grid">
            <Field label="Repository" hint={readyRepos.length ? 'Uses the default branch.' : 'Connect and sync a repository on the Repositories page first.'}>
              {(id) => (
                <select id={id} className="input" value={doc.repoId} onChange={(e) => setDoc({ ...doc, repoId: e.target.value })}>
                  <option value="">Choose a repository…</option>
                  {readyRepos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Output" hint="Word and PowerPoint use the make-documents skill.">
              {(id) => (
                <select id={id} className="input" value={doc.output} onChange={(e) => setDoc({ ...doc, output: e.target.value })}>
                  <option value="markdown">Markdown files</option>
                  <option value="word">Word document</option>
                  <option value="markdown-word">Markdown and Word</option>
                  <option value="slides">PowerPoint overview</option>
                </select>
              )}
            </Field>
          </div>
          <Field label="Focus (optional)" hint="Leave empty to cover the whole repository.">
            {(id) => (
              <textarea
                id={id}
                className="input"
                rows={3}
                value={doc.scope}
                onChange={(e) => setDoc({ ...doc, scope: e.target.value })}
                placeholder="For example: the Lambda functions, the DynamoDB tables and how a payment flows through them"
              />
            )}
          </Field>
        </div>
      ) : (
        <>
          <p className="muted">The main agent reads the project documents and decisions first, asks you when something is unclear, and hands parts of the work to the project's role agents.</p>

          {/* Jira ticket picker — only when connected and mapped */}
          {jiraReady ? (
            <Field
              label="Jira ticket (optional)"
              hint={jiraTicket ? 'The agent receives the full ticket as context. The instruction below becomes optional.' : 'Pick a ticket and the agent receives its details as context.'}
            >
              {() => (
                <JiraTicketPicker
                  projectId={project.id}
                  value={jiraTicket}
                  onChange={setJiraTicket}
                />
              )}
            </Field>
          ) : jiraStatus.data && !jiraStatus.data.connected ? (
            <p className="muted small">
              <a href={href(project.id, 'team')}>Connect Jira</a> to pick a ticket from your board.
            </p>
          ) : null}

          <Field
            label={jiraTicket ? 'Instruction (optional)' : 'Task for the agents'}
            hint={jiraTicket ? 'Leave empty to implement or fix what the ticket describes. Add a short note to focus or restrict the agent.' : undefined}
          >
            {(id) => (
              <textarea
                id={id}
                className="input composer-input"
                rows={6}
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder={
                  jiraTicket
                    ? `Optional: add a short instruction, e.g. "fix this, add unit tests"`
                    : 'Describe the task. Mention the feature, the outcome you want, and anything the agents must not change.'
                }
                aria-required={!jiraTicket}
                aria-label={jiraTicket ? 'Optional instruction for the agents' : 'Task for the agents'}
                autoFocus={!jiraTicket}
              />
            )}
          </Field>
          {!jiraTicket ? (
            <div className="chips">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="chip" onClick={() => setForm({ ...form, prompt: x })}>
                  {x}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      <div className="composer-grid">
        {!isDoc ? (
        <Field label="Repository" hint={readyRepos.length ? 'The run gets its own working copy of this branch.' : 'Connect one on the Repositories page to let agents change code.'}>
          {(id) => (
            <select id={id} className="input" value={form.repoId} onChange={(e) => setForm({ ...form, repoId: e.target.value, branch: '' })}>
              <option value="">No repository (documents only)</option>
              {readyRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        ) : null}
        {!isDoc && form.repoId ? (
          <Field label="Branch">
            {(id) => (
              <select id={id} className="input" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field label="Model">{(id) => <ModelPicker id={id} value={form.model} projectId={project.id} onChange={(model) => setForm({ ...form, model })} />}</Field>
      </div>
      <fieldset className="mode-pick">
        <legend className="field-label">Changes</legend>
        {MODES.map((m) => (
          <label key={m.value} className={cx('choice', form.permissionMode === m.value && 'is-checked')}>
            <input type="radio" name="mode" checked={form.permissionMode === m.value} onChange={() => setForm({ ...form, permissionMode: m.value })} />
            <span>
              <strong>{m.label}</strong> <span className="muted">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" type="submit" icon="play" busy={busy} disabled={isDoc ? !doc.repoId : (promptRequired && promptEmpty)}>
          {isDoc ? 'Start documentation run' : 'Start run'}
        </Button>
      </div>
    </form>
  );
}

/* ---------------- Follow a run ---------------- */

export function useRunStream(runId) {
  const [state, setState] = useState({ loading: true, run: null, events: [], inputs: [], continuations: [] });
  const lastSeq = useRef(0);
  const reloadDetail = async () => {
    const r = await api.get(`/api/runs/${runId}`);
    lastSeq.current = Math.max(lastSeq.current, ...r.events.map((e) => e.seq), 0);
    setState({ loading: false, ...r });
    return r;
  };
  useEffect(() => {
    let close = () => {};
    let alive = true;
    reloadDetail()
      .then((r) => {
        if (!alive) return;
        if (!['completed', 'failed', 'stopped'].includes(r.run.status) || r.active) {
          close = stream(() => `/api/runs/${runId}/stream?after=${lastSeq.current}`, {
            event: (e) => {
              if (e.seq <= lastSeq.current) return;
              lastSeq.current = e.seq;
              setState((s) => ({ ...s, events: [...s.events, e] }));
              if (e.type === 'portal:input' || e.type === 'portal:input_answered') api.get(`/api/runs/${runId}`).then((r2) => setState((s) => ({ ...s, inputs: r2.inputs })));
            },
            run: (summary) => {
              setState((s) => ({ ...s, run: { ...s.run, ...summary } }));
              if (['completed', 'failed', 'stopped'].includes(summary.status)) reloadDetail();
            },
          });
        }
      })
      .catch((error) => setState((s) => ({ ...s, loading: false, error })));
    return () => {
      alive = false;
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);
  return { ...state, reload: reloadDetail };
}

function RunView({ runId }) {
  const { project, canEdit, reload: reloadProject } = useProject();
  const { meta } = useApp();
  const { toast } = useUi();
  const data = useRunStream(runId);
  const [selectedNode, setSelectedNode] = useState('main');
  const [tab, setTab] = useState('activity');
  const [pushing, setPushing] = useState(false);
  const [, tick] = useState(0);
  const run = data.run;
  const active = run && ['queued', 'running', 'waiting'].includes(run.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);

  const tree = useMemo(() => buildTree(data.events, { prices: meta.prices, runStatus: run?.status }), [data.events, meta.prices, run?.status]);
  if (data.error) return <div className="pad-lg"><ErrorNote error={data.error} /></div>;
  if (!run) return <div className="pad-lg"><Spinner /></div>;
  const node = tree.nodes.get(selectedNode) || tree.root;
  const pending = data.inputs.filter((i) => i.status === 'pending');
  const isDemo = run.provider === 'demo';
  const isKiro = run.provider === 'kiro';
  const cost = run.cost_usd || 0;
  const est = run.meta?.estimatedUsd ?? tree.root.totals.cost;
  const kiroCredits = run.meta?.kiroCredits;

  return (
    <div className="run-view">
      <header className="run-head">
        <div className="run-head-main">
          <div className="row tight wrap">
            <Badge status={run.status} />
            <span className="muted small">{KIND_LABEL[run.kind] ?? run.kind}</span>
          </div>
          <h1>{run.title}</h1>
          <JiraRunBar run={run} />
          <dl className="run-facts">
            <div><dt>Started</dt><dd>{dateTime(run.created_at)}</dd></div>
            <div><dt>Time</dt><dd>{duration(run.started_at || run.created_at, run.finished_at)}</dd></div>
            <div><dt>Model</dt><dd>{tree.root.model || run.model}</dd></div>
            {run.permission_mode ? <div><dt>Changes</dt><dd>{MODE_LABEL[run.permission_mode] ?? run.permission_mode}</dd></div> : null}
            {run.branch ? <div><dt>Branch</dt><dd><code>{run.branch}</code></dd></div> : null}
            <div><dt>Tokens</dt><dd>{tokens(run.input_tokens)} in, {tokens(run.output_tokens)} out</dd></div>
            <div>
              <dt>{isDemo ? 'Would cost' : isKiro ? 'Credits' : 'Cost'}</dt>
              <dd title={isDemo ? 'Demo runs are free. This is what the same run would cost on Claude.' : undefined}>
                {isDemo ? `≈${money(est)}` : isKiro ? (kiroCredits != null ? `${kiroCredits} credits` : '—') : money(cost)}
              </dd>
            </div>
          </dl>
          <div className="row tight wrap" style={{ marginTop: 6 }}>
            <ConnectionBadge projectId={project.id} />
          </div>
        </div>
        <div className="run-actions">
          {active && canEdit ? (
            <Button
              variant="danger-ghost"
              icon="stop"
              onClick={async () => {
                await api.post(`/api/runs/${run.id}/stop`);
                toast('Stopping the run');
              }}
            >
              Stop
            </Button>
          ) : null}
          {!active && canEdit && run.worktree ? (
            <Button icon="branch" onClick={() => setPushing(true)}>
              Push changes
            </Button>
          ) : null}
        </div>
      </header>

      {isDemo ? (
        <Note tone="info" icon="alert">
          This is a demo run: the agent is simulated, files it reads and writes are real. Switch Settings › Provider to Anthropic or Bedrock for real agents.
        </Note>
      ) : null}
      {run.error && run.status !== 'completed' ? <ErrorNote error={new Error(run.error)} /> : null}

      {pending.length ? (
        <section className="pending" aria-label="Waiting for you">
          {pending.map((i) => (
            <InputCard key={i.id} input={i} projectId={project.id} canApprove={canEdit} compact onDone={() => { data.reload(); reloadProject(); }} />
          ))}
        </section>
      ) : null}

      {tree.root.totals.subagents || active ? <AgentGraph tree={tree} selected={selectedNode} onSelect={setSelectedNode} /> : null}

      <div className="run-body">
        <nav className="tree" aria-label="Agents in this run">
          <TreeNode node={tree.root} selected={selectedNode} onSelect={setSelectedNode} depth={0} />
          <p className="tree-totals muted small">
            {tree.root.totals.subagents ? `${tree.root.totals.subagents} subagent${tree.root.totals.subagents === 1 ? '' : 's'}, ` : ''}
            {tree.root.totals.tools} tool calls
          </p>
        </nav>
        <div className="timeline-wrap">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'activity', label: node.kind === 'main' ? 'Activity' : `${node.label} activity` },
              { value: 'result', label: 'Result' },
              { value: 'changes', label: 'Files and changes' },
              { value: 'prompt', label: 'Request' },
            ]}
          />
          {tab === 'activity' ? (
            <Timeline node={node} tree={tree} onSelect={setSelectedNode} inputs={data.inputs} />
          ) : tab === 'result' ? (
            <ResultPanel run={run} />
          ) : tab === 'changes' ? (
            <Changes run={run} />
          ) : (
            <div className="pad-sm">
              <pre className="prompt-box">{run.prompt}</pre>
              {data.continuations?.length ? (
                <p className="small">
                  Follow-ups:{' '}
                  {data.continuations.map((c) => (
                    <a key={c.id} href={href(project.id, 'runs', c.id)}>
                      {c.title}{' '}
                    </a>
                  ))}
                </p>
              ) : null}
              {run.resume_of ? (
                <p className="small">
                  Continues <a href={href(project.id, 'runs', run.resume_of)}>an earlier run</a>.
                </p>
              ) : null}
            </div>
          )}
          {!active && canEdit && ['chat', 'test'].includes(run.kind) ? <FollowUp run={run} /> : null}
        </div>
      </div>
      {pushing ? <PushDialog run={run} onClose={() => setPushing(false)} /> : null}
    </div>
  );
}

const STATUS_ICON = { done: 'check', failed: 'x', stopped: 'stop', waiting: 'question' };

function TreeNode({ node, selected, onSelect, depth }) {
  const hue = node.kind === 'main' ? null : hueFor(node.label);
  return (
    <div className={cx('tnode', `tnode-${node.status}`, depth && 'tnode-child')} style={hue !== null ? { '--role-h': hue } : undefined}>
      <button type="button" className={cx('tnode-btn', selected === node.id && 'is-selected')} onClick={() => onSelect(node.id)} aria-current={selected === node.id}>
        <span className="tnode-mark" aria-hidden="true">
          {STATUS_ICON[node.status] ? <Icon name={STATUS_ICON[node.status]} size={12} /> : null}
        </span>
        <span className="tnode-text">
          <span className="tnode-label">{node.label}</span>
          {node.description ? <span className="tnode-desc">{node.description}</span> : null}
          <span className="tnode-stats">
            {node.toolCount} tools, {tokens(node.inputTokens + node.outputTokens)} tokens{node.cost ? `, ≈${money(node.cost)}` : ''}
          </span>
        </span>
        <span className="sr-only">{node.status}</span>
      </button>
      {node.children.length ? (
        <div className="tnode-children">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Timeline({ node, tree, onSelect, inputs }) {
  const endRef = useRef(null);
  const count = node.items.length;
  useEffect(() => {
    if (node.status === 'running') endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [count, node.status]);
  if (!node.items.length) {
    return <p className="muted pad-sm">{node.status === 'running' ? 'Starting…' : 'No activity recorded.'}</p>;
  }
  return (
    <ol className="timeline">
      {node.kind !== 'main' && node.prompt ? (
        <li className="tl-item tl-brief">
          <span className="tl-label">Brief from the main agent</span>
          <p>{node.prompt}</p>
        </li>
      ) : null}
      {node.items.map((it, i) => (
        <TimelineItem key={i} it={it} tree={tree} onSelect={onSelect} inputs={inputs} />
      ))}
      {node.status === 'running' ? (
        <li className="tl-item tl-live">
          <span className="live-dot" aria-hidden="true" /> Working…
        </li>
      ) : null}
      {node.kind !== 'main' && node.resultText && node.resultText.trim() !== [...node.items].reverse().find((x) => x.kind === 'text')?.text.trim() ? (
        <li className="tl-item tl-report">
          <span className="tl-label">Reported back to the main agent</span>
          <Markdown text={node.resultText} />
        </li>
      ) : null}
      <li ref={endRef} aria-hidden="true" />
    </ol>
  );
}

function TimelineItem({ it, tree, onSelect, inputs }) {
  const [open, setOpen] = useState(false);
  if (it.kind === 'text') {
    return (
      <li className="tl-item tl-text">
        <Markdown text={it.text} />
      </li>
    );
  }
  if (it.kind === 'thinking') {
    return (
      <li className="tl-item tl-thinking">
        <details>
          <summary>Thinking</summary>
          <p>{it.text}</p>
        </details>
      </li>
    );
  }
  if (it.kind === 'tool') {
    const child = it.childId ? tree.nodes.get(it.childId) : null;
    return (
      <li className={cx('tl-item tl-tool', `tool-${it.status}`)}>
        <div className="tool-row">
          <button type="button" className="tool-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
            <code className="tool-name">{it.name}</code>
            <span className="tool-sum">{toolSummary(it.name, it.input)}</span>
          </button>
          {child ? (
            <button type="button" className="linkish small" onClick={() => onSelect(child.id)}>
              Open {child.label}
            </button>
          ) : null}
          <span className={cx('tool-state', `state-${it.status}`)}>{it.status === 'running' ? 'running' : it.status === 'failed' ? (it.result?.startsWith('Blocked') ? 'blocked' : 'error') : it.status === 'stopped' ? 'stopped' : ''}</span>
        </div>
        {open ? (
          <div className="tool-detail">
            <span className="tl-label">Input</span>
            <pre>{JSON.stringify(it.input, null, 2).slice(0, 8000)}</pre>
            {it.result !== null ? (
              <>
                <span className="tl-label">Result</span>
                <pre className={cx(it.isError && 'is-error')}>{String(it.result).slice(0, 12000)}</pre>
              </>
            ) : null}
          </div>
        ) : it.isError && it.result ? (
          <p className="danger small tool-err">{String(it.result).slice(0, 300)}</p>
        ) : null}
      </li>
    );
  }
  if (it.kind === 'input') {
    const inp = inputs.find((x) => x.id === it.inputId);
    const answered = it.answered || (inp && inp.status !== 'pending' ? { response: inp.response } : null);
    return (
      <li className="tl-item tl-input">
        <Icon name={it.inputType === 'approval' ? 'lock' : 'question'} size={15} />
        <div>
          <strong>{it.inputType === 'approval' ? `Asked to run ${it.toolName}` : 'Asked the team'}</strong>
          {it.inputType === 'question' ? (
            <ul className="plain-list small">
              {(it.payload?.questions || []).map((q) => (
                <li key={q.question}>
                  {q.question}
                  {answered?.response?.answers?.[q.question] ? <strong> → {[].concat(answered.response.answers[q.question]).join(', ')}</strong> : null}
                </li>
              ))}
            </ul>
          ) : answered ? (
            <span className="small"> → {answered.response?.decision === 'allow' ? 'allowed' : 'denied'}</span>
          ) : null}
          {!answered ? <span className="muted small"> waiting for an answer</span> : answered.by ? <span className="muted small"> ({answered.by})</span> : null}
        </div>
      </li>
    );
  }
  if (it.kind === 'result') {
    return (
      <li className="tl-item tl-result">
        <Icon name={it.data.is_error ? 'x' : 'check'} size={15} />
        <span>
          Finished after {it.data.num_turns ?? '?'} turns{it.data.duration_ms ? ` in ${Math.round(it.data.duration_ms / 1000)}s` : ''}.
        </span>
      </li>
    );
  }
  return (
    <li className="tl-item tl-system muted small">
      <span>{it.text}</span>
    </li>
  );
}

function ResultPanel({ run }) {
  if (!run.result && ['queued', 'running', 'waiting'].includes(run.status)) return <p className="muted pad-sm">The result appears here when the run finishes.</p>;
  if (!run.result) return <p className="muted pad-sm">No result text.</p>;
  return (
    <div className="pad-sm doc-body">
      <Markdown text={run.result} />
    </div>
  );
}

function Changes({ run }) {
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

function FollowUp({ run }) {
  const { project } = useProject();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState(run.permission_mode || 'default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <form
      className="followup"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await api.post(`/api/runs/${run.id}/continue`, { prompt, permissionMode: mode });
          go(project.id, 'runs', r.run.id);
        } catch (err) {
          setError(err);
          setBusy(false);
        }
      }}
    >
      <label className="field-label" htmlFor="followup">
        Continue this conversation
      </label>
      <textarea id="followup" className="input" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask for changes or the next step. The agent keeps the context of this run." />
      <div className="row wrap">
        <select className="input input-sm" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Changes">
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="primary" busy={busy} disabled={!prompt.trim()}>
          Send follow-up
        </Button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

function PushDialog({ run, onClose }) {
  const { toast } = useUi();
  const meta = run.meta || {};
  const jiraKey = meta.jiraKey;
  const jiraSummary = meta.jiraSummary;

  // Build Jira-aware defaults (mirrors server logic)
  const defaultBranch = meta.workBranch
    ? meta.workBranch
    : jiraKey
    ? `agent/${jiraKey.toLowerCase()}-${(jiraSummary || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`
    : `agent/${run.id.slice(2, 12).toLowerCase()}`;
  const defaultMessage = jiraKey ? `${jiraKey}: ${jiraSummary || run.title}` : `Agent Portal: ${run.title}`;

  const [branch, setBranch] = useState(defaultBranch);
  const [message, setMessage] = useState(defaultMessage);
  const [createPr, setCreatePr] = useState(false);
  const [prBase, setPrBase] = useState(run.branch || '');
  const branchList = useLoad(() => (run.repo_id ? api.get(`/api/repos/${run.repo_id}/branches`) : Promise.resolve(null)), [run.repo_id]);
  const [prTitle, setPrTitle] = useState(jiraKey ? `${jiraKey}: ${jiraSummary || run.title}` : run.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const repo = useLoad(() => (run.repo_id ? api.get(`/api/projects/${run.project_id}/repos`) : Promise.resolve(null)), [run.repo_id]);
  const isGithub = repo.data?.repos.find((r) => r.id === run.repo_id)?.provider === 'github';
  return (
    <Modal
      title="Push the run's changes"
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const body = { branch, message, createPr };
                  if (createPr && isGithub) {
                    body.prTitle = prTitle;
                    if (prBase) body.base = prBase;
                  }
                  const r = await api.post(`/api/runs/${run.id}/push`, body);
                  setDone(r);
                  toast(`Pushed to ${r.branch}`);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Commit and push
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="stack">
          <p>
            Pushed commit <code>{done.commit?.slice(0, 10)}</code> to <code>{done.branch}</code>.
          </p>
          {done.pr ? (
            <p>
              Draft pull request: <a href={done.pr.url} target="_blank" rel="noreferrer">#{done.pr.number}</a>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="muted">All changes in the run's working copy are committed and pushed to a new branch. The default branch is never pushed to.</p>
          {jiraKey ? (
            <div className="row tight wrap jira-bar small" style={{ marginBottom: 4 }}>
              <a href={meta.jiraUrl} target="_blank" rel="noopener noreferrer" className="badge badge-accent">
                Jira {jiraKey} <Icon name="external" size={12} />
              </a>
              <span className="muted">{jiraSummary}</span>
            </div>
          ) : null}
          <Field label="Branch">{(id) => <input id={id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
          <Field label="Commit message">{(id) => <textarea id={id} className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
          {isGithub ? (
            <>
              <Toggle checked={createPr} onChange={setCreatePr} label="Open a draft pull request on GitHub" />
              {createPr ? (
                <>
                  <Field label="Pull request title">{(id) => <input id={id} className="input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />}</Field>
                  <Field label="Open the pull request into" hint="The branch you want these changes reviewed against and merged into later.">
                    {(id) => (
                      <select id={id} className="input mono" value={prBase} onChange={(e) => setPrBase(e.target.value)}>
                        <option value="">Default branch{branchList.data?.defaultBranch ? ` (${branchList.data.defaultBranch})` : ''}</option>
                        {(branchList.data?.branches || []).filter((b) => b.name !== branch).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                      </select>
                    )}
                  </Field>
                </>
              ) : null}
            </>
          ) : null}
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}
