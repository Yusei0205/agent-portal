import { Icon } from '../../components/Icon.jsx';
import { getFileTypeMeta } from '../../lib/outputFileUtils.js';
import { href } from '../../lib/router.js';
import { isVerifyCall } from '../../lib/execution-stages.js';
import { useArtifactReveal } from '../../lib/artifact-reveal.js';

const MODES = [['code', 'Code', 'code-2'], ['run', 'Run', 'activity'], ['review', 'Review', 'git-diff']];

function ArtifactChip({ file, workflowId, onPreview }) {
  const fresh = useArtifactReveal(`${workflowId}:${file.id}:v${file.version || 1}`, true, file.created_at);
  return <button type="button" className={`session-artifact-chip${fresh ? ' is-new' : ''}`} onClick={() => onPreview(file)} title={`Preview ${file.name}`}>
    <Icon name={getFileTypeMeta(file.mime_type, file.name).icon} size={16} aria-hidden="true" />
    <span>{file.name}</span>{file.version > 1 && <small>v{file.version}</small>}
  </button>;
}

export function SessionCommandBar({ mode, onMode, focus, onFocus, onDecision, workflow, telemetry, git, gitError, outputs, onFiles, onTerminal, terminalOpen, onOutputs, onPreview, onOpenFile }) {
  const running = ['running', 'pending'].includes(workflow?.status);
  const summary = telemetry?.summary;
  const active = running ? [...(summary?.calls || [])].reverse().find((call) => call.status === 'running') : null;
  const task = summary?.todos?.items.find((item) => item.status === 'active');
  const needsDecision = telemetry?.pendingApproval && ['running', 'blocked'].includes(workflow?.status);
  const repo = git?.repos?.[0];
  const changed = git ? (git.repos || []).reduce((count, item) => count + (item.files?.length || 0), 0) : null;
  const activity = needsDecision ? 'Approval required · respond in the conversation' : workflow?.status === 'blocked' ? 'Needs your decision' : active ? `${active.name} · ${active.file || active.preview || 'Working'}` : running ? task?.text || 'Agent is working' : workflow?.status === 'done' ? 'Session completed' : workflow?.status === 'failed' ? 'Session needs attention' : workflow?.status === 'paused' ? 'Session paused · send a message to continue' : 'Ready for your next instruction';
  return <div className="session-command-deck">
    <div className="session-command-row">
      <button type="button" className="session-repo-chip" onClick={onFiles} title={repo ? `${repo.name} · ${repo.branch || 'branch unavailable'}` : gitError || 'Open workspace files'}>
        <Icon name="git-branch" size={14} aria-hidden="true" />
        <span>{repo?.name || (gitError ? 'Repository unavailable' : git ? 'Playground' : 'Loading repository…')}</span>
        {repo?.branch && <code>{repo.branch}</code>}
      </button>
      <div className="session-layout-switch" role="group" aria-label="Workspace mode" style={{ '--session-mode-index': MODES.findIndex(([key]) => key === mode) }}>
        <span className="session-layout-indicator" aria-hidden="true" />
        {MODES.map(([key, label, icon]) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => onMode(key)}><Icon name={icon} size={14} aria-hidden="true" />{label}</button>)}
      </div>
      <div className="session-command-tools">
        <button type="button" className="session-tool-button" onClick={onTerminal} aria-pressed={terminalOpen} title="Toggle terminal (Ctrl+`)"><Icon name="terminal" size={14} aria-hidden="true" /><span>Terminal</span></button>
        <button type="button" className="session-tool-button" onClick={onFocus} aria-pressed={focus} title="Focus conversation (Alt+F)"><Icon name="maximize" size={14} aria-hidden="true" /><span>Focus</span></button>
      </div>
    </div>
    <div className={`session-activity-strip${running && !needsDecision ? ' is-running' : ''}${needsDecision || workflow?.status === 'blocked' || workflow?.status === 'failed' ? ' needs-attention' : ''}`} aria-label="Current session activity">
      <span className="session-activity-signal" aria-hidden="true" />
      <button type="button" className="session-current-action" onClick={() => needsDecision && onDecision ? onDecision() : active?.file && onOpenFile ? onOpenFile(active.file) : onMode('run')} title={activity}><span>{running ? 'NOW' : 'STATUS'}</span><strong>{activity}</strong></button>
      <div className="session-activity-metrics">
        <span className="session-stream-state">{running ? telemetry?.error ? 'Stream unavailable' : telemetry?.connected ? 'Live stream' : 'Connecting…' : 'Recorded activity'}</span>
        <button type="button" onClick={() => onMode('review')}>{changed === null ? '—' : changed} changes</button>
        <button type="button" onClick={onOutputs}>{outputs.length} outputs</button>
      </div>
    </div>
    {outputs.length > 0 && mode !== 'code' && !focus && <div className="session-artifact-shelf" aria-label="Session artifacts">
      <span className="session-shelf-label">Artifacts</span>
      {outputs.slice(0, 3).map((file) => <ArtifactChip key={file.id} file={file} workflowId={workflow?.id} onPreview={onPreview} />)}
      <button type="button" className="session-shelf-all" onClick={onOutputs}>View all ({outputs.length})</button>
    </div>}
  </div>;
}

export function SessionReviewOverview({ summary, git, gitError, outputs, projectId, onBrowse, onOutputs }) {
  const changed = git ? (git.repos || []).reduce((count, repo) => count + (repo.files?.length || 0), 0) : null;
  const checks = (summary?.calls || []).filter(isVerifyCall);
  return <section className="session-review-overview" aria-label="Review summary">
    <div className="session-review-heading"><Icon name="git-diff" size={20} aria-hidden="true" /><div><h2>Review the result</h2><p>Inspect the changes and recorded checks before approving a result.</p></div></div>
    <div className="session-review-metrics">
      <button type="button" onClick={onBrowse}><strong>{changed === null ? '—' : changed}</strong><span>Changed files</span></button>
      <div><strong>{checks.length}</strong><span>Observed check commands</span></div>
      <div className={summary?.counts.failed ? 'is-failed' : ''}><strong>{summary?.counts.failed ?? '—'}</strong><span>Recorded tool failures</span></div>
      <button type="button" onClick={onOutputs}><strong>{outputs.length}</strong><span>Output files</span></button>
    </div>
    <p className="session-verification-note">{checks.length ? `${checks.filter((call) => call.status === 'done').length} check commands completed · ${checks.filter((call) => call.status === 'failed').length} failed · ${checks.filter((call) => call.status === 'running').length} without a recorded result. Inspect the logs before approving.` : 'Verification has not been reported in the loaded activity.'}</p>
    {gitError && <p className="error-note">{gitError}</p>}
    <div className="session-review-actions"><button type="button" className="btn btn-sm btn-primary" onClick={onBrowse}>Browse changed files</button><a className="btn btn-sm" href={href(projectId, 'reviews', 'code')}>Project reviews</a></div>
  </section>;
}
