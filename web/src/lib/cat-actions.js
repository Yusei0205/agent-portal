/**
 * The cat's shortcut panel (phase B1): which actions it offers for the current page and how typed text is matched to an action or a page.
 * Pure functions; no model, no network (questions go through cat-assistant.js). The panel (CatChatPanel.jsx) navigates to the chosen href.
 */

/**
 * The quick actions for a route. Project actions only exist inside a project; the Inbox is portal-wide.
 * `after: 'new-session'` asks the panel to open the new-session dialog once the Sessions page is showing.
 * @param {{ projectId?: string | null }} route
 * @returns {{ id: string, label: string, href: string, keywords: string[], after?: string }[]}
 */
export function catActions(route) {
  const pid = route && typeof route.projectId === 'string' && route.projectId ? route.projectId : null;
  const p = pid ? `#/p/${encodeURIComponent(pid)}` : null;
  const out = [];
  if (p) out.push({ id: 'start', label: 'Start a session', href: `${p}/sessions`, keywords: ['session', 'new session', 'start', 'new', 'run an agent'], after: 'new-session' });
  out.push({ id: 'inbox', label: 'What needs me?', href: '#/inbox', keywords: ['inbox', 'needs me', 'approvals', 'notifications', 'what needs me'] });
  if (p) {
    out.push({ id: 'autofix', label: 'Auto-fix', href: `${p}/setup/autofix`, keywords: ['autofix', 'auto fix', 'auto-fix', 'fix'] });
    out.push({ id: 'pipelines', label: 'Pipelines', href: `${p}/setup/pipelines`, keywords: ['pipeline', 'deploy', 'deployments'] });
    out.push({ id: 'knowledge', label: 'Search knowledge', href: `${p}/knowledge`, keywords: ['knowledge', 'search', 'documents', 'docs', 'decisions'] });
  } else {
    out.push({ id: 'projects', label: 'Open a project', href: '#/projects', keywords: ['projects', 'project', 'open project'] });
  }
  return out;
}

const FILLER = /^(please |can you |could you |i want to |i need to |i would like to )*(open|go to|goto|take me to|show me|show|find|see|check|view)? ?(the |my |a |an )?/;

/** Lower case, letters and digits only, filler words ("take me to the ...") removed. */
export function normalizeQuery(text) {
  const t = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.replace(FILLER, '').trim() || t;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function scoreTerm(q, term) {
  if (!term || !q) return 0;
  if (q === term) return 100;
  if (term.startsWith(q) && q.length >= 3) return 75;
  if (q.startsWith(term) && term.length >= 3) return 70;
  if (` ${q} `.includes(` ${term} `)) return 65;
  if (q.length >= 4 && term.includes(q)) return 45;
  return 0;
}

/**
 * Match typed text to one of the cat's actions or one of the portal's pages (the command palette's entries: { label, href, ... }).
 * Exact names win, then prefixes, whole words and substrings; on a tie an action beats a page.
 * @returns {{ kind: 'action', item: object } | { kind: 'page', item: object } | { kind: 'none' }}
 */
export function matchCatInput(text, actions, pages) {
  const q = normalizeQuery(text);
  if (!q) return { kind: 'none' };
  let best = { score: 0, kind: 'none', item: null };
  const consider = (kind, item, terms) => {
    let s = 0;
    for (const t of terms) s = Math.max(s, scoreTerm(q, norm(t)));
    if (s > best.score) best = { score: s, kind, item };
  };
  for (const a of actions ?? []) consider('action', a, [a.label, ...(a.keywords ?? [])]);
  for (const pg of pages ?? []) if (pg && pg.href) consider('page', pg, [pg.label]);
  if (best.score < 45) return { kind: 'none' };
  // Long or question-like text that merely contains a page or action word is a question for the assistant, not a shortcut.
  if (best.score < 100) {
    const words = q.split(' ').length;
    const questiony = /^(why|how|what|when|where|who|which|can|could|does|do|did|is|are|should)\b/.test(q) || /\?\s*$/.test(String(text ?? ''));
    if (words > 3 || questiony) return { kind: 'none' };
  }
  return { kind: best.kind, item: best.item };
}

export const CAT_NAME = 'Kyu';
export const CAT_GREETING = "Meow! I'm Kyu, your Kyuubit assistant. What would you like to do?";
