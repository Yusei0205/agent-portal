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
  // Strip the hash query string (e.g. ?status=done) so filter state in
  // hash-scoped pages doesn't break route matching.
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
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

  return { projectId: null, tab: 'dashboard', rest: [] };
}

/**
 * Navigate to a hash path (pushes a new history entry).
 * @param {string} path — e.g. '/p/my-project/sessions' or '/settings'
 */
export function navigate(path) {
  window.location.hash = path.startsWith('#') ? path : '#' + path;
}

/**
 * Navigate to a hash path, *replacing* the current history entry.
 * Use this for redirects so the Back button skips the old URL and returns to
 * the page the user was on before (no back-button trap).
 * @param {string} path — e.g. '/p/my-project/sessions' or '/settings'
 */
export function navigateReplace(path) {
  const hash = path.startsWith('#') ? path : '#' + path;
  window.location.replace(
    window.location.pathname + window.location.search + hash,
  );
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
