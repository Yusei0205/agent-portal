import { useState } from 'react';
import { api } from '../../lib/api.js';
import { AwsRegionSelect } from '../../components/AwsRegionSelect.jsx';

/**
 * @param {{
 *   data: { s3Enabled: boolean, s3Bucket: string, s3Region: string, s3Prefix: string },
 *   onChange: (patch: object) => void,
 *   onNext: () => void,
 *   onBack: () => void,
 * }} props
 */
export function CloudStorage({ data, onChange, onNext, onBack }) {
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const testStorage = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post('/api/admin/test-storage', {
        bucket: data.s3Bucket,
        region: data.s3Region,
        prefix: data.s3Prefix,
      });
      setTestResult({ ok: true, message: r.message || 'S3 access verified.' });
    } catch (err) {
      setTestResult({ ok: false, message: err.message || 'S3 access failed.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="wizard-heading">
        <h1>Storage</h1>
        <p>
          By default the portal stores files on the server's local disk. Enable S3 for
          shared, durable storage.
        </p>
      </div>

      <div className="stack">
        <label className="choice">
          <input
            type="checkbox"
            checked={data.s3Enabled}
            onChange={(e) => onChange({ s3Enabled: e.target.checked })}
          />
          <div>
            <strong>Use Amazon S3 for file storage</strong>
            <div className="muted small">
              Uploaded documents, agent outputs and Vault files are stored in S3.
            </div>
          </div>
        </label>

        {data.s3Enabled && (
          <div className="card stack">
            <div className="field">
              <label htmlFor="setup-s3-bucket">S3 bucket name</label>
              <input
                id="setup-s3-bucket"
                type="text"
                value={data.s3Bucket}
                onChange={(e) => onChange({ s3Bucket: e.target.value })}
                placeholder="my-portal-bucket"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="setup-s3-region">Bucket region</label>
              <AwsRegionSelect
                id="setup-s3-region"
                value={data.s3Region}
                onChange={(e) => onChange({ s3Region: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="setup-s3-prefix">
                Key prefix <span className="muted">(optional)</span>
              </label>
              <input
                id="setup-s3-prefix"
                type="text"
                value={data.s3Prefix}
                onChange={(e) => onChange({ s3Prefix: e.target.value })}
                placeholder="portal/"
              />
              <span className="field-hint">
                All files will be stored under this prefix in the bucket.
              </span>
            </div>

            <div>
              <button
                type="button"
                className="btn"
                onClick={testStorage}
                disabled={testing || !data.s3Bucket || !data.s3Region}
              >
                {testing ? 'Testing…' : 'Test S3 access'}
              </button>
              {testResult && (
                <div
                  className={`test-result ${testResult.ok ? 'ok' : 'error'}`}
                >
                  {testResult.message}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="wizard-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-ghost" onClick={onNext}>
          Skip
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onNext}
          disabled={data.s3Enabled && (!data.s3Bucket || !data.s3Region)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
