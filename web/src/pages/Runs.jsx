import { useEffect, useMemo, useRef, useState } from 'react';
import { api, stream } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { useProjectEvents } from '../lib/events.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { buildTree, toolSummary } from '../lib/tree.js';
import { parseUnifiedDiff } from '../lib/diff.js';
import { cx, dateTime, duration, hueFor, money, timeAgo, tokens } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';
import { InputCard } from '../components/InputCard.jsx';
import { DiffView } from '../components/DiffView.jsx';
import { Badge, Button, Empty, ErrorNote, Field, Modal, Note, Segmented, Spinner, Tabs, Toggle, useUi } from '../components/ui.jsx';

const MODES = [
  { value: 'default', label: 'Ask before changes', hint: 'Edits and commands wait for your approval.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits in the run’s working copy go ahead; commands still ask.' },
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
                      {r.cost_usd ? `, ${money(r.cost_usd)}` : ''}
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
      <section className="runs-main">{selected ? <RunView key={selected} runId={selected} /> : <Composer />}</section>
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

function Composer() {
  const { project, canEdit } = useProject();
  const repos = useLoad(() => api.get(`/api/projects/${project.id}/repos`), [project.id]);
  const [form, setForm] = useState({ prompt: '', repoId: '', branch: '', permissionMode: 'default', model: 'sonnet' });
  const [branches, setBranches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!form.repoId) return setBranches([]);
    api.get(`/api/repos/${form.repoId}/branches`).then((r) => {
      setBranches(r.branches);
      setForm((f) => ({ ...f, branch: f.branch || r.defaultBranch }));
    });
  }, [form.repoId]);
  const readyRepos = (repos.data?.repos || []).filter((r) => r.status === 'ready');

  if (!canEdit) {
    return (
      <div className="pad-lg">
        <Empty icon="runs" title="Pick a run to follow it">You have view access, so you can watch runs and answer questions, but not start runs.</Empty>
      </div>
    );
  }

  const start = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.post(`/api/projects/${project.id}/runs`, { ...form, repoId: form.repoId || undefined, branch: form.repoId ? form.branch : undefined });
      go(project.id, 'runs', run.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form className="composer" onSubmit={start}>
      <h2>What should the agents do?</h2>
      <p className="muted">The main agent reads the project documents and decisions first, asks you when something is unclear, and hands parts of the work to the project’s role agents.</p>
      <textarea
        className="input composer-input"
        rows={6}
        value={form.prompt}
        onChange={(e) => setForm({ ...form, prompt: e.target.value })}
        placeholder="Describe the task. Mention the feature, the outcome you want, and anything the agents must not change."
        aria-label="Task for the agents"
        autoFocus
      />
      <div className="chips">
        {EXAMPLES.map((x) => (
          <button key={x} type="button" className="chip" onClick={() => setForm({ ...form, prompt: x })}>
            {x}
          </button>
        ))}
      </div>
      <div className="composer-grid">
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
        {form.repoId ? (
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
        <Field label="Model">
          {(id) => (
            <select id={id} className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>
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
        <Button variant="primary" type="submit" icon="play" busy={busy} disabled={!form.prompt.trim()}>
          Start run
        </Button>
      </div>
    </form>
  );
}

/* ---------------- Follow a run ---------------- */

function useRunStream(runId) {
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
  const cost = run.cost_usd || 0;
  const est = run.meta?.estimatedUsd ?? tree.root.totals.cost;

  return (
    <div className="run-view">
      <header className="run-head">
        <div className="run-head-main">
          <div className="row tight wrap">
            <Badge status={run.status} />
            <span className="muted small">{KIND_LABEL[run.kind] ?? run.kind}</span>
          </div>
          <h1>{run.title}</h1>
          <dl className="run-facts">
            <div><dt>Started</dt><dd>{dateTime(run.created_at)}</dd></div>
            <div><dt>Time</dt><dd>{duration(run.started_at || run.created_at, run.finished_at)}</dd></div>
            <div><dt>Model</dt><dd>{tree.root.model || run.model}</dd></div>
            {run.permission_mode ? <div><dt>Changes</dt><dd>{MODE_LABEL[run.permission_mode] ?? run.permission_mode}</dd></div> : null}
            {run.branch ? <div><dt>Branch</dt><dd><code>{run.branch}</code></dd></div> : null}
            <div><dt>Tokens</dt><dd>{tokens(run.input_tokens)} in, {tokens(run.output_tokens)} out</dd></div>
            <div>
              <dt>{isDemo ? 'Would cost' : 'Cost'}</dt>
              <dd title={isDemo ? 'Demo runs are free. This is what the same run would cost on Claude.' : undefined}>{isDemo ? `≈${money(est)}` : money(cost)}</dd>
            </div>
          </dl>
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

function Timeline({ node, tree, onSelect, inputs }) {
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
  const ch = useLoad(() => api.get(`/api/runs/${run.id}/changes`), [run.id, run.status]);
  const [file, setFile] = useState(null);
  if (!ch.data) return ch.error ? <ErrorNote error={ch.error} /> : <Spinner />;
  const files = ch.data.diff ? parseUnifiedDiff(ch.data.diff) : [];
  return (
    <div className="pad-sm stack">
      {ch.data.worktree ? (
        <p className="muted small">
          Working copy: <code>{ch.data.worktree}</code>
        </p>
      ) : (
        <p className="muted small">
          Run folder: <code>{ch.data.workDir}</code>
        </p>
      )}
      {files.length ? <DiffView files={files} /> : null}
      {ch.data.files.length ? (
        <ul className="file-list">
          {ch.data.files.map((f) => (
            <li key={f.path}>
              <button type="button" className="linkish" onClick={() => setFile(f.path)}>
                <Icon name="file" size={15} /> {f.path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {!files.length && !ch.data.files.length ? <p className="muted">No files changed.</p> : null}
      {file ? <FileModal run={run} path={file} onClose={() => setFile(null)} /> : null}
    </div>
  );
}

function FileModal({ run, path, onClose }) {
  const f = useLoad(() => api.get(`/api/runs/${run.id}/file?path=${encodeURIComponent(path)}`), [path]);
  return (
    <Modal title={path} onClose={onClose} wide>
      {f.data ? path.endsWith('.md') ? <Markdown text={f.data.content} /> : <pre className="preview">{f.data.content}</pre> : f.error ? <ErrorNote error={f.error} /> : <Spinner />}
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
  const [branch, setBranch] = useState(`agent/${run.id.slice(2, 12).toLowerCase()}`);
  const [message, setMessage] = useState(`Agent Portal: ${run.title}`);
  const [createPr, setCreatePr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const repo = useLoad(() => (run.repo_id ? api.get(`/api/projects/${run.project_id}/repos`) : Promise.resolve(null)), [run.repo_id]);
  const isGithub = repo.data?.repos.find((r) => r.id === run.repo_id)?.provider === 'github';
  return (
    <Modal
      title="Push the run’s changes"
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
                  const r = await api.post(`/api/runs/${run.id}/push`, { branch, message, createPr });
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
          <p className="muted">All changes in the run’s working copy are committed and pushed to a new branch. The default branch is never pushed to.</p>
          <Field label="Branch">{(id) => <input id={id} className="input mono" value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
          <Field label="Commit message">{(id) => <textarea id={id} className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
          {isGithub ? <Toggle checked={createPr} onChange={setCreatePr} label="Open a draft pull request on GitHub" /> : null}
          <ErrorNote error={error} />
        </div>
      )}
    </Modal>
  );
}
