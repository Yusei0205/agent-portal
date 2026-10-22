import { useEffect, useState } from 'react';

/** Pages that belong to no project: #/<tab>. */
const GLOBAL_TABS = ['settings', 'aws', 'account', 'insights', 'connections', 'integrations', 'api', 'vault', 'admin'];

/** Hash routes: #/projects, #/p/<projectId>/<tab>/<rest…>, optionally followed by ?key=value inside the hash. */
export function parseHash(hash = window.location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const parts = (qi >= 0 ? raw.slice(0, qi) : raw).split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { projectId: parts[1], tab: parts[2] || 'knowledge', rest: parts.slice(3), query };
  if (GLOBAL_TABS.includes(parts[0])) return { projectId: null, tab: parts[0], rest: parts.slice(1), query };
  return { projectId: null, tab: 'projects', rest: parts.slice(1), query };
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(projectId, tab, ...rest) {
  if (!projectId) return GLOBAL_TABS.includes(tab) ? `#/${tab}` : '#/projects';
  return `#/p/${encodeURIComponent(projectId)}/${tab}${rest.filter((x) => x !== undefined && x !== null && x !== '').map((x) => '/' + encodeURIComponent(x)).join('')}`;
}

export function go(projectId, tab, ...rest) {
  window.location.hash = href(projectId, tab, ...rest);
}

/** Append a query to a hash link; empty values are left out. */
export function withQuery(link, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return q ? `${link}?${q}` : link;
}

/** Where one agent run is shown: inside Sessions, as a single run. */
export function runHref(projectId, runId) {
  return href(projectId, 'sessions', 'run', runId);
}

/** Where a session is shown, optionally on a tab or with one of its runs selected. */
export function sessionHref(projectId, workflowId, params = {}) {
  return withQuery(href(projectId, 'sessions', workflowId), params);
}
