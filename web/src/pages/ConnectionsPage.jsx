/**
 * Connections page — tabbed portal-scoped page.
 * Tabs: Git (git connections) · AWS accounts
 *
 * URLs:
 *   #/connections/git  → Git connections tab
 *   #/connections/aws  → AWS accounts tab
 *
 * Old URL #/connections redirects to #/connections/git (handled in App.jsx).
 * Old URL #/aws         redirects to #/connections/aws (handled in App.jsx).
 */

import { navigate } from '../lib/router.js';
import { Connections as GitConnections } from './Connections.jsx';
import { AwsAccounts } from './AwsAccounts.jsx';

const TABS = [
  { id: 'git', label: 'Git' },
  { id: 'aws', label: 'AWS accounts' },
];

export function ConnectionsPage({ subTab, user, projectId, projects }) {
  const active = TABS.find((t) => t.id === subTab) ? subTab : 'git';

  // Resolve the currently selected project so we can show its AWS accounts
  const currentProject = (projects || []).find((p) => p.id === projectId) ?? null;

  const switchTab = (id) => navigate(`/connections/${id}`);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Connections</h1>
      </div>

      {/* Tab bar */}
      <div className="tabs" role="tablist" aria-label="Connections sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            className={`tab-btn${active === t.id ? ' is-active' : ''}`}
            aria-selected={active === t.id}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content — rendered without wrapper page div since we already have one */}
      <div className="tab-panel" style={{ paddingTop: '1rem' }}>
        {active === 'git'  && <GitContentPanel user={user} />}
        {active === 'aws'  && (
          <AwsAccounts projectId={projectId || null} currentProject={currentProject} />
        )}
      </div>
    </div>
  );
}

/**
 * Wrapper that strips the top-level .page div from <Connections /> content
 * so it renders cleanly inside the ConnectionsPage tab panel.
 */
function GitContentPanel({ user }) {
  return <GitConnections user={user} />;
}

export default ConnectionsPage;
