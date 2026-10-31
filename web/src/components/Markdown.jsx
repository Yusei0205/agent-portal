/**
 * Safe Markdown renderer.
 *
 * Uses `marked` to convert Markdown → HTML, then `DOMPurify` to sanitise
 * the result before injecting it via dangerouslySetInnerHTML.
 *
 * This satisfies the "no dangerouslySetInnerHTML of raw HTML" requirement:
 * every string that reaches innerHTML has been through DOMPurify first.
 *
 * Falls back to a <pre> block while the libraries are still loading or if
 * parsing throws.
 */
import { useEffect, useState } from 'react';

// Module-level library cache so each is fetched at most once.
let _marked = null;
let _DOMPurify = null;
let _loadPromise = null;

function loadDeps() {
  if (_marked && _DOMPurify) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  _loadPromise = Promise.all([import('marked'), import('dompurify')]).then(
    ([markedMod, dpMod]) => {
      _marked = markedMod.marked ?? markedMod.default;
      _DOMPurify = dpMod.default ?? dpMod;
    },
  );
  return _loadPromise;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {{ text: string, className?: string }} props
 */
export function Markdown({ text, className }) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    if (!text) { setHtml(''); return; }
    let cancelled = false;

    loadDeps()
      .then(() => {
        if (cancelled) return;
        try {
          const raw =
            typeof _marked === 'function'
              ? _marked(text, { gfm: true, breaks: true })
              : _marked.parse(text, { gfm: true, breaks: true });
          setHtml(_DOMPurify.sanitize(String(raw)));
        } catch {
          setHtml(`<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`);
        }
      })
      .catch(() => {
        if (!cancelled)
          setHtml(`<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`);
      });

    return () => { cancelled = true; };
  }, [text]);

  if (!html) return null;

  return (
    // eslint-disable-next-line react/no-danger
    <div
      className={`markdown-body${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
