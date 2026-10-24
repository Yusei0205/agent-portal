import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp, useProject } from '../lib/context.js';
import { go, href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { Button, Empty, PageHeader, Segmented, Spinner, Tabs, useUi } from '../components/ui.jsx';
import { Roles } from './builder/Roles.jsx';
import { Agents } from './builder/Agents.jsx';
import { Skills } from './builder/Skills.jsx';
import { KiroAgents } from './builder/Kiro.jsx';

export function Builder({ route }) {
  const { project } = useProject();
  // Claude Code agents and skills live in .claude, Kiro's in .kiro: each engine reads only its own.
  const engine = route.rest[0] === 'kiro' ? 'kiro' : 'claude';
  const tab = ['agents', 'skills', 'library'].includes(route.rest[0]) ? route.rest[0] : 'roles';
  return (
    <div className="page wide">
      <PageHeader
        title="Agents and skills"
        sub={
          engine === 'kiro'
            ? 'Kiro agents in Kiro’s own format, with the skills and steering they load. Stored in the project’s .kiro folder; Kiro runs use them when there are any.'
            : 'Role agents the main agent can delegate to, and skills that teach them how this project works. Stored in the project’s .claude folder.'
        }
      />
      <Segmented
        value={engine}
        onChange={(v) => (v === 'kiro' ? go(project.id, 'builder', 'kiro') : go(project.id, 'builder'))}
        label="Engine"
        options={[
          { value: 'claude', label: 'Claude Code' },
          { value: 'kiro', label: 'Kiro' },
        ]}
      />
      {engine === 'kiro' ? (
        <KiroAgents selected={route.rest[1]} />
      ) : (
        <>
          <Tabs
            value={tab}
            tabs={[
              { value: 'roles', label: 'Roles', href: href(project.id, 'builder') },
              { value: 'agents', label: 'Agents', href: href(project.id, 'builder', 'agents') },
              { value: 'skills', label: 'Skills', href: href(project.id, 'builder', 'skills') },
              { value: 'library', label: 'Shared library', href: href(project.id, 'builder', 'library') },
            ]}
          />
          {tab === 'roles' ? <Roles /> : tab === 'agents' ? <Agents selected={route.rest[1]} /> : tab === 'skills' ? <Skills selected={route.rest[1]} /> : <Library />}
        </>
      )}
    </div>
  );
}

/* ---------------- Library ---------------- */

function Library() {
  const { project, canEdit } = useProject();
  const { user } = useApp();
  const { toast, confirm } = useUi();
  const lib = useLoad(() => api.get('/api/library'), []);
  const [kind, setKind] = useState('agents');
  if (!lib.data) return <Spinner />;
  const items = lib.data[kind];
  return (
    <div className="stack-lg">
      <div className="row between">
        <p className="muted">Agents and skills saved from any project. Install them here to reuse what worked elsewhere.</p>
        <Segmented value={kind} onChange={setKind} label="Type" options={[{ value: 'agents', label: `Agents (${lib.data.agents.length})` }, { value: 'skills', label: `Skills (${lib.data.skills.length})` }]} />
      </div>
      {!items.length ? (
        <Empty icon="builder" title="Nothing saved yet">Use “Save to shared library” on an agent or skill.</Empty>
      ) : (
        <ul className="lib-list">
          {items.map((x) => (
            <li key={x.name} className="panel">
              <div>
                <strong>{x.name}</strong>
                <p className="muted small">{x.description}</p>
              </div>
              <div className="row tight">
                {canEdit ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await api.post(`/api/projects/${project.id}/library/install`, { type: kind, name: x.name });
                        toast(`Installed ${x.name}`);
                      } catch (e) {
                        if (/already has/.test(e.message) && (await confirm({ title: 'Replace?', message: `${e.message}. Replace it with the library version?`, confirmLabel: 'Replace' }))) {
                          await api.post(`/api/projects/${project.id}/library/install`, { type: kind, name: x.name, overwrite: true });
                          toast(`Replaced ${x.name}`);
                        } else if (!/already has/.test(e.message)) toast(e.message, 'danger');
                      }
                    }}
                  >
                    Install in this project
                  </Button>
                ) : null}
                {user.is_admin ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={async () => {
                      if (!(await confirm({ title: 'Remove from library', message: `Remove ${x.name} from the shared library? Projects that installed it keep their copy.`, confirmLabel: 'Remove', danger: true }))) return;
                      await api.del(`/api/library/${kind}/${x.name}`);
                      lib.reload(true);
                    }}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
