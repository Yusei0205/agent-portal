import { useState } from 'react';
import { navigate, href } from '../../lib/router.js';
import { SessionList } from './SessionList.jsx';
import { SessionWorkspace } from './SessionWorkspace.jsx';
import { Icon } from '../../components/Icon.jsx';

/**
 * Three-panel sessions layout.
 *   Left:   SessionList — all sessions for the project
 *   Right:  SessionWorkspace — selected session detail
 *
 * @param {{
 *   projectId: string,
 *   project?: { id: string, name: string },
 *   route: { tab: string, rest: string[] },
 *   initialDialogTicket?: object | null,
 *   onInitialDialogConsumed?: () => void,
 * }} props
 */
export function SessionsShell({ projectId, project, route, initialDialogTicket, onInitialDialogConsumed }) {
  // Derive selected session ID from URL: #/p/<pid>/sessions/<id>
  const selectedId = route.rest[0] || null;

  // project may be passed from App or we can construct a minimal one
  const proj = project || { id: projectId, name: projectId };

  const handleSelect = (id) => {
    navigate(href(projectId, 'sessions', id));
  };

  return (
    <div className={`sessions-shell${selectedId ? ' with-workspace' : ''}`}>
      {/* Left panel — Session list */}
      <SessionList
        project={proj}
        selectedId={selectedId}
        onSelect={handleSelect}
        initialDialogTicket={initialDialogTicket ?? null}
        onInitialDialogConsumed={onInitialDialogConsumed}
      />

      {/* Right panel — Detail / empty state */}
      <div className="sessions-detail-panel">
        {/* Mobile back button — CSS hides this on desktop (≥900 px) */}
        {selectedId && (
          <button
            type="button"
            className="sessions-back-btn"
            onClick={() => navigate(href(projectId, 'sessions'))}
            aria-label="Back to sessions list"
          >
            <Icon name="chevron-left" size={16} />
            Sessions
          </button>
        )}
        {selectedId ? (
          <SessionWorkspace id={selectedId} project={proj} />
        ) : (
          <div className="ws-placeholder sessions-empty-placeholder">
            <div className="ws-placeholder-icon">
              <Icon name="play" size={48} />
            </div>
            <p>Select a session to view it</p>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => document.dispatchEvent(new CustomEvent('portal:new-session'))}
            >
              New session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
