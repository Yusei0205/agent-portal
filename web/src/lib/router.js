import { useEffect, useState } from 'react';

/**
 * Parse a hash into a route object.
 * Supports:
 *   #/p/<projectId>/<tab>/<rest...>  — project routes
 *   #/<tab>                          — global routes
 *   #/                               — home (tab: 'projects')
 *
 * @param {string} [hash]
 * @returns {{ tab: string, projectId: string | null, rest: string[] }}
 */
export function parseRoute(hash = window.location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);

  if (parts[0] === 'p' && parts[1]) {
    return {
      projectId: parts[1],
      tab: parts[2] || 'sessions',
      rest: parts.slice(3),
    };
  }

  if (parts.length > 0) {
    return { projectId: null, tab: parts[0], rest: parts.slice(1) };
  }

  return { projectId: null, tab: 'projects', rest: [] };
}

/**
 * Navigate to a hash path.
 * @param {string} path — e.g. '/p/my-project/sessions' or '/settings'
 */
export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : '#' + path;
}

/**
 * Build a href for a project route.
 * @param {string | null} projectId
 * @param {string} tab
 * @param {...string} rest
 * @returns {string}
 */
export function href(projectId, tab, ...rest) {
  if (!projectId) return `#/${tab}`;
  const parts = [projectId, tab, ...rest]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map(encodeURIComponent);
  return `#/p/${parts.join('/')}`;
}

/**
 * React hook — returns the current route and re-renders on hash change.
 * @returns {{ tab: string, projectId: string | null, rest: string[] }}
 */
export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute());

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHashChange);
    // Sync immediately in case hash changed before effect ran
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}
