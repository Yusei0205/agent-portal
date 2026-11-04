import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Markdown } from './Markdown.jsx';
import { TextZoom } from './PanZoom.jsx';

/**
 * Read a Knowledge document in the portal, with the passage a search or an answer pointed to highlighted.
 * The text shown is the converted text the portal indexes (Markdown), not the original file.
 *
 * The passage is matched to the document by blocks (paragraphs, lists, tables): a block is highlighted when the
 * passage contains it, or it contains the passage, or the two overlap at an end (a Knowledge Base chunk may start or
 * stop mid-block).
 */

const norm = (s) => String(s || '').replace(/[#>*_`|-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

function overlaps(block, passage) {
  if (block.length < 8 || passage.length < 8) return false;
  if (passage.includes(block) || block.includes(passage)) return true;
  const n = 60;
  if (block.length >= n && (passage.includes(block.slice(0, n)) || passage.includes(block.slice(-n)))) return true;
  if (passage.length >= n && (block.includes(passage.slice(0, n)) || block.includes(passage.slice(-n)))) return true;
  return false;
}

export function KnowledgeDocViewer({ projectId, docId, name, passage, heading, onClose }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const firstHit = useRef(null);

  useEffect(() => {
    let live = true;
    api.get(`/api/projects/${projectId}/knowledge/docs/${docId}/content`)
      .then((r) => { if (live) setDoc(r); })
      .catch((e) => { if (live) setError(e.message || 'Could not open the document'); });
    return () => { live = false; };
  }, [projectId, docId]);

  const blocks = useMemo(() => {
    if (!doc) return [];
    const p = norm(passage);
    let marked = 0;
    return doc.markdown.replace(/\r\n/g, '\n').split(/\n{2,}/).map((b, i) => {
      const hit = p ? overlaps(norm(b), p) : false;
      if (hit) marked++;
      return { i, text: b, hit };
    }).filter((b) => b.text.trim()).map((b) => ({ ...b, anyHit: marked > 0 }));
  }, [doc, passage]);

  const hits = blocks.filter((b) => b.hit).length;
  const firstIndex = blocks.findIndex((b) => b.hit);

  // Scroll the first highlighted block into view once the text is on screen.
  useEffect(() => {
    if (firstHit.current) firstHit.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [doc, firstIndex]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="kdv-title" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal kdv-modal">
        <div className="modal-header">
          <h2 id="kdv-title">{doc?.name || name}</h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {passage && doc && (
          <p className="muted small kdv-note" role="status">
            {hits ? `The highlighted ${hits === 1 ? 'passage is' : 'passages are'} what the answer or search pointed to${heading ? ` (under “${heading}”)` : ''}.` : 'The passage could not be located in the text, so nothing is highlighted.'}
            {' '}Shown as the text the portal converted from the file.
          </p>
        )}
        {error && <p className="error-note" role="alert">{error}</p>}
        {!doc && !error && <p className="muted">Opening…</p>}
        {doc && (
          <TextZoom><div className="kdv-body">
            {blocks.map((b) => (
              <div
                key={b.i}
                ref={b.i === blocks[firstIndex]?.i && b.hit ? firstHit : null}
                className={`kdv-block${b.hit ? ' is-hit' : ''}`}
              >
                <Markdown text={b.text} />
              </div>
            ))}
            {doc.truncated && <p className="muted small">The text is long; only the first part is shown here.</p>}
          </div></TextZoom>
        )}
      </div>
    </div>
  );
}

export default KnowledgeDocViewer;
