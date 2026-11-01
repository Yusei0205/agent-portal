/**
 * Rail — sectioned navigation sidebar.
 *
 * Flat sections (no dropdowns), project picker card, draggable resize
 * separator, collapsed icon-only mode with portal-rendered tooltips,
 * and mobile off-canvas drawer support.
 */
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { navigate, href } from '../lib/router.js';
import { useActiveTemplate } from '../lib/theme.js';

// ── Local storage keys ────────────────────────────────────────────────────────

const LS_COLLAPSED  = 'rail-collapsed';
const LS_WIDTH      = 'rail-w';
const LS_LAST_PID   = 'rail-last-project';

export const DEFAULT_RAIL_W   = 236;
export const MIN_RAIL_W       = 200;
export const MAX_RAIL_W       = 320;
export const COLLAPSED_RAIL_W = 56;

// ── Nav sections config ───────────────────────────────────────────────────────
// projectScoped (section): ALL items in the section need an active project.
// projectScoped (item):    Only this item needs an active project (section may be mixed).
// dualScope: item links to /p/:pid/tab when a project exists, else to /:tab.
// badge:     show inboxCount badge / dot  (only used via top-bar now).
// adminOnly: hide from non-admin users.
// subTab:    default sub-route appended to the nav link (e.g. 'git' for connections).
// activeFor: extra tab names that should also highlight this rail item.

const NAV_SECTIONS = [
  {
    id: 'portal',
    label: '',
    items: [
      { tab: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    projectScoped: true,
    items: [
      { tab: 'sessions',   label: 'Sessions',   icon: 'terminal'  },
      { tab: 'workspaces', label: 'Workspaces', icon: 'projects'  },
      { tab: 'knowledge',  label: 'Knowledge',  icon: 'knowledge' },
      { tab: 'create',     label: 'Create',     icon: 'sparkles'  },
      { tab: 'insights',   label: 'Insights',   icon: 'chart'     },
      { tab: 'tickets',    label: 'Tickets',    icon: 'ticket'    },
    ],
  },
  {
    id: 'connect',
    label: 'Connect',
    items: [
      // portal-scoped — defaults to /connections/git
      { tab: 'connections',  label: 'Connections',  icon: 'branch', subTab: 'git' },
      // dual-scope — /p/:pid/integrations or /integrations
      { tab: 'integrations', label: 'Integrations', icon: 'plug',   dualScope: true },
      // project-scoped — opens Repositories tab of project setup
      { tab: 'setup', label: 'Repositories', icon: 'git-branch', projectScoped: true, subTab: 'repositories' },
      // project-scoped within this portal-level section
      { tab: 'vault',        label: 'Vault',        icon: 'archive', projectScoped: true },
    ],
  },
  {
    id: 'quality',
    label: 'Quality',
    items: [
      // project-scoped — defaults to /p/:pid/reviews/code
      // also highlights for legacy 'review' and 'branchscans' tabs (redirects)
      {
        tab: 'reviews', label: 'Reviews', icon: 'git-pull-request',
        projectScoped: true, subTab: 'code',
        activeFor: ['review', 'branchscans'],
      },
      { tab: 'tests', label: 'Tests', icon: 'flask', projectScoped: true },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    items: [
      { tab: 'credentials', label: 'Credentials',   icon: 'key'          },
      { tab: 'config',      label: 'Configuration', icon: 'file-cog'     },
      { tab: 'users',       label: 'Users',         icon: 'shield-user', adminOnly: true },
      { tab: 'api',         label: 'API access',    icon: 'code-2'       },
      { tab: 'settings',    label: 'Settings',      icon: 'settings'     },
    ],
  },
];

// ── Mobile breakpoint hook ────────────────────────────────────────────────────

/**
 * Returns true when the viewport matches ≤900 px.
 * Stays in sync with resize via matchMedia 'change' event.
 */
function useIsMobile(breakpoint = 900) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${breakpoint}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getItemHref(item, navProjectId) {
  if (item.dualScope) {
    return navProjectId ? href(navProjectId, item.tab) : `#/${item.tab}`;
  }
  if (item.subTab) {
    return `#/${item.tab}/${item.subTab}`;
  }
  return `#/${item.tab}`;
}

function isItemActive(item, route, navProjectId, section) {
  const isProjectScoped = section.projectScoped || item.projectScoped;

  if (isProjectScoped) {
    const tabMatches = [item.tab, ...(item.activeFor || [])];
    return route.projectId === navProjectId && tabMatches.includes(route.tab);
  }
  if (item.dualScope) {
    return route.tab === item.tab;
  }
  return !route.projectId && route.tab === item.tab;
}

function initials(name) {
  if (!name) return '?';
  return name
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');
}

// ── ProjectPicker ─────────────────────────────────────────────────────────────

function ProjectPicker({ projects, currentProjectId, onSelect, collapsed }) {
  const [open, setOpen]         = useState(false);
  const [search, setSearch]     = useState('');
  const [popPos, setPopPos]     = useState({ top: 0, left: 0 });
  const [focusIdx, setFocusIdx] = useState(-1);
  const btnRef                  = useRef(null);
  const popoverRef              = useRef(null);
  const searchRef               = useRef(null);

  const currentProject = (projects || []).find((p) => p.id === currentProjectId);

  const filteredProjects = (projects || []).filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()),
  );

  const openPicker = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    if (collapsed) {
      // Collapsed: popover to the right of the rail
      setPopPos({ top: rect.top, left: rect.right + 8 });
    } else {
      // Expanded: popover below the card, left-aligned with the card
      setPopPos({ top: rect.bottom + 4, left: rect.left });
    }
    setSearch('');
    setFocusIdx(-1);
    setOpen(true);
  }, [collapsed]);

  const closePicker = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  // Focus search when opened
  useLayoutEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        btnRef.current && !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleKeyDown = (e) => {
    const items = popoverRef.current?.querySelectorAll('[role="option"]');
    const n = items?.length ?? 0;
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(focusIdx + 1, n - 1);
      setFocusIdx(next);
      items?.[next]?.focus();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focusIdx <= 0) { searchRef.current?.focus(); setFocusIdx(-1); return; }
      const prev = focusIdx - 1;
      setFocusIdx(prev);
      items?.[prev]?.focus();
    }
  };

  const selectProject = (pid) => {
    onSelect(pid);
    setOpen(false);
  };

  const avatarLabel = currentProject
    ? `Project: ${currentProject.name}. Switch project`
    : 'Choose a project';

  const btn = collapsed ? (
    <button
      ref={btnRef}
      type="button"
      className={`project-picker-avatar${currentProject ? ' has-project' : ''}`}
      onClick={openPicker}
      aria-label={avatarLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-tooltip={currentProject?.name ?? 'Choose a project'}
    >
      {currentProject
        ? <span className="project-picker-initials">{initials(currentProject.name)}</span>
        : <Icon name="projects" size={15} />
      }
    </button>
  ) : (
    <button
      ref={btnRef}
      type="button"
      className={`project-picker-card${!currentProject ? ' no-project' : ''}`}
      onClick={openPicker}
      aria-label={avatarLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
    >
      <span className="project-picker-card-icon" aria-hidden="true">
        {currentProject
          ? <span className="project-picker-card-initials">{initials(currentProject.name)}</span>
          : <Icon name="projects" size={14} />}
      </span>
      <span className="project-picker-card-name">
        {currentProject?.name ?? 'Choose a project'}
      </span>
      <Icon name="chevronDown" size={12} className="project-picker-card-chevron" aria-hidden="true" />
    </button>
  );

  const popover = open ? createPortal(
    <>
      <div className="picker-backdrop" onClick={closePicker} />
      <div
        ref={popoverRef}
        className="project-picker-popover"
        role="dialog"
        aria-label="Switch project"
        aria-modal="true"
        style={{ top: popPos.top, left: popPos.left }}
        onKeyDown={handleKeyDown}
      >
        <div className="picker-header">Switch project</div>
        <div className="picker-search-wrap">
          <input
            ref={searchRef}
            type="search"
            className="picker-search"
            placeholder="Search projects…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setFocusIdx(-1); }}
            aria-label="Search projects"
          />
        </div>

        <div className="picker-list" role="listbox" aria-label="Projects">
          {filteredProjects.length === 0 && (
            <div className="picker-empty">No projects found</div>
          )}
          {filteredProjects.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === currentProjectId}
              className={`picker-item${p.id === currentProjectId ? ' is-active' : ''}`}
              tabIndex={0}
              onClick={() => selectProject(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProject(p.id); }
              }}
            >
              <span className="picker-item-avatar">{initials(p.name)}</span>
              <span className="picker-item-name">{p.name}</span>
              {p.id === currentProjectId && (
                <Icon name="check" size={13} className="picker-item-check" />
              )}
            </button>
          ))}
        </div>

        <div className="picker-footer">
          <a
            href="#/projects"
            className="picker-footer-link"
            onClick={() => { setOpen(false); navigate('/projects'); }}
          >
            <Icon name="projects" size={13} />
            All projects
          </a>
          <a
            href="#/projects"
            className="picker-footer-link"
            onClick={() => { setOpen(false); navigate('/projects'); }}
          >
            <Icon name="plus" size={13} />
            New project
          </a>
          {currentProject && (
            <a
              href={`#/p/${encodeURIComponent(currentProject.id)}/setup`}
              className="picker-footer-link"
              onClick={() => { setOpen(false); navigate(`/p/${currentProject.id}/setup`); }}
              aria-label={`Project settings for ${currentProject.name}`}
            >
              <Icon name="sliders" size={13} />
              Project settings
            </a>
          )}
        </div>
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <>
      {btn}
      {popover}
    </>
  );
}

// ── NavSection ────────────────────────────────────────────────────────────────

function NavSection({
  section, route, navProjectId, user, inboxCount, onNavigate, collapsed,
}) {
  const visibleItems = section.items.filter(
    (item) => !item.adminOnly || user?.is_admin,
  );

  if (visibleItems.length === 0) return null;

  const sectionId = `nav-section-${section.id}`;

  return (
    <div role="group" aria-labelledby={collapsed || !section.label ? undefined : sectionId} className="rail-section">
      {/* Section heading — visible when expanded; thin divider when collapsed */}
      {collapsed ? (
        <div className="rail-section-divider" aria-hidden="true" />
      ) : section.label ? (
        <div id={sectionId} className="rail-section-label" aria-hidden="true">
          {section.label}
        </div>
      ) : null}

      <ul className="rail-section-list" aria-label={section.label}>
        {visibleItems.map((item) => {
          // Item is disabled when it requires a project but none is selected
          const isProjectScoped = section.projectScoped || item.projectScoped;
          const disabled = isProjectScoped && !navProjectId;

          // Build the href
          let linkHref;
          if (isProjectScoped) {
            if (navProjectId) {
              linkHref = item.subTab
                ? href(navProjectId, item.tab, item.subTab)
                : href(navProjectId, item.tab);
            } else {
              linkHref = '#';
            }
          } else {
            linkHref = getItemHref(item, navProjectId);
          }

          const active = isItemActive(item, route, navProjectId, section);

          const tooltipText = disabled ? 'Choose a project first' : item.label;
          const cls = [
            'rail-link',
            active   ? 'is-active'   : '',
            disabled ? 'is-disabled' : '',
          ].filter(Boolean).join(' ');

          return (
            <li key={item.tab}>
              <a
                href={disabled ? '#' : linkHref}
                className={cls}
                aria-current={active ? 'page' : undefined}
                aria-disabled={disabled ? 'true' : undefined}
                aria-label={item.label}
                data-tooltip={tooltipText}
                onClick={disabled ? (e) => e.preventDefault() : onNavigate}
              >
                <Icon name={item.icon} size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── RailSeparator ─────────────────────────────────────────────────────────────

export function RailSeparator({ railWidth, onWidthChange, onToggleCollapse, collapsed }) {
  const widthRef = useRef(railWidth);
  widthRef.current = railWidth;

  const handleMouseDown = (e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = widthRef.current;

    const onMove = (mv) => {
      const next = Math.min(MAX_RAIL_W, Math.max(MIN_RAIL_W, startWidth + mv.clientX - startX));
      widthRef.current = next;
      onWidthChange(next, false); // live, don't persist yet
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      onWidthChange(widthRef.current, true); // final, persist
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleKeyDown = (e) => {
    const delta = e.key === 'ArrowLeft'  ? -8
                : e.key === 'ArrowRight' ?  8
                : e.key === 'Home'       ? -(widthRef.current - MIN_RAIL_W)
                : e.key === 'End'        ?   MAX_RAIL_W - widthRef.current
                : 0;
    if (!delta) return;
    e.preventDefault();
    const next = Math.min(MAX_RAIL_W, Math.max(MIN_RAIL_W, widthRef.current + delta));
    onWidthChange(next, true);
  };

  if (collapsed) return null;

  return (
    <div
      className="rail-sep"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize navigation"
      aria-valuenow={railWidth}
      aria-valuemin={MIN_RAIL_W}
      aria-valuemax={MAX_RAIL_W}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onToggleCollapse}
      title="Drag to resize · Double-click to collapse"
    />
  );
}

// ── Rail ──────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   route:            object,
 *   user:             object,
 *   projects:         Array | null,
 *   inboxCount:       number,
 *   onSignOut:        () => void,
 *   onNavigate:       () => void,
 *   collapsed:        boolean,
 *   onToggleCollapse: () => void,
 *   railWidth:        number,
 *   onRailWidthChange:(w: number, persist: boolean) => void,
 * }} props
 */
export function Rail({
  route,
  user,
  projects,
  inboxCount,
  onSignOut,
  onNavigate,
  collapsed,
  onToggleCollapse,
  railWidth,
  onRailWidthChange,
}) {
  // Last-selected project persisted in localStorage
  const [lastProjectId, setLastProjectId] = useState(() => {
    try { return localStorage.getItem(LS_LAST_PID) || ''; } catch { return ''; }
  });

  // navProjectId: prefer current route's projectId, fall back to last
  const navProjectId = route.projectId || lastProjectId;

  // On mobile the drawer always renders as expanded regardless of desktop preference.
  const isMobile        = useIsMobile();
  const effectiveCollapsed = collapsed && !isMobile;

  // Sync lastProjectId when route changes to a project page
  useEffect(() => {
    if (route.projectId && route.projectId !== lastProjectId) {
      setLastProjectId(route.projectId);
      try { localStorage.setItem(LS_LAST_PID, route.projectId); } catch {}
    }
  }, [route.projectId, lastProjectId]);

  // Tooltip state for collapsed mode
  const [tooltip, setTooltip]   = useState(null); // { text, y }
  const navWrapRef              = useRef(null);
  const navOuterRef             = useRef(null);
  const railRef                 = useRef(null);

  // Mobile focus trap — active when .shell.nav-open is present (set by Shell)
  const isDrawerOpen = Boolean(document.querySelector('.shell.nav-open'));

  useEffect(() => {
    if (!isDrawerOpen || !railRef.current) return;
    const rail = railRef.current;
    const getFocusable = () => Array.from(
      rail.querySelectorAll('a:not([aria-disabled="true"]), button:not([disabled]), input:not([disabled]), [tabindex="0"]'),
    );

    const handleTab = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleTab);
    // Move focus into drawer when it opens
    getFocusable()[0]?.focus();
    return () => document.removeEventListener('keydown', handleTab);
  }, [isDrawerOpen]);

  useEffect(() => {
    if (!effectiveCollapsed) { setTooltip(null); return; }
    // Use railRef so footer elements (user avatar) also trigger tooltips
    const wrap = railRef.current;
    if (!wrap) return;

    const show = (e) => {
      const el = e.target.closest('[data-tooltip]');
      if (!el) { setTooltip(null); return; }
      const rect = el.getBoundingClientRect();
      setTooltip({ text: el.dataset.tooltip, y: rect.top + rect.height / 2 });
    };
    const hide = () => setTooltip(null);

    wrap.addEventListener('mouseover', show);
    wrap.addEventListener('mouseleave', hide);
    wrap.addEventListener('focusin', show);
    wrap.addEventListener('focusout', hide);
    return () => {
      wrap.removeEventListener('mouseover', show);
      wrap.removeEventListener('mouseleave', hide);
      wrap.removeEventListener('focusin', show);
      wrap.removeEventListener('focusout', hide);
    };
  }, [effectiveCollapsed]);

  const handlePickerSelect = useCallback((pid) => {
    setLastProjectId(pid || '');
    try { localStorage.setItem(LS_LAST_PID, pid || ''); } catch {}
    if (pid) {
      navigate(`/p/${pid}/sessions`);
    } else {
      navigate('/projects');
    }
  }, []);

  // Scroll-fade: update data attributes so CSS can show top/bottom fade
  const updateFade = useCallback(() => {
    const el = navWrapRef.current;
    const outer = navOuterRef.current;
    if (!el || !outer) return;
    outer.dataset.canUp   = el.scrollTop > 2 ? '1' : '0';
    outer.dataset.canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 2 ? '1' : '0';
  }, []);

  useEffect(() => {
    const el = navWrapRef.current;
    if (!el) return;
    updateFade();
    el.addEventListener('scroll', updateFade, { passive: true });
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(updateFade);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', updateFade);
      ro?.disconnect();
    };
  }, [updateFade]);

  // Re-measure scroll fade after collapsed/expanded toggle.
  // ResizeObserver only fires on element size changes, not scrollHeight changes;
  // but when collapsed state changes the link heights (and therefore scrollHeight)
  // change without the container resizing, so we re-check with a rAF to ensure
  // layout is settled before measuring.
  useEffect(() => {
    const raf = requestAnimationFrame(updateFade);
    return () => cancelAnimationFrame(raf);
  }, [effectiveCollapsed, updateFade]);

  // Brand from active template — reactive: re-renders on 'portal-theme-changed'
  const activeTmpl  = useActiveTemplate();
  const logoSvg     = activeTmpl?.brand?.logoSvg;
  const productName = activeTmpl?.brand?.productName || 'Agent Portal';
  const logoDataUrl = logoSvg
    ? `data:image/svg+xml,${encodeURIComponent(logoSvg)}`
    : null;

  // Avatar initials for user
  const userInitials = initials(user?.name || user?.email || '?');

  // Portal-rendered tooltip (only when truly collapsed on desktop)
  const tooltipEl = effectiveCollapsed && tooltip
    ? createPortal(
        <div className="rail-tooltip" style={{ top: tooltip.y }} role="tooltip" aria-hidden="true">
          {tooltip.text}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <aside
        ref={railRef}
        className="rail"
        aria-label="Navigation"
      >
        {/* Brand */}
        <a href="#/projects" className="brand" aria-label={`${productName} home`}>
          {logoDataUrl ? (
            <img src={logoDataUrl} width={24} height={24} alt="" className="brand-icon" aria-hidden="true" />
          ) : (
            <img src="/favicon.svg" width={22} height={22} alt="" className="brand-icon" />
          )}
          {!effectiveCollapsed && <span>{productName}</span>}
        </a>

        {/* Project picker */}
        <div className="project-picker-wrap">
          <ProjectPicker
            projects={projects}
            currentProjectId={navProjectId || ''}
            onSelect={handlePickerSelect}
            collapsed={effectiveCollapsed}
          />
        </div>

        {/* Sectioned nav — only this region scrolls */}
        <div className="rail-nav-outer" ref={navOuterRef}>
          <div className="rail-nav-wrap" ref={navWrapRef}>
            <nav aria-label="Main">
              {NAV_SECTIONS.map((section) => (
                <NavSection
                  key={section.id}
                  section={section}
                  route={route}
                  navProjectId={navProjectId}
                  user={user}
                  inboxCount={inboxCount}
                  onNavigate={onNavigate}
                  collapsed={effectiveCollapsed}
                />
              ))}
            </nav>
          </div>
        </div>

        {/* Footer */}
        <div className="rail-foot">
          {/* Collapse toggle — hidden on mobile via CSS (.shell.nav-open .rail-collapse-btn) */}
          <button
            type="button"
            className="rail-collapse-btn"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            data-tooltip={collapsed ? 'Expand' : undefined}
          >
            <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={15} aria-hidden="true" />
            {!effectiveCollapsed && <span>Collapse</span>}
          </button>

          {/* User row */}
          <div className="rail-user">
            <a
              href="#/account"
              className="rail-user-name"
              aria-label={user?.name || user?.email}
              data-tooltip={effectiveCollapsed ? (user?.name || user?.email) : undefined}
            >
              <span className="rail-avatar" aria-hidden="true">{userInitials}</span>
              <span className="rail-foot-name">{user?.name || user?.email}</span>
            </a>
            <button
              type="button"
              className="btn-icon"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              data-tooltip={collapsed ? 'Sign out' : undefined}
            >
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* Resize separator — fixed, reads --rail-w CSS var */}
      <RailSeparator
        railWidth={railWidth}
        onWidthChange={onRailWidthChange}
        onToggleCollapse={onToggleCollapse}
        collapsed={collapsed}
      />

      {/* Portal tooltip for collapsed mode */}
      {tooltipEl}
    </>
  );
}
