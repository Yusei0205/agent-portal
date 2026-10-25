import { useProject } from '../../lib/context.js';
import { href } from '../../lib/router.js';
import { Badge, Note } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';

/** Where the output is shown: the item page inside the Create page. */
export function outputHref(projectId, output) {
  return href(projectId, output.tab, output.id);
}

const STATE = {
  ready: { tone: 'ok', word: 'ready' },
  generating: { tone: 'accent', word: 'being made' },
  error: { tone: 'danger', word: 'error' },
};

/**
 * Shown at the top of the workspace of a session that makes a diagram, document or deck: what it is making, whether that
 * worked and why not, with a link to it. Without it a failed or finished output is invisible from the session.
 */
export function OutputBanner({ output }) {
  const { project } = useProject();
  if (!output) return null;
  const st = STATE[output.status] || STATE.ready;
  const failedRefresh = output.status === 'ready' && output.error;
  const dense = output.density?.dense;
  return (
    <div className="ws-output" role="status" aria-label={`${output.label} made by this session`}>
      <Note
        tone={output.status === 'error' ? 'danger' : failedRefresh || dense ? 'warn' : output.status === 'generating' ? 'info' : 'ok'}
        icon={output.status === 'error' ? 'alert' : 'builder'}
        action={
          <a className="btn btn-default btn-sm" href={outputHref(project.id, output)}>
            Open the {output.label.toLowerCase()}
          </a>
        }
      >
        <div>
          This session is producing <strong>{output.label}: {output.title}</strong> — status <Badge tone={st.tone}>{st.word}</Badge>
          {output.version ? <span className="muted small"> · version {output.version}</span> : null}
          {output.status === 'error' && output.error ? <>: <span className="ws-output-reason">{output.error}</span></> : null}
        </div>
        {failedRefresh ? <div className="small">The last attempt was not stored ({output.error}) The earlier version is still the current one.</div> : null}
        {dense ? (
          <div className="small" data-testid="dense-note">
            Very dense diagram (about {output.density.nodes} nodes, {output.density.lines} lines): it may be hard to read. Ask the agent below to group it into subgraphs or to draw a smaller one; use Full size on the picture to zoom.
          </div>
        ) : null}
        {output.vault_files?.length ? (
          <div className="small">
            Saved in the Vault: <a href={href(project.id, 'vault')}>{output.vault_files.join(', ')}</a>
          </div>
        ) : null}
      </Note>
    </div>
  );
}

/** A card with the output as a link, for the Live tab (where the final answer is read): Open, and Open in Vault when saved. */
export function OutputCard({ output }) {
  const { project } = useProject();
  if (!output) return null;
  const ready = output.status === 'ready' || Boolean(output.version);
  return (
    <section className="panel ws-output-card" aria-label={`${output.label} from this session`}>
      <div className="row tight wrap">
        <Icon name="builder" size={16} aria-hidden="true" />
        <strong>
          {output.label}: {output.title}
        </strong>
        {output.version ? <span className="muted small">v{output.version}</span> : null}
        <Badge tone={(STATE[output.status] || STATE.ready).tone}>{(STATE[output.status] || STATE.ready).word}</Badge>
        <span className="ws-output-actions row tight">
          <a className="btn btn-primary btn-sm" href={outputHref(project.id, output)}>
            Open
          </a>
          {output.vault_files?.length ? (
            <a className="btn btn-default btn-sm" href={href(project.id, 'vault')}>
              Open in Vault
            </a>
          ) : null}
        </span>
      </div>
      {!ready && output.status !== 'generating' ? <p className="muted small">Nothing was stored yet. {output.error || ''}</p> : null}
    </section>
  );
}
