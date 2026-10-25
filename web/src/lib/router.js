import { useEffect, useState } from 'react';

/** Pages that belong to no project: #/<tab>. */
const GLOBAL_TABS = ['settings', 'aws', 'account', 'insights', 'connections', 'integrations', 'api', 'vault', 'admin', 'inbox'];

/**
 * Pages that used to be their own project tab and now live in the Project setup hub: #/p/<id>/<old tab> opens
 * #/p/<id>/setup/<section>. Old links keep working, and so does everything that still builds them with href().
 */
const SETUP_SECTIONS = { repos: 'repos', builder: 'agents', config: 'config', team: 'team' };

/**
 * Diagrams, generated documents and presentations are tabs of the Create page: #/p/<id>/create/<tab>/<item>.
 * Old addresses (#/p/<id>/diagrams, /documents, /presentations) redirect there, and href() builds the new ones.
 */
const CREATE_TABS = { diagrams: 'diagrams', documents: 'documents', presentations: 'decks' };

/** Learn is a tab of Knowledge: #/p/<id>/knowledge/learn/<rest>. Old #/p/<id>/learn[/...] addresses redirect there. */
const LEARN_TAB = ['knowledge', 'learn'];

/** The hash an old project link should be replaced with, or null when the hash is already current. */
export function legacyRedirect(hash = window.location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const m = raw.match(/^p\/([^/?]+)\/(repos|builder|config|team)(\/[^?]*)?(\?.*)?$/);
  if (m) return `#/p/${m[1]}/setup/${SETUP_SECTIONS[m[2]]}${m[3] || ''}${m[4] || ''}`;
  const c = raw.match(/^p\/([^/?]+)\/(diagrams|documents|presentations)(\/[^?]*)?(\?.*)?$/);
  if (c) return `#/p/${c[1]}/create/${CREATE_TABS[c[2]]}${c[3] || ''}${c[4] || ''}`;
  // Templates used to be a Project setup tab; they are now the Templates tab of Create.
  const t = raw.match(/^p\/([^/?]+)\/setup\/templates(\/[^?]*)?(\?.*)?$/);
  if (t) return `#/p/${t[1]}/create/templates${t[2] || ''}${t[3] || ''}`;
  const l = raw.match(/^p\/([^/?]+)\/learn(\/[^?]*)?(\?.*)?$/);
  if (l) return `#/p/${l[1]}/${LEARN_TAB.join('/')}${l[2] || ''}${l[3] || ''}`;
  // /create/presentations is the same tab as /create/decks.
  const d = raw.match(/^p\/([^/?]+)\/create\/presentations(\/[^?]*)?(\?.*)?$/);
  if (d) return `#/p/${d[1]}/create/decks${d[2] || ''}${d[3] || ''}`;
  return null;
}

/** Hash routes: #/projects, #/p/<projectId>/<tab>/<rest…>, optionally followed by ?key=value inside the hash. */
export function parseHash(hash = window.location.hash) {
  const raw = (legacyRedirect(hash) || hash).replace(/^#\/?/, '');
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
    const on = () => {
      // Replace an old link in the address bar so a reload or a shared link uses the current address.
      const current = legacyRedirect();
      if (current) window.history.replaceState(null, '', current);
      setRoute(parseHash());
    };
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(projectId, tab, ...rest) {
  if (projectId && SETUP_SECTIONS[tab]) return href(projectId, 'setup', SETUP_SECTIONS[tab], ...rest);
  if (projectId && CREATE_TABS[tab]) return href(projectId, 'create', CREATE_TABS[tab], ...rest);
  if (projectId && tab === 'learn') return href(projectId, ...LEARN_TAB, ...rest);
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
