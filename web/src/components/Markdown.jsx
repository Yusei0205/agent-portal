import { useEffect, useMemo, useRef } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { cx } from '../lib/util.js';

export function slugify(s, max = 60) {
  const slug = String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'item';
}

function makeMarked() {
  const used = new Map();
  const m = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading(token) {
        const text = this.parser.parseInline(token.tokens);
        const plain = token.text.replace(/<[^>]+>/g, '');
        let id = slugify(plain);
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id = `${slugify(plain, 56)}-${n + 1}`;
        return `<h${token.depth} id="sec-${id}">${text}</h${token.depth}>\n`;
      },
      code(token) {
        const esc = token.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (token.lang === 'mermaid') return `<div class="mermaid-src" data-src="${encodeURIComponent(token.text)}"><pre><code>${esc}</code></pre></div>`;
        return `<pre><code${token.lang ? ` class="language-${token.lang.replace(/[^\w-]/g, '')}"` : ''}>${esc}</code></pre>`;
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        const external = /^https?:/i.test(token.href);
        return `<a href="${token.href}"${external ? ' target="_blank" rel="noreferrer noopener"' : ''}>${text}</a>`;
      },
    },
  });
  return m;
}

let mermaidPromise = null;
let mermaidCount = 0;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      // The HUD theme is always dark; the standard theme follows the system.
      const dark = document.documentElement.getAttribute('data-theme') === 'hud' || window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
      return m.default;
    });
  }
  return mermaidPromise;
}

export function Markdown({ text, className, onCite, transform }) {
  const ref = useRef(null);
  const html = useMemo(() => {
    const src = transform ? transform(text || '') : text || '';
    const raw = makeMarked().parse(src);
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'data-src', 'data-n'], ADD_TAGS: ['sup'] });
  }, [text, transform]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blocks = [...el.querySelectorAll('.mermaid-src')];
    if (!blocks.length) return;
    let cancelled = false;
    loadMermaid()
      .then(async (mermaid) => {
        for (const b of blocks) {
          if (cancelled) return;
          try {
            const { svg } = await mermaid.render(`mmd-${++mermaidCount}`, decodeURIComponent(b.dataset.src));
            b.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'] });
            b.classList.add('mermaid-ok');
          } catch {
            b.classList.add('mermaid-failed');
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [html]);

  return (
    <div
      ref={ref}
      className={cx('md', className)}
      onClick={(e) => {
        const cite = e.target.closest?.('.cite');
        if (cite && onCite) {
          e.preventDefault();
          onCite(Number(cite.dataset.n));
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
