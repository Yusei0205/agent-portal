import { useLoad } from '../lib/useAsync.js';
import { href } from '../lib/router.js';
import { api } from '../lib/api.js';
import { Spinner } from './ui.jsx';

const PROVIDER_LABEL = {
  demo: 'Demo',
  anthropic: 'Anthropic API',
  bedrock: 'Amazon Bedrock',
  kiro: 'Kiro CLI',
};

/**
 * Shows the effective provider and AWS account for a project as a compact clickable badge.
 * Clicking navigates to the project's Project setup, Connection & provider tab.
 *
 * Usage: <ConnectionBadge projectId="my-project" />
 */
export function ConnectionBadge({ projectId }) {
  const conn = useLoad(() => api.get(`/api/projects/${projectId}/connection`), [projectId]);

  if (conn.loading && !conn.data) return <Spinner small />;
  if (conn.error || !conn.data) return null;

  const c = conn.data;
  const providerLabel = PROVIDER_LABEL[c.provider] ?? c.provider;
  const sourceLabel = c.providerSource === 'project' ? ' (project)' : ' (Settings)';
  const awsSource = c.aws?.source === 'project' ? 'project account' : 'Settings account';
  const account = c.aws?.account ? c.aws.account : null;
  const region = c.aws?.region ?? null;

  // Build readable text:
  // "Kiro CLI · AWS 474189600089 · ap-southeast-1"
  // "Amazon Bedrock (project account) · AWS 4741… · ap-southeast-1"
  // "Amazon Bedrock (Settings) · AWS 4741… · ap-southeast-1"
  let parts = [];

  if (c.providerSource === 'settings') {
    parts.push(`${providerLabel} (Settings)`);
  } else if (c.provider === 'bedrock' && c.modelAws === 'project') {
    parts.push(`${providerLabel} (project account)`);
  } else {
    parts.push(providerLabel);
  }

  if (account) {
    const shortAccount = account.length > 8 ? account.slice(0, 6) + '…' : account;
    parts.push(`AWS ${shortAccount}`);
  }
  if (region) {
    parts.push(region);
  }

  const label = parts.join(' · ');

  return (
    <a
      href={href(projectId, 'setup', 'connection')}
      className="connection-badge"
      title={`Connection: ${providerLabel}${account ? `, AWS ${account}` : ''}${region ? `, ${region}` : ''} — click to configure`}
      aria-label={`Connection: ${label}. Click to configure.`}
    >
      {label}
    </a>
  );
}
