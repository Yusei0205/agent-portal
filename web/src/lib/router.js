import { useEffect, useState } from 'react';

/** Hash routes: #/projects, #/p/<projectId>/<tab>/<rest…> */
export function parseHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { projectId: parts[1], tab: parts[2] || 'knowledge', rest: parts.slice(3) };
  if (parts[0] === 'settings') return { projectId: null, tab: 'settings', rest: parts.slice(1) };
  if (parts[0] === 'aws') return { projectId: null, tab: 'aws', rest: [] };
  if (parts[0] === 'account') return { projectId: null, tab: 'account', rest: [] };
  if (parts[0] === 'insights') return { projectId: null, tab: 'insights', rest: [] };
  return { projectId: null, tab: 'projects', rest: parts.slice(1) };
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
