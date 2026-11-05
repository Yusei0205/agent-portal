/**
 * Help — the in-portal user guide: every feature, what it is for and how to use it.
 *
 * Content lives in lib/help-content.js. A topic can be linked to directly with #/help/<topic-id>.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import { PageHeader } from '../components/PageHeader.jsx';
import { navigate } from '../lib/router.js';
import { HELP_GROUPS, HELP_TOPICS, pageHref, searchHelp } from '../lib/help-content.js';

/** Render **bold** and `code` marks as elements (no HTML injection). */
function Rich({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

function TopicSection({ section }) {
  const List = section.steps ? 'ol' : 'ul';
  return (
    <section className="help-section">
      <h3>{section.heading}</h3>
      {section.items && (
        <List className="help-list">
          {section.items.map((it, i) => <li key={i}><Rich text={it} /></li>)}
        </List>
      )}
      {section.rows && (
        <dl className="help-rows">
          {section.rows.map(([term, desc], i) => (
            <div key={i} className="help-row">
              <dt><Rich text={term} /></dt>
              <dd><Rich text={desc} /></dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function Topic({ topic, projectId }) {
  const link = pageHref(topic.page, projectId);
  return (
    <article id={`help-${topic.id}`} className="panel help-topic" aria-labelledby={`help-${topic.id}-title`}>
      <header className="help-topic-head">
        <span className="help-topic-icon" aria-hidden="true"><Icon name={topic.icon} size={18} /></span>
        <div className="help-topic-title">
          <h2 id={`help-${topic.id}-title`}>
            {topic.title}
            {topic.adminOnly && <span className="badge badge-info help-badge">Admins</span>}
          </h2>
          <p className="muted"><Rich text={topic.summary} /></p>
        </div>
        {topic.page && (
          link ? (
            <a className="btn btn-sm btn-outline help-open" href={link}>
              {topic.pageLabel || `Open ${topic.title}`}
              <Icon name="chevron-right" size={14} />
            </a>
          ) : (
            <span className="muted small help-open">Choose a project to open it</span>
          )
        )}
      </header>
      {topic.sections.map((s) => <TopicSection key={s.heading} section={s} />)}
      {topic.tips?.length > 0 && (
        <aside className="help-tips">
          <Icon name="info" size={15} />
          <ul>{topic.tips.map((t, i) => <li key={i}><Rich text={t} /></li>)}</ul>
        </aside>
      )}
    </article>
  );
}

/**
 * @param {{ route: { rest?: string[] }, projectId?: string }} props
 */
export function Help({ route, projectId = '' }) {
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const topics = useMemo(() => searchHelp(query), [query]);
  const target = route?.rest?.[0] || '';

  // Scroll to the topic named in the URL.
  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(`help-${target}`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [target, topics]);

  const groups = HELP_GROUPS
    .map((g) => ({ ...g, topics: topics.filter((t) => t.group === g.id) }))
    .filter((g) => g.topics.length > 0);

  return (
    <div className="page help-page">
      <PageHeader
        title="Help"
        description="A guide to everything you can do in the portal: what each page is for and how to use it."
      >
        <div className="help-search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search help…"
            aria-label="Search help"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </PageHeader>

      <div className="help-layout">
        <nav className="help-toc" aria-label="Help topics">
          {groups.map((g) => (
            <div key={g.id} className="help-toc-group">
              <div className="help-toc-label">{g.label}</div>
              <ul>
                {g.topics.map((t) => (
                  <li key={t.id}>
                    <a
                      href={`#/help/${t.id}`}
                      className={target === t.id ? 'active' : undefined}
                      aria-current={target === t.id ? 'true' : undefined}
                    >
                      <Icon name={t.icon} size={14} />
                      {t.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="help-content">
          {groups.length === 0 ? (
            <div className="panel empty-state help-empty">
              <Icon name="search" size={32} />
              <p>Nothing in the guide matches “{query}”.</p>
              <div className="row">
                <button type="button" className="btn btn-sm btn-outline" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
                  Clear search
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate('/feedback')}>
                  Ask the admins
                </button>
              </div>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.id} className="help-group" aria-label={g.label}>
                <h2 className="help-group-label">{g.label}</h2>
                {g.topics.map((t) => <Topic key={t.id} topic={t} projectId={projectId} />)}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default Help;
