import { Icon } from './Icon.jsx';

/**
 * Breadcrumb navigation.
 * @param {{ parts: Array<{ label: string, href?: string }> }} props
 */
export function Breadcrumb({ parts }) {
  if (!parts || parts.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb">
      <ol
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          flexWrap: 'wrap',
          listStyle: 'none',
          margin: 0,
          padding: 0,
          fontSize: '0.82rem',
          color: 'var(--ink-3)',
        }}
      >
        {parts.map((part, i) => {
          const isLast = i === parts.length - 1;
          return (
            <li
              key={i}
              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
              aria-current={isLast ? 'page' : undefined}
            >
              {i > 0 && (
                <Icon
                  name="chevronRight"
                  size={12}
                  className="muted"
                  aria-hidden="true"
                />
              )}
              {part.href && !isLast ? (
                <a
                  href={part.href}
                  style={{ color: 'var(--ink-3)', textDecoration: 'none' }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--ink)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--ink-3)')}
                >
                  {part.label}
                </a>
              ) : (
                <span style={isLast ? { color: 'var(--ink)' } : {}}>
                  {part.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
