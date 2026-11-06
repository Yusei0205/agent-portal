import { useEffect, useRef, useState } from 'react';
import { href, navigate } from '../lib/router.js';
import { getTheme, setTheme } from '../lib/theme.js';
import { Icon } from './Icon.jsx';
import { HELP_TOPICS, plainText } from '../lib/help-content.js';
import { useOverlayDismiss } from '../lib/useOverlayDismiss.js';

// ── Page catalogue ────────────────────────────────────────────────────────────

function buildNavItems(route, user) {
  const pid = route.projectId;
  const items = [];

  // Project-scoped pages (only when inside a project)
  if (pid) {
    items.push(
      { id: 'goto_sessions',        label: 'Sessions',        description: 'Start and manage agent sessions',   keys: 'g s', href: href(pid, 'sessions')               },
      { id: 'goto_workspaces',      label: 'Workspaces',      description: 'Git workspace checkouts',           keys: 'g w', href: href(pid, 'workspaces')             },
      { id: 'goto_reviews',         label: 'Reviews',         description: 'Code reviews, branch scans & dashboard', keys: 'g r', href: href(pid, 'reviews', 'code') },
      { id: 'goto_knowledge',       label: 'Knowledge',       description: 'Documents, decisions and learning', keys: 'g k', href: href(pid, 'knowledge')              },
      { id: 'goto_vault_proj',      label: 'Vault',           description: 'Project secrets and files',         keys: 'g v', href: href(pid, 'vault')                  },
      { id: 'goto_create',          label: 'Create',          description: 'Generate diagrams, docs and decks', keys: 'g c', href: href(pid, 'create')                 },
      { id: 'goto_integrations_p',  label: 'Tools & services', description: 'MCP tools, Jira and Google',       keys: 'g i', href: '#/connect/tools'                   },
      { id: 'goto_tests',           label: 'Tests',           description: 'AI-assisted end-to-end and API tests', keys: 'g h', href: href(pid, 'tests')             },
    );
  }

  // Portal pages (always available)
  items.push(
    { id: 'goto_projects',    label: 'Projects',       description: 'All your projects',                    keys: 'g p', href: '#/projects'          },
    { id: 'goto_inbox',       label: 'Inbox',          description: 'Pending PR-review notifications',      keys: 'g b', href: '#/inbox'             },
    { id: 'goto_connections', label: 'Git connections', description: 'Git hosts used to clone repositories', keys: 'g n', href: '#/connect/git' },
    { id: 'goto_integrations',label: 'Tools & services', description: 'Portal-wide MCP tools and services', keys: 'g j', href: '#/connect/tools'     },
    { id: 'goto_api',         label: 'API access',     description: 'Personal access tokens and MCP URL',  keys: 'g e', href: '#/api'               },
  );

  // Admin-only portal pages
  if (user?.is_admin) {
    items.push(
      { id: 'goto_users',    label: 'Users',    description: 'Users, audit log and API tokens',  keys: 'g m', href: '#/users'    },
      { id: 'goto_settings', label: 'Settings', description: 'Provider, tools and permissions',  keys: 'g t', href: '#/settings' },
    );
  }

  // Always-available extra pages
  items.push(
    { id: 'goto_credentials', label: 'Agent sign-ins', description: 'Your Kiro and Claude accounts',   keys: 'g y', href: '#/connect/sign-ins' },
    { id: 'goto_config',      label: 'Agent setup',   description: 'Edit ~/.codex, ~/.kiro and ~/.claude config', keys: 'g x', href: '#/config'      },
    { id: 'goto_help',        label: 'Help',          description: 'User guide to every feature of the portal', href: '#/help' },
    // One entry per guide topic, so "help reviews" jumps straight to it
    ...HELP_TOPICS.map((t) => ({ id: `help_${t.id}`, label: `Help: ${t.title}`, description: plainText(t.summary), href: `#/help/${t.id}` })),
  );

  return items;
}

function buildThemeItems(currentTheme) {
  return [
    { id: 'theme_light',  label: 'Theme: Light',  description: 'Switch to light theme',  action: () => setTheme('light'),  active: currentTheme === 'light'  },
    { id: 'theme_dark',   label: 'Theme: Dark',   description: 'Switch to dark theme',   action: () => setTheme('dark'),   active: currentTheme === 'dark'   },
    { id: 'theme_system', label: 'Theme: System', description: 'Follow your OS setting', action: () => setTheme('system'), active: currentTheme === 'system' },
  ];
}

// ── Fuzzy match ───────────────────────────────────────────────────────────────

/**
 * Returns true when every character in `query` appears in `text`
 * in order (case-insensitive). Empty query matches everything.
 */
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function itemMatchesQuery(item, query) {
  if (!query) return true;
  return (
    fuzzyMatch(query, item.label) ||
    (item.description && fuzzyMatch(query, item.description))
  );
}

// ── Focus trap ────────────────────────────────────────────────────────────────

function useFocusTrap(ref, isOpen) {
  useEffect(() => {
    if (!isOpen || !ref.current) return;
    const el = ref.current;
    const getFocusable = () =>
      Array.from(el.querySelectorAll(
        'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { last.focus(); e.preventDefault(); }
      } else {
        if (document.activeElement === last)  { first.focus(); e.preventDefault(); }
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [ref, isOpen]);
}

// ── Key pill renderer ─────────────────────────────────────────────────────────

function KeyPills({ keys }) {
  if (!keys) return null;
  const parts = keys.split(' ');
  return (
    <span className="palette-item-keys" aria-label={`Shortcut: ${keys}`}>
      {parts.map((k, i) => (
        <kbd key={i} className="palette-key">{k}</kbd>
      ))}
    </span>
  );
}

// ── Command palette ───────────────────────────────────────────────────────────

/**
 * @param {{
 *   isOpen:          boolean,
 *   onClose:         () => void,
 *   onOpenShortcuts: () => void,
 *   route:           object,
 *   user:            object,
 * }} props
 */
export function CommandPalette({ isOpen, onClose, onOpenShortcuts, route, user }) {
  const [query, setQuery]         = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [theme, setThemeState]    = useState(() => getTheme());

  const dialogRef    = useRef(null);
  const inputRef     = useRef(null);
  const prevFocusRef = useRef(null);
  // Must be declared unconditionally — before any early return
  const activeItemRef = useRef(null);

  useFocusTrap(dialogRef, isOpen);

  // Track theme changes from outside
  useEffect(() => {
    const onStorage = () => setThemeState(getTheme());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Save focus and focus input on open
  useEffect(() => {
    if (isOpen) {
      prevFocusRef.current = document.activeElement;
      setTimeout(() => inputRef.current?.focus(), 0);
      setQuery('');
      setActiveIdx(0);
    } else {
      // Restore focus on close
      if (prevFocusRef.current && typeof prevFocusRef.current.focus === 'function') {
        prevFocusRef.current.focus();
      }
    }
  }, [isOpen]);

  // Build derived data unconditionally (hooks must not appear after this)
  const navItems    = buildNavItems(route, user);
  const themeItems  = buildThemeItems(theme);
  const actionItems = [
    { id: 'action_shortcuts', label: 'Keyboard shortcuts', description: 'Show all key bindings', keys: '?',
      action: () => { onClose(); onOpenShortcuts(); } },
    ...themeItems,
  ];
  const filteredNav    = navItems.filter(it => itemMatchesQuery(it, query));
  const filteredAction = actionItems.filter(it => itemMatchesQuery(it, query));
  const allItems   = [...filteredNav, ...filteredAction];
  const clampedIdx = Math.min(activeIdx, Math.max(0, allItems.length - 1));

  // Keep active item visible — must be before early return
  useEffect(() => {
    if (!isOpen) return;
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [clampedIdx, isOpen]);

  // Must be before early return — hook cannot be called after conditional return
  const overlayDismiss = useOverlayDismiss(onClose);

  if (!isOpen) return null;

  // Build sections (only non-empty)
  const sections = [];
  if (filteredNav.length > 0)    sections.push({ id: 'goto',    label: 'Go to',   items: filteredNav });
  if (filteredAction.length > 0) sections.push({ id: 'actions', label: 'Actions', items: filteredAction });

  const activateItem = (item) => {
    if (item.href) {
      navigate(item.href.replace(/^#/, ''));
      onClose();
    } else if (item.action) {
      item.action();
      // Theme actions can close immediately
      if (item.id.startsWith('theme_')) {
        setThemeState(getTheme());
        onClose();
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape')    { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, allItems.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = allItems[clampedIdx];
      if (item) activateItem(item);
    }
  };

  let flatIdx = 0;

  return (
    <div
      className="palette-backdrop"
      onMouseDown={overlayDismiss.onMouseDown}
      onClick={overlayDismiss.onClick}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        {/* Search — combobox pattern: input owns aria-expanded + aria-activedescendant */}
        <div className="palette-search-row">
          <span className="palette-search-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            id="palette-input"
            type="text"
            role="combobox"
            className="palette-search-input"
            placeholder="Search pages and actions…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            aria-label="Search command palette"
            aria-autocomplete="list"
            aria-expanded={allItems.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={
              allItems.length > 0 ? `palette-item-${allItems[clampedIdx]?.id}` : undefined
            }
            autoComplete="off"
          />
          <button
            type="button"
            className="palette-close-btn"
            onClick={onClose}
            aria-label="Close palette"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Results — listbox owned by the combobox input above */}
        <div
          id="palette-listbox"
          className="palette-results"
          role="listbox"
          aria-label="Commands"
        >
          {sections.length === 0 ? (
            <p className="palette-empty">No results for "{query}"</p>
          ) : (
            sections.map((section) => (
              <div key={section.id} role="group" aria-labelledby={`palette-sec-${section.id}`}>
                <div
                  id={`palette-sec-${section.id}`}
                  className="palette-section-label"
                  aria-hidden="true"
                >
                  {section.label}
                </div>
                {section.items.map((item) => {
                  const idx = flatIdx++;
                  const isActive = idx === clampedIdx;
                  return (
                    <button
                      key={item.id}
                      id={`palette-item-${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      ref={isActive ? activeItemRef : null}
                      className="palette-item"
                      /* tabIndex=-1: Tab key should not walk every option;
                         keyboard navigation is via ArrowUp/Down on the input. */
                      tabIndex={-1}
                      onClick={() => activateItem(item)}
                    >
                      <span className="palette-item-icon" aria-hidden="true">
                        {item.id.startsWith('goto_') ? (
                          <Icon name="external" size={15} />
                        ) : item.id.startsWith('theme_') ? (
                          item.id === 'theme_light' ? <Icon name="sun" size={15} /> :
                          item.id === 'theme_dark'  ? <Icon name="moon" size={15} /> :
                          <Icon name="monitor" size={15} />
                        ) : (
                          <Icon name="settings" size={15} />
                        )}
                      </span>
                      <span className="palette-item-body">
                        <span className="palette-item-label">
                          {item.label}
                          {item.active ? ' ✓' : ''}
                        </span>
                        {item.description && (
                          <span className="palette-item-desc">{item.description}</span>
                        )}
                      </span>
                      {item.keys && <KeyPills keys={item.keys} />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="palette-footer" aria-hidden="true">
          <span className="palette-footer-hint">
            <kbd className="palette-key">↑↓</kbd> navigate
          </span>
          <span className="palette-footer-hint">
            <kbd className="palette-key">↵</kbd> open
          </span>
          <span className="palette-footer-hint">
            <kbd className="palette-key">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
