/**
 * Connect: everything the portal signs in to, in one place.
 *
 * Add a tab by adding one entry to CONNECT_TABS (id, label, what it holds, how to render it);
 * the URL is #/connect/<id> and the rest of the page follows.
 */
import { HubContext, PageHeader } from '../components/PageHeader.jsx';
import { navigate } from '../lib/router.js';
import { ConnectionsPage } from './ConnectionsPage.jsx';
import { Credentials } from './Credentials.jsx';
import { Integrations } from './Integrations.jsx';

export const CONNECT_TABS = [
  {
    id: 'git',
    label: 'Git connections',
    render: ({ user, projectId }) => <ConnectionsPage user={user} projectId={projectId} />,
  },
  {
    id: 'sign-ins',
    label: 'Agent sign-ins',
    render: ({ user }) => <Credentials user={user} />,
  },
  {
    id: 'tools',
    label: 'Tools & services',
    render: ({ projectId }) => <Integrations projectId={projectId} />,
  },
];

// Addresses from before the tabs were renamed.
const TAB_ALIASES = { 'code-hosts': 'git', models: 'sign-ins' };

export function ConnectHub({ tab, user, projectId }) {
  const wanted = TAB_ALIASES[tab] ?? tab;
  const current = CONNECT_TABS.find((t) => t.id === wanted) ?? CONNECT_TABS[0];
  return (
    <div className="page connect-hub">
      <PageHeader
        title="Connect"
        description="What the portal signs in to: Git hosts, the Codex, Kiro and Claude accounts that run agents, and the tools agents can use."
      />
      <div className="tab-bar" role="tablist" aria-label="Connect sections">
        {CONNECT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`connect-tab-${t.id}`}
            aria-selected={current.id === t.id}
            aria-controls="connect-panel"
            className={`tab-btn${current.id === t.id ? ' is-active' : ''}`}
            onClick={() => navigate(`/connect/${t.id}`)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="connect-panel" role="tabpanel" aria-labelledby={`connect-tab-${current.id}`} className="connect-panel">
        <HubContext.Provider value>
          {current.render({ user, projectId })}
        </HubContext.Provider>
      </div>
    </div>
  );
}

export default ConnectHub;
