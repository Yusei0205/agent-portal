import { go } from '../../lib/router.js';
import { Segmented } from '../../components/ui.jsx';
import { useApp } from '../../lib/context.js';

// ─── Filter bar ───────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

const PROVIDER_OPTIONS = [
  { value: '', label: 'All providers' },
  { value: 'demo', label: 'Demo' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'bedrock', label: 'Bedrock' },
  { value: 'kiro', label: 'Kiro' },
];

const KIND_OPTIONS = [
  { value: '', label: 'All run types' },
  { value: 'chat', label: 'Chat' },
  { value: 'test', label: 'Test' },
  { value: 'review', label: 'Review' },
  { value: 'qa', label: 'QA' },
  { value: 'learn', label: 'Learn' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'verify', label: 'Verify' },
  { value: 'connection', label: 'Connection test' },
];

export function FilterBar({ filters, onChange, projects, showProjectSelect }) {
  return (
    <div className="ins-filter-bar" role="search" aria-label="Filter insights">
      <div className="ins-filter-group">
        <label className="ins-filter-label" htmlFor="ins-range">Range</label>
        <select
          id="ins-range"
          className="input input-sm"
          value={filters.days}
          onChange={(e) => onChange({ ...filters, days: e.target.value })}
        >
          {RANGE_OPTIONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      <div className="ins-filter-group">
        <label className="ins-filter-label" htmlFor="ins-provider">Provider</label>
        <select
          id="ins-provider"
          className="input input-sm"
          value={filters.provider}
          onChange={(e) => onChange({ ...filters, provider: e.target.value })}
        >
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="ins-filter-group">
        <label className="ins-filter-label" htmlFor="ins-kind">Run type</label>
        <select
          id="ins-kind"
          className="input input-sm"
          value={filters.kind}
          onChange={(e) => onChange({ ...filters, kind: e.target.value })}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      </div>

      {showProjectSelect ? (
        <div className="ins-filter-group">
          <label className="ins-filter-label" htmlFor="ins-project">Project</label>
          <select
            id="ins-project"
            className="input input-sm"
            value={filters.projectId}
            onChange={(e) => onChange({ ...filters, projectId: e.target.value })}
          >
            <option value="">All projects</option>
            {(projects || []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

/** The project the scope switch jumps to from the all-projects view: the last one you were in. */
function lastProjectId(projects) {
  let id = '';
  try {
    id = localStorage.getItem('rail-last-project') || '';
  } catch {
    /* private mode */
  }
  return (projects || []).some((p) => p.id === id && !p.archived) ? id : '';
}

/**
 * Insights is one page with a scope switch: this project, or all projects. It has one place in the menu.
 */
export function ScopeSwitch({ projectId }) {
  const projects = useApp()?.projects;
  const jumpTo = projectId || lastProjectId(projects);
  if (!jumpTo) return null;
  return (
    <Segmented
      value={projectId ? 'project' : 'all'}
      onChange={(v) => (v === 'project' ? go(jumpTo, 'insights') : go(null, 'insights'))}
      label="Insights scope"
      options={[
        { value: 'project', label: 'This project' },
        { value: 'all', label: 'All projects' },
      ]}
    />
  );
}
