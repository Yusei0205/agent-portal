import { useEffect, useState } from 'react';

const LS_LIST_COLLAPSED = 'sessions_list_collapsed';
function loadCollapsed() { try { return localStorage.getItem(LS_LIST_COLLAPSED) === '1'; } catch { return false; } }
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

  // The sessions list can fold away to give the conversation the whole width. It stays mounted (search and filters are kept).
  const [listCollapsed, setListCollapsed] = useState(loadCollapsed);
  const [layoutFolded, setLayoutFolded] = useState(false);
  const toggleList = () => {
    if (layoutFolded) { setLayoutFolded(false); setListCollapsed(false); return; }
    setListCollapsed((collapsed) => {
      try { localStorage.setItem(LS_LIST_COLLAPSED, collapsed ? '0' : '1'); } catch { /* storage unavailable: not remembered */ }
      return !collapsed;
    });
  };
  // Focus mode (Alt+F in the session) hides the list too, without changing the remembered choice.
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    const on = (e) => setFocus(Boolean(e.detail));
    document.addEventListener('portal:session-focus', on);
    return () => document.removeEventListener('portal:session-focus', on);
  }, []);
  useEffect(() => {
    const onLayout = (event) => setLayoutFolded(['code', 'review'].includes(event.detail?.mode));
    document.addEventListener('portal:session-layout', onLayout);
    return () => document.removeEventListener('portal:session-layout', onLayout);
  }, []);
  const collapsed = Boolean(selectedId) && (listCollapsed || focus || layoutFolded);

  const handleSelect = (id) => {
    navigate(href(projectId, 'sessions', id));
  };

  return (
    <div className={`sessions-shell${selectedId ? ' with-workspace' : ''}${collapsed ? ' list-collapsed' : ''}`}>
      {/* Left panel — Session list */}
      <SessionList
        project={proj}
        selectedId={selectedId}
        onSelect={handleSelect}
        initialDialogTicket={initialDialogTicket ?? null}
        onInitialDialogConsumed={onInitialDialogConsumed}
      />

      {selectedId && !focus && (
        <button
          type="button"
          className="sessions-list-toggle"
          onClick={toggleList}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show sessions list' : 'Hide sessions list'}
          title={collapsed ? 'Show sessions list' : 'Hide sessions list'}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={12} />
        </button>
      )}

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
