import { useEffect, useState } from 'react';

/** Hash routes: #/projects, #/p/<projectId>/<tab>/<rest…>, optionally followed by ?key=value inside the hash. */
export function parseHash(hash = window.location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const parts = (qi >= 0 ? raw.slice(0, qi) : raw).split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { projectId: parts[1], tab: parts[2] || 'knowledge', rest: parts.slice(3), query };
  if (parts[0] === 'settings') return { projectId: null, tab: 'settings', rest: parts.slice(1), query };
  if (parts[0] === 'aws') return { projectId: null, tab: 'aws', rest: [], query };
  if (parts[0] === 'account') return { projectId: null, tab: 'account', rest: [], query };
  if (parts[0] === 'insights') return { projectId: null, tab: 'insights', rest: [], query };
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
  if (!projectId) return tab === 'settings' ? '#/settings' : tab === 'aws' ? '#/aws' : tab === 'account' ? '#/account' : tab === 'insights' ? '#/insights' : '#/projects';
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
