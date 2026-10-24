import { useMemo, useState } from 'react';
import { useApp, useProject } from '../../lib/context.js';
import { useRunStream } from '../../lib/useRunStream.js';
import { buildTree } from '../../lib/tree.js';
import { cx, money, timeAgo } from '../../lib/util.js';
import { AgentView } from '../../components/AgentCanvas.jsx';
import { InputCard } from '../../components/InputCard.jsx';
import { Timeline } from '../../components/run/Timeline.jsx';
import { ErrorNote, Note, Spinner } from '../../components/ui.jsx';

/* ---------------- Live ---------------- */

/** The agents of one run of the session, live, with what the selected one is doing. */
/**
 * What people asked for, as they typed it: the session's goal, and the instructions an iteration picked up (those sent
 * after the previous iteration started and before this one did). Instructions not picked up yet are listed as waiting.
 */
export function askedFor(w, events, runId) {
  const starts = events.filter((e) => e.kind === 'iteration' && /started$/.test(e.body) && e.run_id);
  const at = starts.findIndex((e) => e.run_id === runId);
  const human = events.filter((e) => e.kind === 'human');
  const from = at > 0 ? starts[at - 1].id : 0;
  const to = at >= 0 ? starts[at].id : Infinity;
  return {
    goal: w.goal,
    messages: human.filter((e) => e.id > from && e.id < to),
    waiting: runId === w.last_run_id ? human.filter((e) => !e.consumed) : [],
  };
}

function AskedCard({ asked }) {
  const msg = (e) => (
    <li key={e.id} className="ws-asked-msg">
      <span className="muted small">
        {e.data?.by || 'A teammate'} · {timeAgo(e.created_at)}
      </span>
      <p className="ws-asked-text">{e.body}</p>
    </li>
  );
  return (
    <section className="panel ws-asked" aria-label="What was asked">
      <details open={asked.messages.length === 0}>
        <summary className="small">
          <strong>Goal</strong>
        </summary>
        <p className="ws-asked-text">{asked.goal}</p>
      </details>
      {asked.messages.length ? (
        <>
          <h3 className="small">Your message{asked.messages.length === 1 ? '' : 's'} for this iteration</h3>
          <ul className="plain-list stack">{asked.messages.map(msg)}</ul>
        </>
      ) : null}
      {asked.waiting.length ? (
        <>
          <h3 className="small">Waiting for the next iteration</h3>
          <ul className="plain-list stack">{asked.waiting.map(msg)}</ul>
        </>
      ) : null}
    </section>
  );
}

export function LiveTab({ runId, isLatest, runs, link, asked }) {
  const { meta } = useApp();
  const { project, canEdit, reload: reloadProject } = useProject();
  const data = useRunStream(runId);
  const [selected, setSelected] = useState('main');
  const run = data.run;
  const tree = useMemo(() => buildTree(data.events, { prices: meta.prices, runStatus: run?.status }), [data.events, meta.prices, run?.status]);
  if (data.error) return <ErrorNote error={data.error} />;
  if (!run) return <Spinner />;
  const node = tree.nodes.get(selected) || tree.root;
  const pending = data.inputs.filter((i) => i.status === 'pending');
  return (
    <div className="stack">
      {pending.length ? (
        <section className="pending" aria-label="Waiting for you">
          {pending.map((i) => (
            <InputCard key={i.id} input={i} projectId={project.id} canApprove={canEdit} compact onDone={() => { data.reload(); reloadProject(); }} />
          ))}
        </section>
      ) : null}
      <IterationStrip runs={runs} current={runId} link={link} />
      {!isLatest ? <Note tone="info" icon="alert">You are looking at an earlier iteration. <a href={link({})}>Back to the latest</a></Note> : null}
      {asked ? <AskedCard asked={asked} /> : null}
      <div className="ws-live">
        <div className="ws-graph">
          <AgentView tree={tree} selected={selected} onSelect={setSelected} live={['queued', 'running', 'waiting'].includes(run.status)} />
        </div>
        <section className="panel ws-inspector" aria-label="Selected agent">
          <h2>{node.kind === 'main' ? 'Main agent' : node.label}</h2>
          <p className="muted small">
            {node.status} · {node.toolCount} tool{node.toolCount === 1 ? '' : 's'}
            {node.cost ? ` · ≈${money(node.cost)}` : ''}
          </p>
          <Timeline node={node} tree={tree} onSelect={setSelected} inputs={data.inputs} />
        </section>
      </div>
    </div>
  );
}

const iterationOf = (title) => Number(/iteration (\d+)/.exec(title || '')?.[1] ?? 0);

/** One chip per iteration; the chosen one is shown above. */
function IterationStrip({ runs, current, link }) {
  if (runs.length < 2) return null;
  const ordered = [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <nav className="ws-iters" aria-label="Iterations">
      {ordered.map((r, i) => (
        <a key={r.id} href={link({ run: r.id })} className={cx('ws-iter', `ws-iter-${r.status}`, r.id === current && 'is-active')} aria-current={r.id === current ? 'true' : undefined} title={`${r.title} · ${r.status}`}>
          {iterationOf(r.title) || i + 1}
        </a>
      ))}
    </nav>
  );
}
