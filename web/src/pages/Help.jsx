import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context.js';
import { href } from '../lib/router.js';
import { cx } from '../lib/util.js';
import { HELP_BY_ID, HELP_SECTIONS } from '../lib/help.js';
import { Empty, PageHeader } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { Markdown } from '../components/Markdown.jsx';

const plain = (s) => s.toLowerCase();

export function Help({ route }) {
  const { user } = useApp();
  const [q, setQ] = useState('');
  const sections = useMemo(() => HELP_SECTIONS.filter((s) => !s.adminOnly || user.is_admin), [user.is_admin]);
  const current = HELP_BY_ID[route.rest[0]] && sections.includes(HELP_BY_ID[route.rest[0]]) ? HELP_BY_ID[route.rest[0]] : sections[0];

  const terms = plain(q).split(/\s+/).filter(Boolean);
  const matches = terms.length ? sections.filter((s) => terms.every((t) => plain(s.title + ' ' + s.body).includes(t))) : null;

  useEffect(() => {
    document.getElementById('main')?.scrollTo?.(0, 0);
    window.scrollTo?.(0, 0);
  }, [current.id]);

  // Highlight search terms in the rendered guide without touching link targets.
  const highlight = useMemo(() => {
    const words = terms.filter((t) => t.length > 1 && /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.test(t));
    if (!words.length) return undefined;
    const re = new RegExp(`(${words.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return (md) => md.replace(/(\]\([^)]*\)|`[^`]*`)|([^\]`]+)/g, (m, keep, text) => (keep ? keep : text.replace(re, '<mark>$1</mark>')));
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = matches || [current];
  return (
    <div className="page wide">
      <PageHeader title="Help" sub="A user guide to every part of the portal. Pick a topic, or search the guide." />
      <div className="searchbar">
        <Icon name="search" />
        <input className="input" type="search" placeholder="Search the guide, like “approve” or “budget”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the guide" />
      </div>
      <div className="doc-layout help-layout">
        <nav className="doc-outline" aria-label="Help topics">
          <ol>
            {sections.map((s) => (
              <li key={s.id} className={cx('lvl-1', !matches && s.id === current.id && 'is-active', matches && !matches.includes(s) && 'is-dim')}>
                <a href={href(null, 'help', s.id)} aria-current={!matches && s.id === current.id ? 'page' : undefined} onClick={() => setQ('')}>
                  <Icon name={s.icon} size={15} /> {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="help-sections">
          {shown.length === 0 ? (
            <Empty icon="search" title="Nothing found">
              Try other words, or send a question from Feedback.
            </Empty>
          ) : (
            shown.map((s) => (
              <article key={s.id} className="doc-body help-section" id={`help-${s.id}`}>
                <h1 className="help-title">
                  <Icon name={s.icon} size={22} /> {s.title}
                </h1>
                <Markdown text={s.body} transform={highlight} />
              </article>
            ))
          )}
          {!matches ? (
            <p className="muted small">
              Still stuck? <a href={href(null, 'feedback')}>Send feedback</a> to the portal admins.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
