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
    id: 'code-hosts',
    label: 'Code hosts',
    render: ({ user }) => <ConnectionsPage user={user} />,
  },
  {
    id: 'models',
    label: 'Models & AWS',
    render: ({ user }) => <Credentials user={user} />,
  },
  {
    id: 'tools',
    label: 'Tools & services',
    render: ({ projectId }) => <Integrations projectId={projectId} />,
  },
];

export function ConnectHub({ tab, user, projectId }) {
  const current = CONNECT_TABS.find((t) => t.id === tab) ?? CONNECT_TABS[0];
  return (
    <div className="page connect-hub">
      <PageHeader
        title="Connect"
        description="What the portal signs in to: code hosts, the model providers and AWS accounts that run agents, and the tools they can use."
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
