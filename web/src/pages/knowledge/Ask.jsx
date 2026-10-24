import { useCallback, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { go, href } from '../../lib/router.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, timeAgo } from '../../lib/util.js';
import { Markdown } from '../../components/Markdown.jsx';
import { InputCard } from '../../components/InputCard.jsx';
import { Button, Empty, ErrorNote, Note, Segmented, Spinner, useUi } from '../../components/ui.jsx';

/* ---------------- Ask ---------------- */

export function Ask() {
  const { project } = useProject();
  const { toast } = useUi();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [inboxQ, setInboxQ] = useState('');
  const [sent, setSent] = useState(false);
  const history = useLoad(() => api.get(`/api/projects/${project.id}/qa`), [project.id]);

  const ask = async (e) => {
    e?.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      const r = await api.post(`/api/projects/${project.id}/ask`, { question });
      setAnswer({ ...r, question });
      setInboxQ(r.suggestedQuestion || question);
      history.reload(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const citeTransform = useCallback((t) => t.replace(/\[(\d{1,2})\]/g, (_m, n) => `<sup class="cite" data-n="${n}"><a href="#">${n}</a></sup>`), []);
  const [focusN, setFocusN] = useState(null);

  return (
    <div className="ask-layout">
      <div className="stack-lg">
        <form className="ask-box" onSubmit={ask}>
          <label htmlFor="ask-q" className="field-label">Ask anything about this project</label>
          <textarea id="ask-q" className="input" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Who has to approve a refund above 500 USD?"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }} />
          <div className="row">
            <Button variant="primary" type="submit" busy={busy} disabled={!question.trim()}>Ask</Button>
            <span className="muted small">Answers come only from the project documents and decisions, with sources.</span>
          </div>
        </form>
        <ErrorNote error={error} />
        {answer ? (
          <section className="answer">
            <Markdown text={answer.answer} transform={citeTransform} onCite={setFocusN} />
            {answer.sources.length ? (
              <ol className="sources">
                {answer.sources.map((s) => (
                  <li key={s.n} className={cx(s.cited && 'is-cited', focusN === s.n && 'is-focus')}>
                    <span className="src-n">{s.n}</span>
                    <a href={href(project.id, 'knowledge', 'doc', s.docId, s.anchor)}>{s.docName} › {s.heading}</a>
                  </li>
                ))}
              </ol>
            ) : null}
            {answer.missing ? (
              <Note tone="warn" icon="question">
                <p><strong>The documents don't answer this yet.</strong> Send it to the team as a question; the answer goes into the decisions log, so agents and future answers can use it.</p>
                <div className="row">
                  <input className="input" value={inboxQ} onChange={(e) => setInboxQ(e.target.value)} aria-label="Question for the team" />
                  <Button disabled={sent || !inboxQ.trim()} onClick={async () => {
                    try {
                      await api.post(`/api/projects/${project.id}/inbox`, { question: inboxQ });
                      setSent(true);
                      toast('Sent to team questions');
                    } catch (e) {
                      toast(e.message, 'danger');
                    }
                  }}>{sent ? 'Sent' : 'Ask the team'}</Button>
                </div>
              </Note>
            ) : null}
          </section>
        ) : null}
      </div>
      <aside className="side">
        <h2 className="side-title">Recent questions</h2>
        {history.data?.history?.length ? (
          <ul className="plain-list">
            {history.data.history.map((h) => (
              <li key={h.id}>
                <button type="button" className="linkish" onClick={() => setQuestion(h.meta?.question || h.title.replace(/^Question: /, ''))}>
                  {h.meta?.question || h.title}
                </button>
                <span className="muted small">{h.asked_by}, {timeAgo(h.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Questions people ask show up here.</p>
        )}
      </aside>
    </div>
  );
}

/* ---------------- Team questions ---------------- */

export function TeamQuestions() {
  const { project, canEdit } = useProject();
  const [filter, setFilter] = useState('pending');
  const inputs = useLoad(() => api.get(`/api/projects/${project.id}/inputs?type=question&status=${filter === 'pending' ? 'pending' : 'all'}`), [project.id, filter]);
  useProjectEvents(['input.created', 'input.resolved'], () => inputs.reload(true));
  const { toast } = useUi();
  const list = inputs.data?.inputs || [];
  return (
    <div className="stack-lg">
      <div className="row between">
        <p className="muted">Questions agents asked during runs, and questions people sent from Ask. Answers go into the decisions log.</p>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'pending', label: 'Open' }, { value: 'all', label: 'All' }]} label="Filter" />
      </div>
      {inputs.loading && !inputs.data ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty icon="inbox" title={filter === 'pending' ? 'No team questions waiting' : 'Nothing here yet'}>
          When an agent is unsure, it asks here instead of guessing.
        </Empty>
      ) : (
        <div className="stack">
          {list.map((i) => (
            <div key={i.id} className="inbox-item">
              <InputCard input={i} projectId={project.id} canApprove={canEdit} onDone={() => inputs.reload(true)} />
              {i.status === 'pending' && !i.run_id && canEdit ? (
                <Button variant="ghost" size="sm" onClick={async () => {
                  await api.post(`/api/inputs/${i.id}/dismiss`);
                  toast('Question dismissed');
                  inputs.reload(true);
                }}>Dismiss</Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Decisions ---------------- */

export function Decisions() {
  const { project } = useProject();
  const docs = useLoad(() => api.get(`/api/projects/${project.id}/documents`), [project.id]);
  const decisionsDoc = useMemo(() => docs.data?.documents.find((d) => d.kind === 'decisions'), [docs.data]);
  const doc = useLoad(() => (decisionsDoc ? api.get(`/api/documents/${decisionsDoc.id}`) : Promise.resolve(null)), [decisionsDoc?.id, decisionsDoc?.updated_at]);
  useProjectEvents(['document.updated'], () => docs.reload(true));
  if (!doc.data) return <Spinner />;
  return (
    <div className="doc-body narrow-doc">
      <Markdown text={doc.data.markdown} />
    </div>
  );
}
