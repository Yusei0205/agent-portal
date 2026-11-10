/**
 * Configuration team-default status card.
 * Shows whether the user is following the team default or has customised their config.
 * Redesigned as a bordered card with a badge, summary text, and action buttons.
 */

import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { useConfirm, ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { useToast, ToastShelf } from '../../components/Toast.jsx';

function timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * @param {{
 *   folder: string,
 *   status: { following: boolean, customisedAt: string|null, teamVersion: string|null, teamPublishedAt: string|null },
 *   user: object,
 *   onStatusChange: () => void,
 * }} props
 */
export function ConfigStatus({ folder, status, user, onStatusChange }) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState(null);
  const [published, setPublished] = useState(false);
  const { confirmState, requestConfirm } = useConfirm();
  const { toast, toasts, removeToast } = useToast();

  if (!status) return null;

  // Only show the card when there's a published team version, or the user is an admin
  // (admins can always publish a team default).
  const hasTeamVersion = !!status.teamVersion;
  if (!hasTeamVersion && !user?.is_admin) return null;

  const handleReset = async () => {
    const ok = await requestConfirm(
      'Reset to team default? Your changes will be replaced by the current team version.',
      'Reset',
      'danger',
    );
    if (!ok) return;
    setResetting(true);
    setResetError(null);
    try {
      await api.post(`/api/user-config/${folder}/reset`, {});
      onStatusChange?.();
    } catch (e) {
      setResetError(e.message);
    } finally {
      setResetting(false);
    }
  };

  const handlePublish = async () => {
    const ok = await requestConfirm(
      'Publish your current config as the team default? Users following the team default will receive this version.',
      'Publish',
      'primary',
    );
    if (!ok) return;
    setPublishing(true);
    setPublishError(null);
    setPublished(false);
    try {
      await api.post(`/api/admin/user-config/${folder}/publish`, {});
      setPublished(true);
      onStatusChange?.();
    } catch (e) {
      setPublishError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const isFollowing = status.following && hasTeamVersion;

  return (
    <div
      className={`config-status-card${isFollowing ? ' is-following' : ' is-custom'}`}
      role="region"
      aria-label={`${folder} configuration team-default status`}
    >
      <div className="config-status-card-body">
        <div className="config-status-card-info">
          <span
            className={`config-status-badge${isFollowing ? ' is-following' : ' is-custom'}`}
            role="status"
          >
            {isFollowing ? (
              <>
                <Icon name="check" size={12} aria-hidden="true" />
                Following team default
              </>
            ) : (
              <>
                <Icon name="info" size={12} aria-hidden="true" />
                Your own configuration
              </>
            )}
          </span>

          {isFollowing ? (
            <span className="config-status-text">
              You are using the team's default configuration for{' '}
              <code style={{ fontFamily: 'var(--mono)', fontSize: '0.82em' }}>.{folder}</code>.
            </span>
          ) : (
            <span className="config-status-text">
              You changed your configuration
              {status.customisedAt
                ? ` on ${new Date(status.customisedAt).toLocaleDateString()}`
                : ''}
              , so team publishes skip you. Reset to the team default to follow it again.
            </span>
          )}

          {hasTeamVersion && (
            <span className="config-status-version" aria-label="Team version info">
              Current version {status.teamVersion.slice(0, 8)}
              {status.teamPublishedAt ? `, published ${timeAgo(status.teamPublishedAt)}` : ''}
            </span>
          )}
        </div>

        {!isFollowing && hasTeamVersion && (
          <div className="config-status-card-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleReset}
              disabled={resetting}
              aria-label="Reset to team default configuration"
            >
              {resetting ? 'Resetting…' : 'Reset to Team Default'}
            </button>
          </div>
        )}
      </div>

      {resetError && (
        <p className="error-note" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
          {resetError}
        </p>
      )}

      {user?.is_admin && (
        <div className="config-status-card-admin">
          <button
            type="button"
            className="btn btn-sm"
            onClick={handlePublish}
            disabled={publishing}
            aria-label={`Publish current ${folder} config as team default`}
          >
            <Icon name="upload" size={13} />
            {publishing ? 'Publishing…' : 'Publish as team default'}
          </button>
          {published && (
            <span style={{ fontSize: '0.82rem', color: 'var(--ok)' }} role="status">
              ✓ Published
            </span>
          )}
          {publishError && (
            <span className="error-note" role="alert" style={{ fontSize: '0.82rem' }}>
              {publishError}
            </span>
          )}
        </div>
      )}

      <ConfirmDialog state={confirmState} />
      <ToastShelf toasts={toasts} onRemove={removeToast} />
    </div>
  );
}
