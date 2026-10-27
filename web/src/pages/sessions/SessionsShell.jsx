import { useState, useEffect } from 'react';
import { navigate, href } from '../../lib/router.js';

/**
 * Three-panel sessions layout.
 *   Panel 1: session list (placeholder for P6)
 *   Panel 2: session detail / workspace
 *
 * @param {{ projectId: string, route: { tab: string, rest: string[] } }} props
 */
export function SessionsShell({ projectId, route }) {
  // Derive selected session ID from URL: #/p/<pid>/sessions/<id>
  const selectedId = route.rest[0] || null;

  const selectSession = (id) => {
    navigate(href(projectId, 'sessions', id));
  };

  return (
    <div className={`sessions-shell${selectedId ? ' with-workspace' : ''}`}>
      {/* Panel 1 — Session list */}
      <div className="sessions-list-panel">
        <div className="ws-header">
          <span className="ws-header-title">Sessions</span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            style={{ marginLeft: 'auto' }}
          >
            + New
          </button>
        </div>
        <div className="ws-list-body">
          <div className="ws-section-header">Recent</div>
          {/* Placeholder — full list comes in P6 */}
          <div className="ws-placeholder" style={{ padding: '20px 10px' }}>
            <p className="muted small">Sessions will appear here.</p>
            <p className="muted small">Full implementation coming in P6.</p>
          </div>
        </div>
      </div>

      {/* Panel 2 — Detail / empty state */}
      <div className="sessions-detail-panel">
        {selectedId ? (
          <div style={{ padding: '24px' }}>
            <p className="muted">Session {selectedId} workspace coming in P6.</p>
          </div>
        ) : (
          <div className="ws-placeholder">
            <div className="ws-placeholder-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 4v16l13-8L7 4Z" />
              </svg>
            </div>
            <p>Select a session to view it</p>
            <p className="small">or start a new one above</p>
          </div>
        )}
      </div>
    </div>
  );
}
