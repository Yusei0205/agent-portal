/**
 * Execution View — what the agent did, as numbers and a timeline instead of a conversation:
 * its task list with progress, tool-call counts, files changed and every tool call with its duration.
 * Everything comes from the session's events (lib/execution-summary.js); nothing extra is fetched.
 */

import { useMemo, useState } from 'react';
import { m } from 'motion/react';
import { summarizeExecution } from '../../lib/execution-summary.js';
import { deriveStages } from '../../lib/execution-stages.js';
import { formatDuration } from '../../lib/agent-timeline.js';
import { AiCore } from '../../components/AiCore.jsx';

/** The AI core's state for a session status. */
function coreState(status) {
  if (status === 'running' || status === 'pending') return 'running';
  if (status === 'done') return 'success';
  if (status === 'failed') return 'failed';
  return 'idle';
}

/** Planning → Working → Checking → Done, from what the session really did. The fill slides to the current stage. */
function StageStrip({ stages, progress }) {
  return (
    <div className="stage-strip" role="list" aria-label="Stages">
      <span className="stage-track" aria-hidden="true" />
      <m.span
        className="stage-fill"
        aria-hidden="true"
        initial={false}
        animate={{ scaleX: progress }}
        transition={{ type: 'spring', stiffness: 120, damping: 20 }}
      />
      {stages.map((s, i) => (
        <div key={s.key} role="listitem" className={`stage-item is-${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined}>
          <m.span
            className="stage-dot"
            initial={false}
            animate={{ scale: s.state === 'active' ? 1.12 : 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 18 }}
          >
            {s.state === 'done' ? '✓' : s.state === 'failed' ? '!' : i + 1}
          </m.span>
          <span className="stage-label">{s.label}<span className="sr-only"> ({s.state})</span></span>
        </div>
      ))}
    </div>
  );
}

const STATUS_LABEL = { done: 'done', active: 'in progress', pending: 'pending' };

function Ring({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className="exe-ring" viewBox="0 0 64 64" role="img" aria-label={`${pct}% of the task list done`}>
      <circle cx="32" cy="32" r={r} className="exe-ring-track" />
      <circle cx="32" cy="32" r={r} className="exe-ring-fill" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle" className="exe-ring-text">{pct}%</text>
    </svg>
  );
}

function Tile({ label, value, tone }) {
  return (
    <div className={`exe-tile${tone ? ` exe-tile--${tone}` : ''}`}>
      <span className="exe-tile-value">{value}</span>
      <span className="exe-tile-label">{label}</span>
    </div>
  );
}

const SHOWN_CALLS = 60;

/**
 * @param {{
 *   events: any[],                          // events in time order, tool calls already paired (tool-start with _end)
 *   running?: boolean,
 *   onOpenFile?: (path: string) => void,
 * }} props
 */
export function SessionExecution({ events, running = false, status = '', planMode = false, onOpenFile }) {
  const sum = useMemo(() => summarizeExecution(events), [events]);
  const stage = useMemo(() => deriveStages(sum, { status: status || (running ? 'running' : ''), planMode }), [sum, status, running, planMode]);
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('all'); // all | failed | running
  const { counts, todos, byTool, files, calls } = sum;

  const top = (
    <div className="exe-top">
      <AiCore state={coreState(status || (running ? 'running' : ''))} size={96} />
      <StageStrip stages={stage.stages} progress={stage.progress} />
    </div>
  );

  if (!counts.total && !todos) {
    return (
      <div className="exe exe--empty" role="region" aria-label="Execution view">
        {top}
        <p className="muted">Nothing has run yet. Tool calls, the task list and changed files appear here as the agent works.</p>
      </div>
    );
  }

  const newestFirst = [...calls].reverse().filter((c) => filter === 'all' || c.status === filter);
  const shown = all ? newestFirst : newestFirst.slice(0, SHOWN_CALLS);
  const maxCount = byTool[0]?.count || 1;

  return (
    <div className="exe" role="region" aria-label="Execution view">
      {top}
      <div className="exe-tiles">
        <Tile label="tool calls" value={counts.total} />
        <Tile label="running" value={counts.running} tone={counts.running ? 'live' : undefined} />
        <Tile label="failed" value={counts.failed} tone={counts.failed ? 'bad' : undefined} />
        <Tile label="files changed" value={files.length} />
        <Tile label={running ? 'elapsed so far' : 'elapsed'} value={sum.elapsedMs === null ? '–' : formatDuration(sum.elapsedMs)} />
      </div>

      <section className="exe-section" aria-label="Tasks">
        <h3 className="exe-h">Tasks{todos && <span className="exe-h-meta">{todos.done} / {todos.total} done</span>}</h3>
        {todos ? (
          <div className="exe-tasks">
            <Ring done={todos.done} total={todos.total} />
            <ul className="exe-task-list">
              {todos.items.map((t, i) => (
                <li key={`${i}-${t.text}`} className={`exe-task exe-task--${t.status}`}>
                  <span className="exe-task-mark" aria-hidden="true">{t.status === 'done' ? '✓' : t.status === 'active' ? '●' : '○'}</span>
                  <span className="exe-task-text">{t.text}</span>
                  <span className="exe-task-state">{STATUS_LABEL[t.status]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted exe-note">The agent has not written a task list in this session.</p>
        )}
      </section>

      <div className="exe-cols">
        <section className="exe-section" aria-label="Tools used">
          <h3 className="exe-h">Tools used</h3>
          <ul className="exe-bars">
            {byTool.map((t) => (
              <li key={t.name} className="exe-bar-row">
                <span className="exe-bar-name">{t.name}</span>
                <span className="exe-bar"><i style={{ width: `${Math.max(4, (t.count / maxCount) * 100)}%` }} className={t.failed ? 'is-bad' : ''} /></span>
                <span className="exe-bar-count">{t.count}{t.failed ? ` · ${t.failed} failed` : ''}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="exe-section" aria-label="Files changed">
          <h3 className="exe-h">Files changed{files.length > 0 && <span className="exe-h-meta">{files.length}</span>}</h3>
          {files.length ? (
            <ul className="exe-files">
              {files.map((f) => (
                <li key={f.path}>
                  <button type="button" className="exe-file" onClick={() => onOpenFile?.(f.path)} disabled={!onOpenFile} title={f.path}>
                    <span className="exe-file-path">{f.path}</span>
                    <span className="exe-file-edits">{f.edits}×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted exe-note">No files written yet.</p>
          )}
        </section>
      </div>

      <section className="exe-section" aria-label="Timeline">
        <h3 className="exe-h">
          Timeline
          <span className="exe-filter" role="group" aria-label="Filter tool calls">
            {['all', 'running', 'failed'].map((f) => (
              <button key={f} type="button" className={filter === f ? 'is-active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </span>
        </h3>
        {shown.length === 0 ? (
          <p className="muted exe-note">No {filter} tool calls.</p>
        ) : (
          <ol className="exe-timeline">
            {shown.map((c) => (
              <li key={c.id} className={`exe-call exe-call--${c.status}`}>
                <span className="exe-call-dot" aria-label={c.status} />
                <span className="exe-call-name">{c.name}</span>
                <span className="exe-call-arg" title={c.preview}>{c.preview}</span>
                <span className="exe-call-time">{c.durationMs === null ? (c.status === 'running' ? 'running…' : '') : formatDuration(c.durationMs)}</span>
              </li>
            ))}
          </ol>
        )}
        {!all && newestFirst.length > SHOWN_CALLS && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(true)}>Show all {newestFirst.length}</button>
        )}
      </section>
    </div>
  );
}
