/**
 * A button that opens a list of people to filter the ticket list by.
 *
 * The list is searched by name (GET /jira/assignees?project=&q=). With a project chosen it starts with that project's
 * assignable people; with "All projects" Jira has no such list, so it starts with the people who are on the tickets already
 * shown, and typing a name searches the whole Jira site.
 *
 * @param {{
 *   projectId: string,
 *   jiraProject: string,
 *   suggestions: Array<{ accountId: string, name: string }>,
 *   value: { accountId: string, name: string } | null,
 *   onPick: (person: { accountId: string, name: string } | null) => void,
 * }} props
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './Icon.jsx';

export function AssigneePicker({ projectId, jiraProject, suggestions, value, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [loading, setLoading] = useState(false);
  const root = useRef(null);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  // Search as the person types (and once when the list opens, for the project's own people).
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (jiraProject) params.set('project', jiraProject);
      if (q.trim()) params.set('q', q.trim());
      api.get(`/api/projects/${projectId}/jira/assignees?${params}`)
        .then((r) => { if (live) setFound(r.assignees ?? []); })
        .catch(() => { if (live) setFound([]); })
        .finally(() => { if (live) setLoading(false); });
    }, q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [open, q, projectId, jiraProject]);

  // Search results first; with no search, the people on the tickets shown are added. No one twice.
  const needle = q.trim().toLowerCase();
  const merged = [];
  const seen = new Set();
  for (const p of [...found, ...suggestions.filter((s) => !needle || s.name.toLowerCase().includes(needle))]) {
    if (!seen.has(p.accountId)) { seen.add(p.accountId); merged.push(p); }
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));

  const pick = (p) => { onPick(p); setOpen(false); setQ(''); };

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          type="button"
          className={`btn btn-sm ${value ? 'btn-primary' : 'btn-secondary'}`}
          style={{ height: 34, whiteSpace: 'nowrap' }}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="user" size={14} aria-hidden="true" /> {value ? value.name : 'Person'}
        </button>
        {value && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ height: 34 }}
            aria-label={`Clear the person filter (${value.name})`}
            onClick={() => onPick(null)}
          >
            <Icon name="x" size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <div
          className="card"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', width: 260, zIndex: 30, padding: 8, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}
        >
          <input
            type="search"
            className="input"
            style={{ width: '100%', marginBottom: 6 }}
            placeholder="Search people…"
            aria-label="Search people"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div role="listbox" aria-label="People" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {merged.map((p) => (
              <button
                key={p.accountId}
                type="button"
                role="option"
                aria-selected={value?.accountId === p.accountId}
                className="btn btn-ghost btn-sm"
                style={{ display: 'block', width: '100%', textAlign: 'left', fontWeight: value?.accountId === p.accountId ? 600 : undefined }}
                onClick={() => pick(p)}
              >
                {p.name}
              </button>
            ))}
            {merged.length === 0 && (
              <p className="muted small" style={{ margin: '6px 4px' }}>
                {loading ? 'Searching…' : q.trim() ? 'No one found.' : 'Type a name to search.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default AssigneePicker;
