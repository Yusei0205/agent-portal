import { useEffect, useRef, useState } from 'react';
import { toolSummary } from '../../lib/tree.js';
import { cx } from '../../lib/util.js';
import { Icon } from '../Icon.jsx';
import { Markdown } from '../Markdown.jsx';

/** What one agent of a run did, step by step. */
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
