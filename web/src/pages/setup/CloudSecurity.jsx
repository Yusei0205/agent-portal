/**
 * @param {{
 *   data: { secretsArn: string },
 *   onChange: (patch: object) => void,
 *   onNext: () => void,
 *   onBack: () => void,
 * }} props
 */
export function CloudSecurity({ data, onChange, onNext, onBack }) {
  return (
    <div>
      <div className="wizard-heading">
        <h1>Security configuration</h1>
        <p>Optional: store your secret key in AWS rather than on disk.</p>
      </div>

      <div className="stack">
        <div
          className="card"
          style={{ background: 'var(--ok-wash)', border: '1px solid color-mix(in srgb, var(--ok) 20%, transparent)' }}
        >
          <p className="small">
            <strong>Secret key:</strong> The portal auto-generated a secret key and stored it in{' '}
            <code>data/master.key</code>. You can override this with an AWS Secrets Manager secret
            or SSM Parameter Store path below.
          </p>
        </div>

        <div className="field">
          <label htmlFor="setup-secrets-arn">
            AWS Secrets Manager ARN or SSM path{' '}
            <span className="muted">(optional)</span>
          </label>
          <input
            id="setup-secrets-arn"
            type="text"
            value={data.secretsArn}
            onChange={(e) => onChange({ secretsArn: e.target.value })}
            placeholder="arn:aws:secretsmanager:…  or  /portal/secret-key"
          />
          <span className="field-hint">
            Leave blank to use the auto-generated key in <code>data/master.key</code>.
          </span>
        </div>

        <div
          className="card"
          style={{ background: 'var(--accent-wash)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' }}
        >
          <p className="small">
            <strong>TRUST_PROXY is enabled</strong> for this cloud deployment. The portal trusts
            the{' '}
            <code>X-Forwarded-For</code> and <code>X-Forwarded-Proto</code> headers from your
            reverse proxy (Caddy, nginx, ALB). Make sure the portal is not directly reachable
            from the internet.
          </p>
        </div>
      </div>

      <div className="wizard-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onNext}>
          Next
        </button>
      </div>
    </div>
  );
}
