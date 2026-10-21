import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp, useProject } from '../../lib/context.js';
import { runHref, sessionHref } from '../../lib/router.js';
import { useRunStream } from '../../lib/useRunStream.js';
import { buildTree } from '../../lib/tree.js';
import { cx, dateTime, duration, hueFor, money, tokens } from '../../lib/util.js';
import { AgentView } from '../AgentCanvas.jsx';
import { ConnectionBadge } from '../ConnectionBadge.jsx';
import { Icon } from '../Icon.jsx';
import { InputCard } from '../InputCard.jsx';
import { Markdown } from '../Markdown.jsx';
import { JiraRunBar } from '../../pages/Tickets.jsx';
import { Badge, Button, ErrorNote, Note, Spinner, Tabs, useUi } from '../ui.jsx';
import { Timeline } from './Timeline.jsx';
import { Changes } from './Changes.jsx';
import { PushDialog } from './PushDialog.jsx';

export const MODES = [
  { value: 'default', label: 'Ask before changes', hint: 'Edits and commands wait for your approval.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: "File edits in the run's working copy go ahead; commands still ask." },
  { value: 'plan', label: 'Plan only', hint: 'Reads and plans; changes nothing.' },
];
const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.value, m.label]));
export const KIND_LABEL = { chat: 'Run', test: 'Test', review: 'Review' };

/** One run: its agents, what each did, the result, the changes, follow-ups and push. */
export function RunView({ runId }) {
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
            {run.meta?.workflowId ? (
              <a className="small" href={sessionHref(project.id, run.meta.workflowId, { run: run.id })}>
                Part of a session: open it
              </a>
            ) : null}
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

      {tree.root.totals.subagents || active ? <AgentView tree={tree} selected={selectedNode} onSelect={setSelectedNode} live={active} /> : null}

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
                    <a key={c.id} href={runHref(project.id, c.id)}>
                      {c.title}{' '}
                    </a>
                  ))}
                </p>
              ) : null}
              {run.resume_of ? (
                <p className="small">
                  Continues <a href={runHref(project.id, run.resume_of)}>an earlier run</a>.
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

function ResultPanel({ run }) {
  if (!run.result && ['queued', 'running', 'waiting'].includes(run.status)) return <p className="muted pad-sm">The result appears here when the run finishes.</p>;
  if (!run.result) return <p className="muted pad-sm">No result text.</p>;
  return (
    <div className="pad-sm doc-body">
      <Markdown text={run.result} />
    </div>
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
          window.location.hash = runHref(project.id, r.run.id);
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
