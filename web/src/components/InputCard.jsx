import { useState } from 'react';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { cx, timeAgo } from '../lib/util.js';
import { toolSummary } from '../lib/tree.js';
import { Icon } from './Icon.jsx';
import { Badge, Button, ErrorNote } from './ui.jsx';

/** A pending agent question or tool approval, answerable inline. */
export function InputCard({ input, projectId, canApprove, onDone, compact }) {
  const answered = input.status !== 'pending';
  return (
    <article className={cx('input-card', input.type === 'approval' ? 'is-approval' : 'is-question', answered && 'is-answered')}>
      <header className="input-card-head">
        <Icon name={input.type === 'approval' ? 'lock' : 'question'} size={17} />
        <strong>{input.type === 'approval' ? `Allow ${input.tool_name}?` : input.payload?.source === 'qa' ? 'Question for the team' : 'The agent needs your input'}</strong>
        {input.run_id && !compact ? (
          <a className="small" href={href(projectId, 'runs', input.run_id)}>
            {input.run_title ? `from “${input.run_title}”` : 'open run'}
          </a>
        ) : null}
        <span className="muted small push">{timeAgo(input.created_at)}</span>
        {answered ? <Badge status={input.status} /> : null}
      </header>
      {input.type === 'approval' ? (
        <ApprovalBody input={input} canApprove={canApprove} onDone={onDone} />
      ) : (
        <QuestionBody input={input} onDone={onDone} />
      )}
    </article>
  );
}

function QuestionBody({ input, onDone }) {
  const questions = input.payload?.questions || [];
  const [answers, setAnswers] = useState({});
  const [other, setOther] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const answered = input.status !== 'pending';

  if (answered) {
    const resp = input.response || {};
    return (
      <div className="input-answers">
        {questions.map((q) => (
          <p key={q.question}>
            <span className="muted">{q.question}</span>
            <br />
            <strong>{[].concat(resp.answers?.[q.question] ?? '—').join(', ')}</strong>
          </p>
        ))}
        {resp.response ? <p>{resp.response}</p> : null}
        {input.answered_by_name ? <p className="muted small">Answered by {input.answered_by_name}</p> : null}
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    const out = {};
    for (const q of questions) {
      const picked = answers[q.question];
      const typed = (other[q.question] || '').trim();
      if (q.multiSelect) {
        const list = [...(picked || [])].filter((x) => x !== '__other');
        if ((picked || []).includes('__other') && typed) list.push(typed);
        if (list.length) out[q.question] = list;
      } else if (picked === '__other' || (!q.options?.length && typed)) {
        if (typed) out[q.question] = typed;
      } else if (picked) out[q.question] = picked;
    }
    try {
      await api.post(`/api/inputs/${input.id}/answer`, { answers: out });
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="input-body">
      {questions.map((q, qi) => {
        const name = `${input.id}-${qi}`;
        const picked = answers[q.question];
        const opts = q.options || [];
        return (
          <fieldset key={q.question} className="q-block">
            <legend>
              {q.header ? <span className="q-chip">{q.header}</span> : null}
              {q.question}
            </legend>
            {opts.map((o) => {
              const checked = q.multiSelect ? (picked || []).includes(o.label) : picked === o.label;
              return (
                <label key={o.label} className={cx('choice', checked && 'is-checked')}>
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={name}
                    checked={checked}
                    onChange={(e) => {
                      if (q.multiSelect) {
                        const set = new Set(picked || []);
                        e.target.checked ? set.add(o.label) : set.delete(o.label);
                        setAnswers({ ...answers, [q.question]: [...set] });
                      } else setAnswers({ ...answers, [q.question]: o.label });
                    }}
                  />
                  <span>
                    <strong>{o.label}</strong>
                    {o.description ? <span className="muted"> {o.description}</span> : null}
                  </span>
                </label>
              );
            })}
            {opts.length ? (
              <label className={cx('choice', (q.multiSelect ? (picked || []).includes('__other') : picked === '__other') && 'is-checked')}>
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={name}
                  checked={q.multiSelect ? (picked || []).includes('__other') : picked === '__other'}
                  onChange={(e) => {
                    if (q.multiSelect) {
                      const set = new Set(picked || []);
                      e.target.checked ? set.add('__other') : set.delete('__other');
                      setAnswers({ ...answers, [q.question]: [...set] });
                    } else setAnswers({ ...answers, [q.question]: '__other' });
                  }}
                />
                <span>Something else</span>
              </label>
            ) : null}
            {!opts.length || (q.multiSelect ? (picked || []).includes('__other') : picked === '__other') ? (
              <textarea
                className="input"
                rows={2}
                aria-label={`Your answer to: ${q.question}`}
                placeholder="Type your answer"
                value={other[q.question] || ''}
                onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
              />
            ) : null}
          </fieldset>
        );
      })}
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" busy={busy} onClick={submit}>
          Send answer
        </Button>
        <span className="muted small">Your answer is saved to the decisions log so agents don’t ask again.</span>
      </div>
    </div>
  );
}

function ApprovalBody({ input, canApprove, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const tool = input.payload?.toolName || input.tool_name;
  const toolInput = input.payload?.input || {};
  const answered = input.status !== 'pending';
  const send = async (decision, remember) => {
    setBusy(decision + (remember ? '-all' : ''));
    setError(null);
    try {
      await api.post(`/api/inputs/${input.id}/answer`, { decision, remember, message: reason });
      onDone?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="input-body">
      <p className="tool-line">
        <code>{tool}</code> <span className="muted">{toolSummary(tool, toolInput)}</span>
      </p>
      {toolInput.content || toolInput.new_string || toolInput.command ? (
        <pre className="preview">{String(toolInput.content ?? toolInput.new_string ?? toolInput.command).slice(0, 4000)}</pre>
      ) : null}
      {answered ? (
        <p className="small">
          {input.response?.decision === 'allow' ? 'Allowed' : 'Denied'}
          {input.response?.remember ? ' for the rest of this run' : ''}
          {input.answered_by_name ? ` by ${input.answered_by_name}` : ''}
          {input.response?.message ? `: ${input.response.message}` : ''}
        </p>
      ) : canApprove ? (
        <>
          <input className="input" placeholder="Reason or instruction (optional, shown to the agent if you deny)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <ErrorNote error={error} />
          <div className="row wrap">
            <Button variant="primary" icon="check" busy={busy === 'allow'} onClick={() => send('allow', false)}>
              Allow once
            </Button>
            <Button busy={busy === 'allow-all'} onClick={() => send('allow', true)}>
              Allow {tool} for this run
            </Button>
            <Button variant="danger-ghost" icon="x" busy={busy === 'deny'} onClick={() => send('deny', false)}>
              Deny
            </Button>
          </div>
        </>
      ) : (
        <p className="muted small">An editor needs to approve this.</p>
      )}
    </div>
  );
}
