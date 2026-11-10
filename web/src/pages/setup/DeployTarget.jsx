/**
 * Deploy target selection — two-card picker.
 * @param {{ value: string, onChange: (target: 'local' | 'cloud') => void }} props
 */
export function DeployTarget({ value, onChange }) {
  return (
    <div>
      <div className="wizard-heading">
        <h1>Where are you running Agent Portal?</h1>
        <p>Choose the environment that best describes your setup.</p>
      </div>

      <div className="deploy-cards">
        <button
          type="button"
          className={`deploy-card${value === 'local' ? ' is-selected' : ''}`}
          onClick={() => onChange('local')}
          aria-pressed={value === 'local'}
        >
          <div className="deploy-card-icon" aria-hidden="true">🖥️</div>
          <div className="deploy-card-title">Local PC / laptop</div>
          <div className="deploy-card-sub">
            Running on your own machine. Simple setup, no cloud infrastructure needed.
            Uses a local SQLite database and your own API keys.
          </div>
          <div style={{ marginTop: '8px' }}>
            <span className="badge badge-ok">Recommended for individuals</span>
          </div>
        </button>

        <button
          type="button"
          className={`deploy-card${value === 'cloud' ? ' is-selected' : ''}`}
          onClick={() => onChange('cloud')}
          aria-pressed={value === 'cloud'}
        >
          <div className="deploy-card-icon" aria-hidden="true">☁️</div>
          <div className="deploy-card-title">Server / cloud</div>
          <div className="deploy-card-sub">
            Running on a server, EC2, or container. Team-friendly setup with optional
            AWS Secrets Manager for keys and S3 for storage.
          </div>
          <div style={{ marginTop: '8px' }}>
            <span className="badge">For teams and production</span>
          </div>
        </button>
      </div>

      <p className="muted small" style={{ marginTop: '14px' }}>
        Click a card to choose and continue. You can change settings later under{' '}
        <strong>Settings › Model provider</strong>.
      </p>
    </div>
  );
}
