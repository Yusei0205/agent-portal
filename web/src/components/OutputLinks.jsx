import { useProject } from '../lib/context.js';
import { href, sessionHref } from '../lib/router.js';

/**
 * On a diagram, document or deck page: a link back to the session that made it and to its copies in the project Vault
 * (generated/...). Shown whatever the status, so the session stays one click away once the work is done.
 */
export function OutputLinks({ sessionId, vaultFiles }) {
  const { project } = useProject();
  if (!sessionId && !vaultFiles?.length) return null;
  return (
    <p className="small output-links">
      {sessionId ? (
        <a href={sessionHref(project.id, sessionId)} data-testid="output-session-link">
          Open the session
        </a>
      ) : null}
      {sessionId && vaultFiles?.length ? <span className="muted"> · </span> : null}
      {vaultFiles?.length ? (
        <span>
          Saved in the Vault:{' '}
          <a href={href(project.id, 'vault')} data-testid="output-vault-link">
            {vaultFiles.join(', ')}
          </a>
        </span>
      ) : null}
    </p>
  );
}
