import { Icon } from './Icon.jsx';
import { useArtifactReveal } from '../lib/artifact-reveal.js';

export function ArtifactHeading({ title, kind, state }) {
  const generating = state === 'generating';
  const failed = state === 'failed';
  return <div className="artifact-heading">
    <span className={`artifact-glyph is-${state}`} aria-hidden="true"><Icon name={generating ? 'refresh' : failed ? 'warning' : 'file'} size={18} /></span>
    <div className="artifact-heading-copy"><span className="db-eyebrow">{kind}</span><strong>{title}</strong></div>
    <span className={`badge ${generating ? 'badge-info' : failed ? 'badge-danger' : 'badge-ok'}`}>{generating ? 'Generating…' : failed ? 'Failed' : 'Ready'}</span>
  </div>;
}

export function ArtifactCard({ artifactId, title, kind, state, updatedAt, detail, error, children }) {
  const fresh = useArtifactReveal(artifactId, state === 'ready', updatedAt);
  return <article className={`artifact-card${fresh ? ' artifact-card--new' : ''}`} aria-label={`${kind}: ${title}`}>
    <ArtifactHeading title={title} kind={kind} state={state} />
    {detail && <p className="artifact-detail">{detail}</p>}
    {state === 'generating' && <div className="artifact-progress" role="status"><span>Working on your artifact. Follow the session for live activity.</span><div className="artifact-progress-track" aria-hidden="true" /></div>}
    {state === 'failed' && error && <p className="error-note">{String(error).slice(0, 300)}</p>}
    <div className="artifact-actions">{children}</div>
  </article>;
}
