import { useEffect, useState } from 'react';

/** Hash routes: #/projects, #/p/<projectId>/<tab>/<rest…> */
export function parseHash(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { projectId: parts[1], tab: parts[2] || 'knowledge', rest: parts.slice(3) };
  if (parts[0] === 'settings') return { projectId: null, tab: 'settings', rest: parts.slice(1) };
  if (parts[0] === 'account') return { projectId: null, tab: 'account', rest: [] };
  if (parts[0] === 'feedback') return { projectId: null, tab: 'feedback', rest: parts.slice(1) };
  if (parts[0] === 'help') return { projectId: null, tab: 'help', rest: parts.slice(1) };
  return { projectId: null, tab: 'projects', rest: parts.slice(1) };
}

// The last page the user was on before opening Feedback, so feedback can say where it came from.
let lastPage = typeof window !== 'undefined' && !window.location.hash.startsWith('#/feedback') ? window.location.hash : '';
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (!window.location.hash.startsWith('#/feedback')) lastPage = window.location.hash;
  });
}
export const previousPage = () => lastPage;

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
  if (!projectId) return ['settings', 'account', 'feedback', 'help'].includes(tab) ? `#/${tab}${rest.filter(Boolean).map((x) => '/' + encodeURIComponent(x)).join('')}` : '#/projects';
  return `#/p/${encodeURIComponent(projectId)}/${tab}${rest.filter((x) => x !== undefined && x !== null && x !== '').map((x) => '/' + encodeURIComponent(x)).join('')}`;
}

export function go(projectId, tab, ...rest) {
  window.location.hash = href(projectId, tab, ...rest);
}
