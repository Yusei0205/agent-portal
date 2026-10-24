import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { timeAgo } from '../../lib/util.js';
import { CONTEXT_ICON, CONTEXT_KIND_LABEL, ContextPicker, sendFiles } from '../../components/ContextPicker.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Button, Empty, ErrorNote, Spinner, useUi } from '../../components/ui.jsx';

/* ---------------- Context ---------------- */

/** Everything the agents were given to read, who added it, and a way to add or remove items. */
export function ContextTab({ w, canEdit }) {
  const { project } = useProject();
  const { toast } = useUi();
  const ctx = useLoad(() => api.get(`/api/workflows/${w.id}/context`), [w.id, w.context_count]);
  const [picking, setPicking] = useState(false);
  const add = async (item) => {
    try {
      if (item.kind === 'file') await sendFiles(w.id, [item]);
      else await api.post(`/api/workflows/${w.id}/context`, { kind: item.kind, ref: item.ref, title: item.title, body: item.body });
      ctx.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const remove = async (c) => {
    try {
      await api.del(`/api/workflows/${w.id}/context/${c.id}`);
      ctx.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  if (ctx.error) return <ErrorNote error={ctx.error} />;
  if (!ctx.data) return <Spinner />;
  const items = ctx.data.context;
  return (
    <div className="stack">
      <div className="row between wrap">
        <p className="muted small">The agents read this before every iteration. Items added since the last iteration are pointed out to them as new.</p>
        {canEdit ? (
          <Button icon="plus" onClick={() => setPicking(true)}>
            Add context
          </Button>
        ) : null}
      </div>
      {!items.length ? (
        <Empty icon="knowledge" title="No context yet">
          Attach documents, files, notes, links or earlier work so the agents start from what you already know.
        </Empty>
      ) : (
        <ul className="ctx-list">
          {items.map((c) => (
            <li key={c.id} className="ctx-item">
              <Icon name={CONTEXT_ICON[c.kind] ?? 'file'} size={17} />
              <div className="ctx-item-main">
                <strong>{c.title}</strong>
                <span className="muted small">
                  {CONTEXT_KIND_LABEL[c.kind] ?? c.kind}
                  {c.path ? (
                    <>
                      {' · '}
                      <code>{c.path}</code>
                    </>
                  ) : null}
                  {c.kind === 'url' ? (
                    <>
                      {' · '}
                      <a href={c.ref} target="_blank" rel="noopener noreferrer">
                        {c.ref}
                      </a>
                    </>
                  ) : null}
                  {' · '}added by {c.created_by_name || 'someone'} {timeAgo(c.created_at)}
                  {c.seen ? '' : ' · not read yet'}
                </span>
                {c.body ? <p className="ctx-item-body">{c.body}</p> : null}
              </div>
              {canEdit ? (
                <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(c)} aria-label={`Remove ${c.title}`}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {picking ? <ContextPicker projectId={project.id} excludeSessionId={w.id} onAdd={add} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
