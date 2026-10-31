import { useEffect, useRef, useState } from 'react';
import { Breadcrumb } from './Breadcrumb.jsx';
import { Icon } from './Icon.jsx';
import { href } from '../lib/router.js';
import { getTheme, setTheme } from '../lib/theme.js';

// ── Breadcrumb derivation ─────────────────────────────────────────────────────

const PAGE_NAMES = {
  sessions:     'Sessions',
  workspaces:   'Workspaces',
  reviews:      'Reviews',
  knowledge:    'Knowledge',
  vault:        'Vault',
  insights:     'Insights',
  create:       'Create',
  integrations: 'Integrations',
  setup:        'Setup',
  projects:     'Projects',
  inbox:        'Inbox',
  connections:  'Connections',
  api:          'API access',
  users:        'Users',
  settings:     'Settings',
  tests:        'Tests',
  'loop-specs': 'Loop specs',
};

function deriveBreadcrumb(route, projects) {
  const parts = [];

  if (route.projectId) {
    const project = projects?.find(p => p.id === route.projectId);
    parts.push({
      label: project?.name ?? 'Project',
      href: href(route.projectId, 'sessions'),
    });
    if (route.tab) {
      parts.push({ label: PAGE_NAMES[route.tab] ?? route.tab });
    }
  } else if (route.tab) {
    parts.push({ label: PAGE_NAMES[route.tab] ?? route.tab });
  }

  return parts;
}

// ── Account menu ──────────────────────────────────────────────────────────────

function AccountMenu({ user, onSignOut, onOpenShortcuts }) {
  const [open, setOpen]       = useState(false);
  const [theme, setThemeState] = useState(() => getTheme());
  const wrapRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Sync theme state
  useEffect(() => {
    const onStorage = () => setThemeState(getTheme());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const handleTheme = (val) => {
    setTheme(val);
    setThemeState(val);
  };

  const initials = (() => {
    if (!user) return '?';
    const name = user.name || user.email || '';
    return name
      .split(/[\s@]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(s => s[0].toUpperCase())
      .join('');
  })();

  return (
    <div className="account-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="account-btn"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${user?.name || user?.email || 'user'}`}
        title={user?.name || user?.email}
      >
        {initials}
      </button>

      {open && (
        <div
          className="account-menu-dropdown"
          role="menu"
          aria-label="Account menu"
        >
          {/* User info */}
          <div className="account-menu-user">
            <div className="account-menu-name">{user?.name || '—'}</div>
            <div className="account-menu-email">{user?.email || ''}</div>
          </div>

          {/* Theme */}
          <div className="account-menu-section-label" role="presentation">
            Color theme
          </div>
          <div className="account-menu-theme-row" role="group" aria-label="Color theme">
            {[
              { val: 'light',  label: 'Light'  },
              { val: 'dark',   label: 'Dark'   },
              { val: 'system', label: 'System' },
            ].map(({ val, label }) => (
              <button
                key={val}
                type="button"
                role="menuitemradio"
                aria-checked={theme === val}
                className={`account-theme-btn${theme === val ? ' is-active' : ''}`}
                onClick={() => handleTheme(val)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="account-menu-divider" role="separator" />

          {/* Shortcuts */}
          <button
            type="button"
            role="menuitem"
            className="account-menu-item"
            onClick={() => { setOpen(false); onOpenShortcuts(); }}
          >
            <Icon name="settings" size={15} />
            Keyboard shortcuts
            <kbd className="palette-key" style={{ marginLeft: 'auto' }}>?</kbd>
          </button>

          <div className="account-menu-divider" role="separator" />

          {/* Sign out */}
          <button
            type="button"
            role="menuitem"
            className="account-menu-item danger"
            onClick={() => { setOpen(false); onSignOut(); }}
          >
            <Icon name="logout" size={15} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── Theme toggle button (single cycle: light → dark → system → light) ─────────

function ThemeToggle() {
  const [theme, setThemeState] = useState(() => getTheme());

  useEffect(() => {
    const onStorage = () => setThemeState(getTheme());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const cycle = () => {
    const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    setTheme(next);
    setThemeState(next);
  };

  const label = theme === 'light' ? 'Light theme (click for Dark)' :
                theme === 'dark'  ? 'Dark theme (click for System)' :
                                    'System theme (click for Light)';
  const icon  = theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor';

  return (
    <button
      type="button"
      className="btn-icon theme-toggle-btn"
      onClick={cycle}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

// ── App header ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   route:           object,
 *   user:            object,
 *   projects:        Array | null,
 *   inboxCount:      number,
 *   onOpenPalette:   () => void,
 *   onOpenShortcuts: () => void,
 *   onSignOut:       () => void,
 * }} props
 */
export function AppHeader({ route, user, projects, inboxCount, onOpenPalette, onOpenShortcuts, onSignOut }) {
  const breadcrumbParts = deriveBreadcrumb(route, projects);

  return (
    <header className="app-header" role="banner">
      <div className="app-header-breadcrumb">
        <Breadcrumb parts={breadcrumbParts} />
      </div>

      <div className="app-header-actions">
        {/* Command palette trigger — styled as a search bar */}
        <button
          type="button"
          className="palette-trigger-btn"
          onClick={onOpenPalette}
          aria-keyshortcuts="Control+k Meta+k"
          aria-label="Open command palette"
        >
          <Icon name="search" size={13} />
          <span>Jump to…</span>
          <span aria-hidden="true" style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
            <kbd className="palette-key">Ctrl</kbd>
            <kbd className="palette-key">K</kbd>
          </span>
        </button>

        {/* Inbox / notifications */}
        <div style={{ position: 'relative' }}>
          <a
            href="#/inbox"
            className="btn-icon"
            aria-label={inboxCount > 0 ? `Inbox (${inboxCount} unread)` : 'Inbox'}
            title={inboxCount > 0 ? `${inboxCount} unread` : 'Inbox'}
          >
            <Icon name="inbox" size={16} />
          </a>
          {inboxCount > 0 && (
            <span className="header-inbox-badge" aria-hidden="true">
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </div>

        <ThemeToggle />

        <AccountMenu
          user={user}
          onSignOut={onSignOut}
          onOpenShortcuts={onOpenShortcuts}
        />
      </div>
    </header>
  );
}
