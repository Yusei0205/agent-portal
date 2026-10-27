/**
 * Model provider settings tab.
 *
 * - Provider radio group: Demo / Anthropic API / Amazon Bedrock / Kiro CLI
 * - Fields per provider
 * - "Test connection" button
 * - Save button
 * - Model versions override section
 */

import { useState, useId } from 'react';
import { api } from '../../lib/api.js';

const PROVIDERS = [
  { id: 'demo',       label: 'Demo',           description: 'Simulated runs, no API key needed. For testing the portal.' },
  { id: 'anthropic',  label: 'Anthropic API',  description: 'Run agents via api.anthropic.com with an API key.' },
  { id: 'bedrock',    label: 'Amazon Bedrock', description: 'Run agents via AWS Bedrock (Claude models). Use IAM credentials.' },
  { id: 'kiro',       label: 'Kiro CLI',       description: 'Run agents via the Kiro CLI engine.' },
];

const BEDROCK_AUTH_OPTIONS = [
  { value: 'ambient',     label: 'Server\'s own AWS identity (instance role / ECS task role / env vars)' },
  { value: 'profile',     label: 'Named AWS profile (~/.aws/credentials)' },
  { value: 'keys',        label: 'Access key ID + secret access key' },
  { value: 'bedrock-key', label: 'Amazon Bedrock API key' },
  { value: 'sso',         label: 'AWS SSO / IAM Identity Center' },
];

export default function Providers({ settings, onSaved }) {
  const uid = useId();

  // Provider mode
  const [mode, setMode] = useState(settings?.provider?.mode ?? 'demo');

  // Anthropic
  const [anthropicKey, setAnthropicKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Bedrock
  const [bedrockRegion, setBedrockRegion] = useState(settings?.provider?.bedrockRegion ?? 'us-east-1');
  const [bedrockAuth, setBedrockAuth] = useState(settings?.provider?.bedrockAuth ?? 'ambient');
  const [bedrockProfile, setBedrockProfile] = useState(settings?.provider?.bedrockProfile ?? '');
  const [bedrockAccessKeyId, setBedrockAccessKeyId] = useState(settings?.provider?.bedrockAccessKeyId ?? '');
  const [bedrockSecretKey, setBedrockSecretKey] = useState('');
  const [showBedrockKey, setShowBedrockKey] = useState(false);

  // Kiro
  const [kiroApiKey, setKiroApiKey] = useState('');
  const [showKiroKey, setShowKiroKey] = useState(false);

  // Model overrides
  const [modelSonnet, setModelSonnet] = useState(settings?.models?.sonnet ?? '');
  const [modelHaiku, setModelHaiku] = useState(settings?.models?.haiku ?? '');
  const [modelOpus, setModelOpus] = useState(settings?.models?.opus ?? '');

  // UI state
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post('/api/settings/test', { modeOverride: mode });
      setTestResult({ ok: result.ok, models: result.models, error: result.error });
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    setSaved(false);

    try {
      const providerPayload = {
        mode,
        bedrockRegion,
        bedrockAuth,
        bedrockProfile,
        bedrockAccessKeyId,
      };
      if (anthropicKey) providerPayload.anthropicKey = anthropicKey;
      if (bedrockSecretKey) providerPayload.bedrockKey = bedrockSecretKey;

      const kiroPayload = kiroApiKey || undefined;

      const body = {
        provider: providerPayload,
        models: { sonnet: modelSonnet, haiku: modelHaiku, opus: modelOpus },
      };
      if (kiroPayload !== undefined) body.kiroApiKey = kiroPayload;

      const updated = await api.put('/api/settings', body);
      onSaved?.(updated);
      setSaved(true);
      // Clear secret fields after save
      setAnthropicKey('');
      setBedrockSecretKey('');
      setKiroApiKey('');
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Model provider settings">
      <h2>Model provider</h2>

      <form onSubmit={save} className="stack" noValidate>
        {/* Provider selector */}
        <fieldset className="fieldset">
          <legend>Provider</legend>
          <div className="radio-group" role="radiogroup" aria-label="Select model provider">
            {PROVIDERS.map((p) => (
              <label key={p.id} className={`radio-card${mode === p.id ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name={`${uid}-provider`}
                  value={p.id}
                  checked={mode === p.id}
                  onChange={() => { setMode(p.id); setSaved(false); setTestResult(null); }}
                />
                <span className="radio-card-label">{p.label}</span>
                <span className="radio-card-desc muted small">{p.description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Anthropic API fields */}
        {mode === 'anthropic' && (
          <div className="provider-fields stack">
            <div className="field">
              <label htmlFor={`${uid}-anthropic-key`}>API key</label>
              <div className="input-with-action">
                <input
                  id={`${uid}-anthropic-key`}
                  type={showKey ? 'text' : 'password'}
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder={settings?.provider?.hasKey ? '••••••••••••••••••• (set — enter to replace)' : 'sk-ant-…'}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Hide API key' : 'Show API key'}
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="field-hint">
                Get your key at{' '}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer">
                  console.anthropic.com
                </a>.
              </p>
            </div>
          </div>
        )}

        {/* Bedrock fields */}
        {mode === 'bedrock' && (
          <div className="provider-fields stack">
            <div className="field">
              <label htmlFor={`${uid}-bedrock-region`}>AWS region</label>
              <input
                id={`${uid}-bedrock-region`}
                type="text"
                value={bedrockRegion}
                onChange={(e) => setBedrockRegion(e.target.value)}
                placeholder="us-east-1"
              />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-bedrock-auth`}>Sign-in method</label>
              <select
                id={`${uid}-bedrock-auth`}
                value={bedrockAuth}
                onChange={(e) => setBedrockAuth(e.target.value)}
              >
                {BEDROCK_AUTH_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {bedrockAuth === 'profile' && (
              <div className="field">
                <label htmlFor={`${uid}-bedrock-profile`}>Profile name</label>
                <input
                  id={`${uid}-bedrock-profile`}
                  type="text"
                  value={bedrockProfile}
                  onChange={(e) => setBedrockProfile(e.target.value)}
                  placeholder="default"
                />
              </div>
            )}

            {bedrockAuth === 'keys' && (
              <>
                <div className="field">
                  <label htmlFor={`${uid}-bedrock-access-key`}>Access key ID</label>
                  <input
                    id={`${uid}-bedrock-access-key`}
                    type="text"
                    value={bedrockAccessKeyId}
                    onChange={(e) => setBedrockAccessKeyId(e.target.value)}
                    placeholder="AKIA…"
                    autoComplete="off"
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-bedrock-secret`}>Secret access key</label>
                  <div className="input-with-action">
                    <input
                      id={`${uid}-bedrock-secret`}
                      type={showBedrockKey ? 'text' : 'password'}
                      value={bedrockSecretKey}
                      onChange={(e) => setBedrockSecretKey(e.target.value)}
                      placeholder={settings?.provider?.bedrockKey ? '••••••••••••••••••• (set — enter to replace)' : ''}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowBedrockKey((v) => !v)}
                      aria-label={showBedrockKey ? 'Hide key' : 'Show key'}
                    >
                      {showBedrockKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
              </>
            )}

            {(bedrockAuth === 'bedrock-key') && (
              <div className="field">
                <label htmlFor={`${uid}-bedrock-api-key`}>Bedrock API key</label>
                <div className="input-with-action">
                  <input
                    id={`${uid}-bedrock-api-key`}
                    type={showBedrockKey ? 'text' : 'password'}
                    value={bedrockSecretKey}
                    onChange={(e) => setBedrockSecretKey(e.target.value)}
                    placeholder={settings?.provider?.bedrockKey ? '••••••••••••••••••• (set — enter to replace)' : ''}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowBedrockKey((v) => !v)}
                    aria-label={showBedrockKey ? 'Hide key' : 'Show key'}
                  >
                    {showBedrockKey ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Kiro CLI fields */}
        {mode === 'kiro' && (
          <div className="provider-fields stack">
            <p className="muted small">
              Agent runs use the Kiro CLI on the server. Run{' '}
              <code>kiro-cli login --use-device-flow</code> on the server to authenticate.
            </p>
            <div className="field">
              <label htmlFor={`${uid}-kiro-key`}>Kiro API key (optional)</label>
              <div className="input-with-action">
                <input
                  id={`${uid}-kiro-key`}
                  type={showKiroKey ? 'text' : 'password'}
                  value={kiroApiKey}
                  onChange={(e) => setKiroApiKey(e.target.value)}
                  placeholder={settings?.kiroApiKeySet ? '••••••••••••••••••• (set — enter to replace)' : 'Leave blank to use the CLI sign-in'}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowKiroKey((v) => !v)}
                  aria-label={showKiroKey ? 'Hide key' : 'Show key'}
                >
                  {showKiroKey ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Test connection */}
        <div className="inline-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={testConnection}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <span
              className={testResult.ok ? 'test-ok' : 'test-error'}
              role="status"
              aria-live="polite"
            >
              {testResult.ok
                ? `✓ Connected${testResult.models?.length ? ` — ${testResult.models.length} model(s) found` : ''}`
                : `✗ ${testResult.error || 'Connection failed'}`}
            </span>
          )}
        </div>

        {/* Save / status */}
        {saveError && <p className="error-note" role="alert">{saveError}</p>}
        {saved && <p className="success-note" role="status">Settings saved.</p>}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>

      {/* Model versions override */}
      <hr style={{ margin: '2rem 0' }} />
      <ModelVersions
        sonnet={modelSonnet}
        haiku={modelHaiku}
        opus={modelOpus}
        onChange={{ sonnet: setModelSonnet, haiku: setModelHaiku, opus: setModelOpus }}
      />
    </section>
  );
}

// ── Model versions section ─────────────────────────────────────────────────────

const MODEL_ALIASES = [
  { key: 'sonnet', label: 'Sonnet',  placeholder: 'claude-sonnet-4-5' },
  { key: 'haiku',  label: 'Haiku',   placeholder: 'claude-haiku-4-5' },
  { key: 'opus',   label: 'Opus',    placeholder: 'claude-opus-4-5' },
];

function ModelVersions({ sonnet, haiku, opus, onChange }) {
  const uid = useId();
  const values = { sonnet, haiku, opus };

  return (
    <section aria-label="Model version overrides">
      <h3>Model versions</h3>
      <p className="muted small">
        Override the default model IDs for each alias. Leave blank to use the built-in defaults.
        Useful when your Bedrock account requires specific inference profile ARNs.
      </p>
      <div className="stack" style={{ maxWidth: 480 }}>
        {MODEL_ALIASES.map(({ key, label, placeholder }) => (
          <div key={key} className="field">
            <label htmlFor={`${uid}-model-${key}`}>{label} model ID</label>
            <input
              id={`${uid}-model-${key}`}
              type="text"
              value={values[key]}
              onChange={(e) => onChange[key](e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
