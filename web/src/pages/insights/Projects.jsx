import { href } from '../../lib/router.js';
import { money, timeAgo } from '../../lib/util.js';
import { Badge, Empty } from '../../components/ui.jsx';
import { fmtCredits } from './format.js';

// ─── Spend by project ─────────────────────────────────────────────────────────

export function SpendByProject({ projects }) {
  // Dollars and Kiro credits are different units: each gets its own bar, scaled against its own maximum.
  const sorted = [...(projects || [])]
    .filter((p) => (p.costUsd || 0) > 0 || (p.credits || 0) > 0)
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.credits || 0) - (a.credits || 0))
    .slice(0, 12);
  const maxUsd = Math.max(0, ...sorted.map((p) => p.costUsd || 0));
  const maxCredits = Math.max(0, ...sorted.map((p) => p.credits || 0));

  if (!sorted.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Spend by project</h2>
        <Empty icon="projects" title="No spend data" />
      </div>
    );
  }

  return (
    <div className="ins-chart-wrap panel" aria-label="Spend by project">
      <h2 className="ins-chart-title">Spend by project</h2>
      <div className="ins-hbar-list">
        {sorted.map((p) => (
          <div key={p.id} className="ins-hbar-row">
            <a href={href(p.id, 'insights')} className="ins-hbar-label" title={p.name}>{p.name}</a>
            <div className="ins-hbar-track" role="presentation">
              {p.costUsd ? <div className="ins-hbar-fill" style={{ width: `${(p.costUsd / maxUsd) * 100}%` }} /> : null}
              {p.credits ? <div className="ins-hbar-fill ins-hbar-credits" style={{ width: `${(p.credits / maxCredits) * 100}%` }} /> : null}
            </div>
            <span className="ins-hbar-val">
              {[p.costUsd ? money(p.costUsd, 2) : '', p.credits ? `${Number(p.credits).toFixed(2)} credits` : ''].filter(Boolean).join(' · ')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Connection map ───────────────────────────────────────────────────────────

export function ConnectionMap({ projects }) {
  const connected = (projects || []).filter((p) => p.connection);

  if (!connected.length) {
    return (
      <div className="ins-chart-wrap panel">
        <h2 className="ins-chart-title">Connection map</h2>
        <Empty icon="repos" title="No connections" />
      </div>
    );
  }

  // One row per project: project → provider → AWS account (or how it signs in when the account is not known yet).
  const PROVIDER_NAMES = { kiro: 'Kiro CLI', bedrock: 'Amazon Bedrock', anthropic: 'Anthropic API', demo: 'Demo' };
  return (
    <div className="ins-chart-wrap panel" aria-label="Connection map">
      <h2 className="ins-chart-title">Connection map</h2>
      <ul className="ins-connrows">
        {connected.map((p) => {
          const c = p.connection;
          const aws = c.aws?.account ? `AWS ${c.aws.account}` : c.aws?.how ? `AWS ${c.aws.how}` : 'AWS (Settings)';
          return (
            <li key={p.id} className="ins-connrow">
              <a href={href(p.id, 'setup', 'connection')} className="ins-connmap-node ins-connmap-project" title={`${p.name}: open the connection settings`}>
                {p.name}
              </a>
              <span className="ins-connrow-link" aria-hidden="true">
                <span className="ins-connrow-count">{p.runs} runs</span>
              </span>
              <span className="ins-connmap-node ins-connmap-prov" title={c.providerSource === 'settings' ? 'From Settings' : 'Set on this project'}>
                {PROVIDER_NAMES[c.provider] || c.provider}
                {c.providerSource === 'settings' ? <span className="muted small"> (Settings)</span> : null}
              </span>
              <span className="ins-connrow-link" aria-hidden="true" />
              <span className="ins-connmap-node ins-connmap-aws" title={c.modelAws === 'project' ? 'The model uses this account too' : ''}>
                {aws}
                {c.aws?.region ? <span className="muted small"> · {c.aws.region}</span> : null}
              </span>
              <span className="sr-only">
                {`${p.name}: ${PROVIDER_NAMES[c.provider] || c.provider}, ${aws}${c.aws?.region ? `, ${c.aws.region}` : ''}, ${p.runs} runs.`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Project cards (global view) ─────────────────────────────────────────────

export function ProjectCards({ projects }) {
  if (!projects?.length) return <Empty icon="projects" title="No project data" />;
  return (
    <div className="ins-project-grid">
      {projects.map((p) => (
        <a key={p.id} href={href(p.id, 'insights')} className="ins-project-card">
          <div className="ins-project-card-head">
            <strong>{p.name}</strong>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {p.archived ? <Badge tone="muted">Archived</Badge> : null}
              {p.connection ? <Badge tone="accent">{p.connection.provider}</Badge> : null}
            </div>
          </div>
          <dl className="kv">
            <div><dt>Runs</dt><dd>{p.runs}</dd></div>
            <div><dt>Cost</dt><dd>{money(p.costUsd, 2)}{fmtCredits(p.credits) ? ` / ${fmtCredits(p.credits)}` : ''}</dd></div>
            <div><dt>Success</dt><dd>
              {p.successRate !== null && p.successRate !== undefined
                ? `${(p.successRate * 100).toFixed(0)}%`
                : '—'}
            </dd></div>
            {p.activeSessions > 0 ? <div><dt>Active</dt><dd><Badge tone="accent">{p.activeSessions}</Badge></dd></div> : null}
            {p.pendingInputs > 0 ? <div><dt>Waiting</dt><dd><Badge tone="warn">{p.pendingInputs}</Badge></dd></div> : null}
          </dl>
          {p.lastActivity ? <p className="muted small">{timeAgo(p.lastActivity)}</p> : null}
        </a>
      ))}
    </div>
  );
}
