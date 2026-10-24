import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { href, runHref } from '../../lib/router.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, hueFor } from '../../lib/util.js';
import { Button, ErrorNote } from '../../components/ui.jsx';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/* ---------------- Agents ---------------- */

export function useBuilderData() {
  const { project } = useProject();
  const agents = useLoad(() => api.get(`/api/projects/${project.id}/agents`), [project.id]);
  const skills = useLoad(() => api.get(`/api/projects/${project.id}/skills`), [project.id]);
  const tools = useLoad(() => api.get('/api/tools'), []);
  useProjectEvents(['builder.updated'], () => {
    agents.reload(true);
    skills.reload(true);
  });
  return { agents, skills, tools };
}

export function ItemList({ items, selected, kind, onNew, onImport, onDescribe, onCatalog, canEdit, projectId }) {
  return (
    <aside className="item-list">
      {onCatalog ? (
        <Button icon="builder" size="sm" variant={selected === 'catalog' ? 'primary' : 'default'} onClick={onCatalog}>
          Browse templates
        </Button>
      ) : null}
      {canEdit ? (
        <div className="stack" style={{ gap: '0.3rem' }}>
          <Button icon="plus" size="sm" onClick={onNew}>
            New {kind === 'agents' ? 'agent' : 'skill'}
          </Button>
          {onDescribe ? (
            <Button icon="question" size="sm" variant="ghost" onClick={onDescribe} title={`Describe ${kind === 'agents' ? 'an agent' : 'a skill'} in plain language`}>
              Describe…
            </Button>
          ) : null}
          {onImport ? (
            <Button icon="upload" size="sm" variant="ghost" onClick={onImport} aria-label="Import from .claude folder or zip">
              Import
            </Button>
          ) : null}
        </div>
      ) : null}
      <ul>
        {items.map((a) => (
          <li key={a.name}>
            <a href={href(projectId, 'builder', kind, a.name)} className={cx('item', selected === a.name && 'is-active', !a.enabled && 'is-off')} style={{ '--role-h': hueFor(a.name) }}>
              <span className="item-swatch" aria-hidden="true" />
              <span className="item-name">{a.name}</span>
              {a.role ? <span className="muted small">role</span> : null}
              {!a.enabled ? <span className="muted small">off</span> : null}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function TestPanel({ type, name }) {
  const { project } = useProject();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <section className="panel test-panel">
      <h3>Try it</h3>
      <p className="muted small">Starts a plan-only run on Haiku that must use this {type}. Nothing in the project changes.</p>
      <div className="row">
        <input className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={type === 'agent' ? 'Summarise the refund rules' : 'Apply this skill to the refunds section'} aria-label="Test task" />
        <Button
          icon="play"
          busy={busy}
          disabled={!prompt.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const { run } = await api.post(`/api/projects/${project.id}/builder/test`, { type, name, prompt });
              window.location.hash = runHref(project.id, run.id);
            } catch (e) {
              setError(e);
              setBusy(false);
            }
          }}
        >
          Run test
        </Button>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}
