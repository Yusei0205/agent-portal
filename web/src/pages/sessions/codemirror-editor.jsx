/**
 * CodeMirror 6 editor — dynamically imported to keep it out of the main bundle.
 * Import via: const mod = await import('./codemirror-editor.jsx');
 */

import { useEffect, useRef } from 'react';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { css as langCss } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';

// ── Language detection ────────────────────────────────────────────────────────

function langFor(ext) {
  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return javascript({ typescript: ext === '.ts' || ext === '.tsx' });
    case '.css': case '.scss': case '.less':
      return langCss();
    case '.html': case '.htm':
      return html();
    case '.json': case '.jsonc':
      return json();
    case '.py':
      return python();
    case '.md':
      return markdown();
    default:
      return null;
  }
}

// ── Theme switcher ────────────────────────────────────────────────────────────

function getColorScheme() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   content: string,
 *   ext: string,
 *   onChange: (value: string) => void,
 *   onSave: () => void,
 *   readOnly?: boolean,
 * }} props
 */
export function CodeMirrorEditor({ content, ext, onChange, onSave, readOnly = false, initialLine }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);

  // Track latest callbacks without re-creating the editor
  const onChangeRef = useRef(onChange);
  const onSaveRef   = useRef(onSave);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  useEffect(() => {
    if (!hostRef.current) return;

    const colorScheme = getColorScheme();

    const lang = langFor(ext);
    const extensions = [
      basicSetup,
      colorScheme === 'dark' ? oneDark : [],
      highlightActiveLine(),
      ...(lang ? [lang] : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => { onSaveRef.current(); return true; },
        },
      ]),
      ...(readOnly ? [EditorState.readOnly.of(true)] : []),
    ];

    const state = EditorState.create({ doc: content, extensions });
    const view  = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ext, readOnly]); // re-create when ext changes; content managed separately

  // Sync content when it changes from outside without re-creating the editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
      });
    }
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !Number.isInteger(initialLine) || initialLine < 1) return;
    const line = view.state.doc.line(Math.min(initialLine, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  }, [initialLine]);

  return (
    <div
      ref={hostRef}
      className="ide-codemirror-host"
      aria-label="Code editor"
    />
  );
}
