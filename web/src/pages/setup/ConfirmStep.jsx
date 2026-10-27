import { useState } from 'react';
import { api } from '../../lib/api.js';

const PROVIDER_LABELS = {
  demo:       'Demo mode (no real API calls)',
  anthropic:  'Anthropic API',
  bedrock:    'Amazon Bedrock',
  kiro:       'Kiro CLI',
};

/**
 * @param {{
 *   data: object,
 *   onFinish: (data: object) => void,
 *   onBack: () => void,
 *   busy: boolean,
 * }} props
 */
export function ConfirmStep({ data, onFinish, onBack, busy }) {
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const rows = [
    { label: 'Deploy target', value: data.target === 'cloud' ? 'Server / cloud' : 'Local PC / laptop' },
    { label: 'Admin name',    value: data.name },
    { label: 'Admin email',   value: data.email },
    { label: 'Provider',      value: PROVIDER_LABELS[data.provider] || data.provider },
    data.provider === 'bedrock' && { label: 'AWS region', value: data.region },
    data.provider === 'bedrock' && { label: 'Auth method', value: data.authMethod },
    data.target === 'cloud' && data.secretsArn && { label: 'Secrets ARN', value: data.secretsArn },
    data.s3Enabled && { label: 'S3 bucket', value: `${data.s3Bucket} (${data.s3Region})` },
  ].filter(Boolean);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post('/api/settings/test', {
        provider: data.provider,
        apiKey: data.apiKey || undefined,
        region: data.region || undefined,
        authMethod: data.authMethod || undefined,
      });
      setTestResult({ ok: true, message: r.message || 'Connection successful.' });
    } catch (err) {
      setTestResult({ ok: false, message: err.message || 'Connection failed.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="wizard-heading">
        <h1>Review your choices</h1>
        <p>Check everything looks right, then finish setup.</p>
      </div>

      <table className="confirm-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.provider !== 'demo' && (
        <div style={{ marginBottom: '16px' }}>
          <button
            type="button"
            className="btn"
            onClick={testConnection}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <div className={`test-result ${testResult.ok ? 'ok' : 'error'}`}>
              {testResult.message}
            </div>
          )}
        </div>
      )}

      <div className="wizard-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onFinish(data)}
          disabled={busy}
        >
          {busy ? 'Setting up…' : 'Finish setup'}
        </button>
      </div>
    </div>
  );
}
