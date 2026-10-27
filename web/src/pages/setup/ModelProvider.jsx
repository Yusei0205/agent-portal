const PROVIDERS = [
  {
    id: 'demo',
    label: 'Demo mode',
    sub: 'No API key required. Simulated agent runs to explore the portal.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    sub: 'Requires an API key from console.anthropic.com.',
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    sub: 'Requires AWS access and enabled Claude models in Bedrock console.',
  },
  {
    id: 'kiro',
    label: 'Kiro CLI',
    sub: 'Uses the Kiro CLI installed on this server. Install it first under Settings › Tools.',
  },
];

const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
];

const AUTH_METHODS = [
  { value: 'instance',  label: "Server's own AWS identity (instance role / task role)" },
  { value: 'profile',   label: 'Named AWS profile' },
  { value: 'keys',      label: 'Access key + secret key' },
  { value: 'bedrock-key', label: 'Bedrock API key' },
  { value: 'sso',       label: 'AWS SSO / IAM Identity Center' },
];

/**
 * @param {{
 *   data: { provider: string, apiKey: string, region: string, authMethod: string },
 *   onChange: (patch: object) => void,
 *   onNext: () => void,
 *   onBack: () => void,
 * }} props
 */
export function ModelProvider({ data, onChange, onNext, onBack }) {
  const valid =
    data.provider === 'demo' ||
    data.provider === 'kiro' ||
    (data.provider === 'anthropic' && data.apiKey.trim()) ||
    (data.provider === 'bedrock' && data.region);

  return (
    <div>
      <div className="wizard-heading">
        <h1>Choose a model provider</h1>
        <p>You can change this later under Settings › Model provider.</p>
      </div>

      <div style={{ display: 'grid', gap: '8px' }}>
        {PROVIDERS.map((p) => (
          <label key={p.id} className="provider-option">
            <div className="provider-option-row">
              <input
                type="radio"
                name="provider"
                value={p.id}
                checked={data.provider === p.id}
                onChange={() => onChange({ provider: p.id })}
              />
              <span className="provider-option-label">{p.label}</span>
            </div>
            <div className="provider-option-sub">{p.sub}</div>

            {data.provider === 'anthropic' && p.id === 'anthropic' && (
              <div className="provider-fields">
                <div className="field">
                  <label htmlFor="setup-apikey">API key</label>
                  <input
                    id="setup-apikey"
                    type="password"
                    value={data.apiKey}
                    onChange={(e) => onChange({ apiKey: e.target.value })}
                    placeholder="sk-ant-..."
                    autoComplete="off"
                  />
                </div>
              </div>
            )}

            {data.provider === 'bedrock' && p.id === 'bedrock' && (
              <div className="provider-fields">
                <div className="field">
                  <label htmlFor="setup-region">AWS region</label>
                  <select
                    id="setup-region"
                    value={data.region}
                    onChange={(e) => onChange({ region: e.target.value })}
                  >
                    <option value="">— select region —</option>
                    {AWS_REGIONS.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="setup-auth-method">Authentication</label>
                  <select
                    id="setup-auth-method"
                    value={data.authMethod}
                    onChange={(e) => onChange({ authMethod: e.target.value })}
                  >
                    {AUTH_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {data.provider === 'kiro' && p.id === 'kiro' && (
              <div className="provider-fields">
                <div className="error-note" style={{ background: 'var(--warn-wash)', color: 'var(--warn)', borderColor: 'transparent' }}>
                  Install Kiro CLI first under <strong>Settings › Tools</strong>, then log in
                  with <code>kiro-cli login --use-device-flow</code>.
                </div>
              </div>
            )}
          </label>
        ))}
      </div>

      <div className="wizard-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onNext}
          disabled={!valid}
        >
          Next
        </button>
      </div>
    </div>
  );
}
