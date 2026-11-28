import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

/** The entries of the text box: one per line, blanks and # notes dropped. */
const entries = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

/**
 * The exclude list of a repository's code graph: folders and files that are not worth mapping (vendored code, build output,
 * generated files). They are left out the next time the graph is built, so they are not in the Code map and sessions do not
 * load them. The list is the same for every branch. After a build the page also names the folders with the most items, with a
 * button to leave each one out. See server/code-graph.ts.
 *
 * @param {{ projectId: string, repoId: string, repoName: string, branch?: string, refreshKey?: string, onRebuild?: () => void }} props
 */
export function GraphExcludes({ projectId, repoId, repoName, branch = '', refreshKey = '', onRebuild }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(null); // { excludes, status, unavailable }
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'ok' | 'error', text }
  const base = `/api/projects/${projectId}/code-map/${repoId}`;

  const load = useCallback(async () => {
    try {
      const d = await api.get(`${base}/graph-status${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`);
      setInfo({ excludes: d.excludes ?? [], status: d.status ?? null, unavailable: d.unavailable ?? null });
      setText((prev) => (dirty ? prev : (d.excludes ?? []).join('\n')));
    } catch (err) {
      setMsg({ kind: 'error', text: err.message || 'Could not read the exclude list' });
    }
  }, [base, branch, dirty]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [base, branch, refreshKey]);

  if (!info) return null;
  const patterns = entries(text);
  const saved = info.excludes;
  const changed = JSON.stringify(patterns) !== JSON.stringify(saved);
  const st = info.status;
  const builtWith = st?.exclude ?? [];
  const outdated = st?.state === 'ready' && JSON.stringify(builtWith) !== JSON.stringify(saved);
  const folders = (st?.folders ?? []).filter((f) => !patterns.includes(`${f.path}/`) && !patterns.includes(f.path)).slice(0, 8);
  const canRebuild = !info.unavailable && st?.state !== 'running';

  const add = (line) => {
    setText((t) => `${t.trim() ? `${t.trimEnd()}\n` : ''}${line}`);
    setDirty(true);
    setOpen(true);
  };

  const save = async (rebuild) => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api.put(`${base}/excludes`, { patterns: text.split('\n') });
      setInfo((prev) => ({ ...prev, excludes: d.patterns }));
      setText(d.patterns.join('\n'));
      setDirty(false);
      if (rebuild) {
        await api.post(`${base}/build`, branch ? { branch } : {});
        setMsg({ kind: 'ok', text: 'Saved. The graph is being rebuilt without them; follow it under Workspaces › Repositories.' });
        onRebuild?.();
      } else {
        setMsg({ kind: 'ok', text: d.patterns.length ? 'Saved. They are left out the next time the graph is built.' : 'Saved. Nothing is left out any more.' });
      }
      await load();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message || 'Could not save the exclude list' });
    } finally {
      setBusy(false);
    }
  };

  const inputId = `gx-${repoId}`;
  return (
    <div className="small" style={{ marginTop: '0.4em' }}>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={inputId}>
        {open ? 'Hide' : 'Leave out'} folders or files{saved.length ? ` (${saved.length})` : ''}
      </button>
      {outdated && !open && <span className="muted"> · the graph was built with a different list; rebuild to apply</span>}
      {open && (
        <div id={inputId} style={{ marginTop: '0.4em', maxWidth: 640 }}>
          <p className="muted" style={{ margin: '0 0 0.4em' }}>
            One per line. These are left out of the code graph of {repoName} (every branch), so they are not in the Code map and sessions do not load them.
            Your code is not changed. <code>node_modules/</code> leaves out that folder anywhere; <code>src/legacy/</code> only that path from the top;
            <code> *.min.js</code> files by name; <code>**</code> goes through folders. Lines starting with # are notes.
          </p>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setDirty(true); }}
            rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
            spellCheck={false}
            aria-label={`Folders and files to leave out of the code graph of ${repoName}`}
            placeholder={'node_modules/\ndist/\nvendor/\n*.min.js'}
            style={{ width: '100%', fontFamily: 'var(--mono)' }}
          />
          {folders.length > 0 && (
            <div style={{ marginTop: '0.4em' }}>
              <span className="muted">Biggest folders in the last graph{st?.branch ? ` (${st.branch})` : ''}: </span>
              {folders.map((f) => (
                <button key={f.path} type="button" className="btn btn-sm btn-ghost" style={{ marginRight: 4 }} onClick={() => add(`${f.path}/`)}
                  aria-label={`Leave out ${f.path}, ${Number(f.nodes).toLocaleString('en-US')} items`}>
                  {f.path}/ <span className="muted">{Number(f.nodes).toLocaleString('en-US')}</span> +
                </button>
              ))}
            </div>
          )}
          {st?.excluded && (st.excluded.dirs > 0 || st.excluded.files > 0) && (
            <p className="muted" style={{ margin: '0.4em 0 0' }}>The last build left out {st.excluded.dirs} folders and {st.excluded.files} files.</p>
          )}
          {outdated && !changed && <p style={{ margin: '0.4em 0 0' }}>The graph was built with a different list. Rebuild to apply the saved one.</p>}
          <div style={{ marginTop: '0.5em', display: 'flex', gap: '0.5em', flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-sm" onClick={() => save(false)} disabled={busy || !changed}>Save</button>
            {canRebuild && <button type="button" className="btn btn-sm" onClick={() => save(true)} disabled={busy || (!changed && !outdated)}>Save and rebuild</button>}
            {changed && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setText(saved.join('\n')); setDirty(false); }} disabled={busy}>Undo changes</button>}
            {msg && <span role={msg.kind === 'error' ? 'alert' : 'status'} style={msg.kind === 'error' ? { color: 'var(--danger)' } : undefined}>{msg.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default GraphExcludes;
