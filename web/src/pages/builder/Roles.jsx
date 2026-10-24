import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { href } from '../../lib/router.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, hueFor } from '../../lib/util.js';
import { Badge, Button, Spinner, Toggle, useUi } from '../../components/ui.jsx';

/* ---------------- Roles ---------------- */

export function Roles() {
  const { project, canEdit, members } = useProject();
  const { toast, confirm } = useUi();
  const templates = useLoad(() => api.get('/api/roles'), []);
  const applied = useLoad(() => api.get(`/api/projects/${project.id}/roles`), [project.id]);
  useProjectEvents(['builder.updated'], () => applied.reload(true));
  const [busy, setBusy] = useState(null);
  const state = new Map((applied.data?.applied || []).map((a) => [a.role_key, a]));
  const people = members.filter((m) => m.role);

  const act = async (key, fn, msg) => {
    setBusy(key);
    try {
      await fn();
      toast(msg);
      applied.reload(true);
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(null);
    }
  };

  if (!templates.data) return <Spinner />;
  return (
    <div className="stack-lg">
      <p className="muted">
        Adding a role writes its agent (or, for a team, its lead and specialists) and its skills into this project. The main agent delegates to a role when a task matches it. Edit them afterwards on the Agents and Skills tabs.
      </p>
      <div className="role-grid">
        {templates.data.roles.map((t) => {
          const a = state.get(t.key);
          const staff = people.filter((m) => m.role.toLowerCase().includes(t.title.toLowerCase().split(' ')[0]));
          return (
            <article key={t.key} className={cx('role-card', a && 'is-added', a && !a.enabled && 'is-off')} style={{ '--role-h': hueFor(t.agent.name) }}>
              <header>
                <h2>{t.title}</h2>
                {a ? <Badge tone={a.enabled ? 'ok' : 'muted'}>{a.enabled ? 'In use' : 'Turned off'}</Badge> : null}
              </header>
              <p>{t.summary}</p>
              <dl className="role-facts">
                <div><dt>Model</dt><dd>{t.agent.model}</dd></div>
                <div><dt>Tools</dt><dd>{t.agent.tools.map((x) => (x.startsWith('Agent(') ? 'Agent' : x)).join(', ')}</dd></div>
                {t.team?.length ? <div><dt>Team</dt><dd>{[t.agent.name, ...t.team.map((a) => a.name)].join(', ')}</dd></div> : null}
                {t.skills.length ? <div><dt>Skills</dt><dd>{t.skills.map((s) => s.name).join(', ')}</dd></div> : null}
                {staff.length ? <div><dt>People</dt><dd>{staff.map((s) => s.name).join(', ')}</dd></div> : null}
              </dl>
              {canEdit ? (
                <div className="row tight wrap">
                  {!a ? (
                    <Button variant="primary" size="sm" icon="plus" busy={busy === t.key} onClick={() => act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/apply`), `${t.title} added`)}>
                      Add to project
                    </Button>
                  ) : (
                    <>
                      <Toggle
                        checked={Boolean(a.enabled)}
                        label="Available to agents"
                        onChange={(on) => act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/enabled`, { enabled: on }), on ? `${t.title} turned on` : `${t.title} turned off`)}
                      />
                      <a className="btn btn-ghost btn-sm" href={href(project.id, 'builder', 'agents', t.agent.name)}>
                        Edit agent
                      </a>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Reset role', message: `Overwrite ${t.agent.name}${t.team?.length ? `, its ${t.team.length} team agents` : ''} and its skills with the original template? Your edits to them are lost (they stay in the project’s git history).`, confirmLabel: 'Reset' }))) return;
                          act(t.key, () => api.post(`/api/projects/${project.id}/roles/${t.key}/apply`), `${t.title} reset`);
                        }}
                      >
                        Reset
                      </Button>
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Remove role', message: `Remove ${t.agent.name}${t.team?.length ? ` and its ${t.team.length} team agents` : ''} and its skills from this project?`, confirmLabel: 'Remove', danger: true }))) return;
                          act(t.key, () => api.del(`/api/projects/${project.id}/roles/${t.key}`), `${t.title} removed`);
                        }}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
