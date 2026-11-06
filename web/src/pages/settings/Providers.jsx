/**
 * Model provider settings tab.
 *
 * - Provider card picker: Demo / Anthropic API / Amazon Bedrock / Kiro CLI
 * - Fields per provider (grouped in a settings panel)
 * - Default model dropdown — fetched from GET /api/settings/models?provider=<mode>
 * - "Test connection" + Save buttons side by side
 *
 * Bedrock › AWS SSO / IAM Identity Center:
 *   Full device-code sign-in flow with account/role selection.
 *   Status row shows current session; Sign out clears it.
 *
 * Kiro CLI panel:
 *   Status from /kiro/status; device-code sign-in via /kiro/login; optional API key.
 *   Sign-in is portal-wide — all runs use the server's Kiro identity.
 */

import { useState, useEffect, useRef, useId } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { CodexCredentials } from '../../components/CodexCredentials.jsx';
import { DeviceCodeBox } from '../../components/DeviceCodeBox.jsx';
import { AwsRegionSelect } from '../../components/AwsRegionSelect.jsx';

// ── Constants ──────────────────────────────────────────────────────────────────

const PROVIDERS = [
  { id: 'codex', label: 'OpenAI Codex', icon: 'terminal', description: 'Use your ChatGPT sign-in for AI generation and Codex sessions.' },
  {
    id: 'demo',
    label: 'Demo',
    icon: 'sparkles',
    description: 'Simulated runs, no API key needed. For testing the portal.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    icon: 'cloud',
    description: 'Run agents via api.anthropic.com with an API key.',
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    icon: 'cloud',
    description: 'Run agents via AWS Bedrock (Claude models). Use IAM credentials.',
  },
  {
    id: 'kiro',
    label: 'Kiro CLI',
    icon: 'terminal',
    description: 'Run agents via the Kiro CLI engine.',
  },
];

const BEDROCK_AUTH_OPTIONS = [
  { value: 'ambient',     label: "Server's own AWS identity (instance role / ECS task role / env vars)" },
  { value: 'profile',     label: 'Named AWS profile (~/.aws/credentials)' },
  { value: 'keys',        label: 'Access key ID + secret access key' },
  { value: 'bedrock-key', label: 'Amazon Bedrock API key' },
  { value: 'sso',         label: 'AWS SSO / IAM Identity Center' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Convert an ISO expiry timestamp to a human-readable "expires in Xh" string. */
function formatExpiry(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'session expired';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return `expires in ${Math.floor(h / 24)}d`;
  if (h >= 1)  return `expires in ${h}h`;
  const m = Math.floor(ms / 60000);
  return `expires in ${m < 1 ? '<1' : m}m`;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Providers({ settings, isAdmin, onSaved }) {
  const uid = useId();

  // ── Provider mode ──────────────────────────────────────────────────────────
  const [savedMode, setSavedMode] = useState(settings?.provider?.mode ?? 'demo');
  const [mode, setMode]           = useState(settings?.provider?.mode ?? 'demo');

  // ── Anthropic ──────────────────────────────────────────────────────────────
  const [anthropicKey, setAnthropicKey] = useState('');
  const [showKey, setShowKey]           = useState(false);

  // ── Bedrock ────────────────────────────────────────────────────────────────
  const [bedrockRegion,      setBedrockRegion]      = useState(settings?.provider?.bedrockRegion ?? 'us-east-1');
  const [bedrockAuth,        setBedrockAuth]         = useState(settings?.provider?.bedrockAuth ?? 'ambient');
  const [bedrockProfile,     setBedrockProfile]      = useState(settings?.provider?.bedrockProfile ?? '');
  const [bedrockAccessKeyId, setBedrockAccessKeyId]  = useState(settings?.provider?.bedrockAccessKeyId ?? '');
  const [bedrockSecretKey,   setBedrockSecretKey]    = useState('');
  const [showBedrockKey,     setShowBedrockKey]      = useState(false);

  // ── Bedrock SSO config fields (persisted) ─────────────────────────────────
  const [ssoStartUrl,  setSsoStartUrl]  = useState(settings?.provider?.ssoStartUrl ?? '');
  // Default ssoRegion to the Bedrock region (Identity Center can differ — user can override).
  const [ssoRegion,    setSsoRegion]    = useState(
    settings?.provider?.ssoRegion ?? settings?.provider?.bedrockRegion ?? 'us-east-1',
  );
  const [ssoAccountId, setSsoAccountId] = useState(settings?.provider?.ssoAccountId ?? '');
  const [ssoRoleName,  setSsoRoleName]  = useState(settings?.provider?.ssoRoleName ?? '');

  // ── Bedrock SSO sign-in flow ───────────────────────────────────────────────
  // ssoPhase: 'idle' → signing-in shows DeviceCodeBox → 'authorizing' → poll
  //           completes → load accounts → 'selecting' → user picks account/role
  const [ssoPhase,          setSsoPhase]          = useState('idle');
  const [ssoChallenge,      setSsoChallenge]       = useState(null);
  const [ssoPollStatus,     setSsoPollStatus]      = useState('pending');
  const [ssoAccounts,       setSsoAccounts]        = useState([]);
  const [ssoRoles,          setSsoRoles]           = useState([]);
  const [ssoAccountsLoading, setSsoAccountsLoading] = useState(false);
  const [ssoRolesLoading,   setSsoRolesLoading]    = useState(false);
  const [ssoStartBusy,      setSsoStartBusy]       = useState(false);
  const [ssoStartError,     setSsoStartError]      = useState(null);
  const [ssoSignOutBusy,    setSsoSignOutBusy]     = useState(false);
  const [ssoAccountsError,  setSsoAccountsError]   = useState(null);
  const [ssoRolesError,     setSsoRolesError]      = useState(null);

  // ── Kiro ───────────────────────────────────────────────────────────────────
  const [kiroApiKey,  setKiroApiKey]  = useState('');
  const [showKiroKey, setShowKiroKey] = useState(false);

  // ── Kiro CLI sign-in state ─────────────────────────────────────────────────
  const [kiroStatus,         setKiroStatus]         = useState(null);
  const [kiroStatusLoading,  setKiroStatusLoading]  = useState(false);
  const [kiroSignInOpen,     setKiroSignInOpen]     = useState(false);
  const [kiroSignInMethod,   setKiroSignInMethod]   = useState('builder-id');
  const [kiroSignInStartUrl, setKiroSignInStartUrl] = useState('');
  const [kiroSignInRegion,   setKiroSignInRegion]   = useState('us-east-1');
  const [kiroChallenge,      setKiroChallenge]      = useState(null);
  const [kiroPollStatus,     setKiroPollStatus]     = useState('pending');
  const [kiroSignOutConfirm, setKiroSignOutConfirm] = useState(false);
  const [kiroSignOutBusy,    setKiroSignOutBusy]    = useState(false);
  const [kiroSignInBusy,     setKiroSignInBusy]     = useState(false);
  const [kiroSignInError,    setKiroSignInError]    = useState(null);

  // ── Default model ──────────────────────────────────────────────────────────
  const [selectValue,    setSelectValue]    = useState(settings?.defaultModel ?? settings?.models?.sonnet ?? '');
  const [customModelId,  setCustomModelId]  = useState('');
  const [customModelErr, setCustomModelErr] = useState(null);

  const [modelGroups,      setModelGroups]      = useState([]);
  const [modelLoading,     setModelLoading]      = useState(false);
  const [modelSource,      setModelSource]       = useState(null);
  const [modelFallbackErr, setModelFallbackErr]  = useState(null);
  const [providerResetNote, setProviderResetNote] = useState(null);

  const resolvedInitialRef = useRef(false);

  // ── UI ─────────────────────────────────────────────────────────────────────
  const [busy,       setBusy]       = useState(false);
  const [saveError,  setSaveError]  = useState(null);
  const [saved,      setSaved]      = useState(false);
  const [testing,    setTesting]    = useState(false);
  const [testResult, setTestResult] = useState(null);

  // ── Load model list when provider changes ──────────────────────────────────
  useEffect(() => {
    if (mode === 'demo') {
      setModelGroups([]);
      setModelSource(null);
      setModelFallbackErr(null);
      if (!resolvedInitialRef.current) resolvedInitialRef.current = true;
      return;
    }

    let cancelled = false;
    setModelLoading(true);

    api
      .get(`/api/settings/models?provider=${encodeURIComponent(mode)}`)
      .then((data) => {
        if (cancelled) return;
        const groups = data.groups ?? [];
        setModelGroups(groups);
        setModelSource(data.source ?? null);
        setModelFallbackErr(data.source === 'fallback' ? (data.error ?? null) : null);

        const allIds = groups.flatMap((g) => (g.models ?? []).map((m) => m.id));

        if (!resolvedInitialRef.current) {
          resolvedInitialRef.current = true;
          const saved = settings?.defaultModel ?? settings?.models?.sonnet ?? '';
          if (saved !== '' && !allIds.includes(saved)) {
            setSelectValue('custom');
            setCustomModelId(saved);
          }
        } else {
          setSelectValue((prev) => {
            if (prev === '' || prev === 'custom') return prev;
            if (!allIds.includes(prev)) {
              setProviderResetNote(
                `"${prev}" is not available for this provider — reset to Built-in default.`,
              );
              return '';
            }
            return prev;
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelGroups([]);
          setModelSource(null);
          setModelFallbackErr(null);
          if (!resolvedInitialRef.current) resolvedInitialRef.current = true;
        }
      })
      .finally(() => {
        if (!cancelled) setModelLoading(false);
      });

    return () => { cancelled = true; };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load Kiro CLI status when Kiro mode is active ─────────────────────────
  useEffect(() => {
    if (mode !== 'kiro') return;
    let cancelled = false;
    setKiroStatusLoading(true);
    api
      .get('/api/settings/kiro/status')
      .then((data) => { if (!cancelled) setKiroStatus(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setKiroStatusLoading(false); });
    return () => { cancelled = true; };
  }, [mode]);

  // ── Reset active sign-in flows when the provider or auth method changes ───
  useEffect(() => {
    if (mode !== 'bedrock' || bedrockAuth !== 'sso') {
      setSsoChallenge(null);
      setSsoPhase('idle');
      setSsoPollStatus('pending');
      setSsoAccounts([]);
      setSsoRoles([]);
      setSsoAccountsError(null);
      setSsoRolesError(null);
    }
  }, [mode, bedrockAuth]);

  useEffect(() => {
    if (mode !== 'kiro') {
      setKiroChallenge(null);
      setKiroSignInOpen(false);
      setKiroPollStatus('pending');
    }
  }, [mode]);

  // ── Bedrock SSO polling — runs while ssoPhase === 'authorizing' ───────────
  useEffect(() => {
    if (ssoPhase !== 'authorizing') return;

    const interval = (ssoChallenge?.interval || 5) * 1000;
    let cancelled = false;
    let tid;

    const poll = async () => {
      if (cancelled) return;
      try {
        const result = await api.post('/api/settings/bedrock-sso/poll', {});
        if (cancelled) return;
        setSsoPollStatus(result.status);

        if (result.status === 'complete') {
          clearInterval(tid);
          // Load the account list for the picker step.
          setSsoAccountsLoading(true);
          try {
            const { accounts } = await api.get('/api/settings/bedrock-sso/accounts');
            if (!cancelled) setSsoAccounts(accounts ?? []);
          } catch {
            if (!cancelled) setSsoAccounts([]);
          } finally {
            if (!cancelled) setSsoAccountsLoading(false);
          }
          if (!cancelled) {
            // Reset selections for a fresh pick
            setSsoAccountId('');
            setSsoRoleName('');
            setSsoRoles([]);
            setSsoChallenge(null); // hides DeviceCodeBox
            setSsoPhase('selecting');
          }
        } else if (result.status === 'expired' || result.status === 'denied') {
          clearInterval(tid);
          // Leave DeviceCodeBox visible to show the error state.
        }
        // 'pending': keep polling.
      } catch {
        // Non-fatal — keep polling.
      }
    };

    tid = setInterval(poll, interval);
    return () => {
      cancelled = true;
      clearInterval(tid);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ssoPhase]);

  // ── Load SSO accounts when signed in at page load (not just post-auth) ────
  // Fires when the user is already signed in (e.g. after a page reload) and
  // the accounts list is empty. Also handles account switch after sign-in.
  useEffect(() => {
    if (mode !== 'bedrock' || bedrockAuth !== 'sso') return;
    if (ssoPhase !== 'idle') return; // 'selecting' phase handles its own load
    if (!(settings?.provider?.sso?.signedIn === true)) return;
    if (ssoAccountsLoading || ssoAccounts.length > 0) return;

    let cancelled = false;
    setSsoAccountsLoading(true);
    setSsoAccountsError(null);
    api
      .get('/api/settings/bedrock-sso/accounts')
      .then(({ accounts }) => {
        if (cancelled) return;
        const list = accounts ?? [];
        setSsoAccounts(list);
        // Auto-select if only one account and none selected yet
        if (list.length === 1) {
          setSsoAccountId((prev) => prev || list[0].accountId);
        }
      })
      .catch((err) => {
        if (!cancelled) setSsoAccountsError(err.message ?? 'Failed to load AWS accounts');
      })
      .finally(() => {
        if (!cancelled) setSsoAccountsLoading(false);
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bedrockAuth, settings?.provider?.sso?.signedIn, ssoPhase]);

  // ── Load SSO roles when the selected account changes ──────────────────────
  // Fires when accountId is non-empty and SSO is signed in.
  // Role name is NOT reset here — it is reset in the account-change handler
  // so the saved value is preserved on initial page load.
  useEffect(() => {
    if (!ssoAccountId) return;
    if (!(settings?.provider?.sso?.signedIn === true)) return;
    if (ssoPhase !== 'selecting' && ssoPhase !== 'idle') return;

    let cancelled = false;
    setSsoRolesLoading(true);
    setSsoRoles([]);
    setSsoRolesError(null);
    api
      .get(`/api/settings/bedrock-sso/roles?accountId=${encodeURIComponent(ssoAccountId)}`)
      .then(({ roles }) => {
        if (cancelled) return;
        const list = roles ?? [];
        setSsoRoles(list);
        // Auto-select single role; preserve saved selection if already set
        if (list.length === 1) {
          setSsoRoleName((prev) => prev || list[0].roleName);
        }
      })
      .catch((err) => {
        if (!cancelled) setSsoRolesError(err.message ?? 'Failed to load IAM roles');
      })
      .finally(() => { if (!cancelled) setSsoRolesLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ssoAccountId, ssoPhase]);

  // ── Kiro CLI sign-in polling — runs while kiroChallenge is set ────────────
  useEffect(() => {
    if (!kiroChallenge) return;
    let cancelled = false;
    let tid;

    const poll = async () => {
      if (cancelled) return;
      try {
        const result = await api.get('/api/settings/kiro/login');
        if (cancelled) return;
        if (result.status === 'complete') {
          clearInterval(tid);
          setKiroPollStatus('complete');
          // Refresh the Kiro status line.
          try {
            const status = await api.get('/api/settings/kiro/status');
            if (!cancelled) setKiroStatus(status);
          } catch {
            // Non-fatal.
          }
          if (!cancelled) {
            setKiroChallenge(null);
            setKiroSignInOpen(false);
          }
        } else if (result.status === 'failed') {
          clearInterval(tid);
          setKiroPollStatus('failed');
        }
        // 'pending' / 'idle': keep polling.
      } catch {
        // Non-fatal — keep polling.
      }
    };

    tid = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(tid);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiroChallenge]);

  // ── Refresh model list (bypass server cache) ──────────────────────────────
  const handleRefreshModels = async () => {
    if (mode === 'demo' || modelLoading) return;
    setModelLoading(true);
    try {
      const data = await api.get(
        `/api/settings/models?provider=${encodeURIComponent(mode)}&refresh=1`,
      );
      setModelGroups(data.groups ?? []);
      setModelSource(data.source ?? null);
      setModelFallbackErr(data.source === 'fallback' ? (data.error ?? null) : null);
    } catch {
      // Keep the existing list on refresh failure.
    } finally {
      setModelLoading(false);
    }
  };

  // ── Bedrock SSO handlers ──────────────────────────────────────────────────
  const startSsoSignIn = async () => {
    if (!isAdmin) return;
    if (!ssoStartUrl.trim()) {
      setSsoStartError('SSO start URL is required.');
      return;
    }
    setSsoStartBusy(true);
    setSsoStartError(null);
    setSsoPollStatus('pending');
    try {
      const challenge = await api.post('/api/settings/bedrock-sso/start', {
        startUrl: ssoStartUrl.trim(),
        region:   ssoRegion.trim() || bedrockRegion,
      });
      setSsoChallenge(challenge);
      setSsoPhase('authorizing');
    } catch (err) {
      setSsoStartError(err.message);
    } finally {
      setSsoStartBusy(false);
    }
  };

  const cancelSsoSignIn = () => {
    setSsoChallenge(null);
    setSsoPhase('idle');
    setSsoPollStatus('pending');
    setSsoStartError(null);
  };

  const cancelSsoSelection = () => {
    setSsoPhase('idle');
    setSsoAccounts([]);
    setSsoRoles([]);
  };

  const handleSsoSignOut = async () => {
    if (!isAdmin) return;
    setSsoSignOutBusy(true);
    try {
      await api.post('/api/settings/bedrock-sso/sign-out', {});
      // Optimistically reflect the sign-out in the parent's settings view.
      if (onSaved && settings) {
        onSaved({
          ...settings,
          provider: {
            ...settings.provider,
            sso: { ...(settings.provider?.sso ?? {}), signedIn: false },
          },
        });
      }
    } catch {
      // Non-fatal — the user can retry.
    } finally {
      setSsoSignOutBusy(false);
    }
  };

  // ── Kiro CLI handlers ─────────────────────────────────────────────────────
  const startKiroSignIn = async () => {
    if (!isAdmin) return;
    setKiroSignInBusy(true);
    setKiroSignInError(null);
    setKiroPollStatus('pending');
    try {
      const body = { method: kiroSignInMethod };
      if (kiroSignInMethod === 'identity-center') {
        body.startUrl = kiroSignInStartUrl.trim();
        body.region   = kiroSignInRegion.trim();
      }
      const result = await api.post('/api/settings/kiro/login', body);
      setKiroChallenge(result);
    } catch (err) {
      setKiroSignInError(err.message);
    } finally {
      setKiroSignInBusy(false);
    }
  };

  const cancelKiroSignIn = () => {
    // Best-effort server cancel; ignore any error.
    api.post('/api/settings/kiro/login/cancel', {}).catch(() => {});
    setKiroChallenge(null);
    setKiroPollStatus('pending');
    setKiroSignInOpen(false);
    setKiroSignInError(null);
  };

  const handleKiroSignOut = async () => {
    if (!isAdmin) return;
    setKiroSignOutBusy(true);
    try {
      await api.post('/api/settings/kiro/logout', {});
      setKiroStatus((prev) => ({ ...(prev ?? {}), signedIn: false }));
      setKiroSignOutConfirm(false);
    } catch {
      setKiroSignOutConfirm(false);
    } finally {
      setKiroSignOutBusy(false);
    }
  };

  // ── Test connection ───────────────────────────────────────────────────────
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

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = async (e) => {
    e.preventDefault();
    if (!isAdmin) return;

    if (selectValue === 'custom' && customModelId.trim() === '') {
      setCustomModelErr('Model ID is required.');
      return;
    }

    setBusy(true);
    setSaveError(null);
    setSaved(false);

    try {
      const effectiveDefault = selectValue === 'custom' ? customModelId.trim() : selectValue;

      const providerPayload = {
        mode,
        bedrockRegion,
        bedrockAuth,
        bedrockProfile,
        bedrockAccessKeyId,
      };
      if (anthropicKey)     providerPayload.anthropicKey = anthropicKey;
      if (bedrockSecretKey) providerPayload.bedrockKey   = bedrockSecretKey;

      // Include SSO configuration fields when SSO auth is selected.
      if (bedrockAuth === 'sso') {
        providerPayload.ssoStartUrl  = ssoStartUrl.trim();
        providerPayload.ssoRegion    = ssoRegion.trim() || bedrockRegion;
        providerPayload.ssoAccountId = ssoAccountId;
        providerPayload.ssoRoleName  = ssoRoleName;
      }

      const body = {
        provider: providerPayload,
        defaultModel: effectiveDefault,
        // Also write models.sonnet for backward compatibility with server-side resolveModel.
        models: { sonnet: effectiveDefault },
      };
      if (kiroApiKey) body.kiroApiKey = kiroApiKey;

      const updated = await api.put('/api/settings', body);
      onSaved?.(updated);
      setSaved(true);
      setSavedMode(mode);

      // After a successful SSO save, reset the selection flow if in progress
      // and always refresh models so live Bedrock models appear immediately.
      if (bedrockAuth === 'sso') {
        if (ssoPhase === 'selecting') {
          setSsoPhase('idle');
          setSsoAccounts([]);
          setSsoRoles([]);
        }
        handleRefreshModels();
      }

      setAnthropicKey('');
      setBedrockSecretKey('');
      setKiroApiKey('');
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedProvider = PROVIDERS.find((p) => p.id === mode);
  // SSO status comes from the last saved settings (not local state).
  const ssoStatus       = settings?.provider?.sso ?? null;
  const ssoWasConfigured = settings?.provider?.bedrockAuth === 'sso';

  return (
    <section aria-label="Model provider settings">
      <h2>Model provider</h2>

      <form onSubmit={save} className="stack" noValidate>
        {/* ── Provider card picker ─────────────────────────────────────── */}
        <fieldset className="provider-fieldset" style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend className="provider-fieldset-legend">Provider</legend>

          <div className="provider-grid" role="group" aria-label="Select model provider">
            {PROVIDERS.map((p) => (
              <label
                key={p.id}
                className={`provider-card${mode === p.id ? ' is-selected' : ''}${!isAdmin ? ' is-disabled' : ''}`}
              >
                <input
                  type="radio"
                  name={`${uid}-provider`}
                  value={p.id}
                  checked={mode === p.id}
                  disabled={!isAdmin}
                  onChange={() => {
                    setMode(p.id);
                    setSaved(false);
                    setTestResult(null);
                    setProviderResetNote(null);
                  }}
                />

                <div className="provider-card-header">
                  <span className="provider-card-icon" aria-hidden="true">
                    <Icon name={p.icon} size={16} />
                  </span>
                  <span className="provider-card-name">{p.label}</span>
                  <span className="provider-card-badges">
                    {savedMode === p.id && (
                      <span className="badge badge-ok" aria-label={`${p.label} is the active provider`}>
                        Active
                      </span>
                    )}
                    <span className="provider-card-check" aria-hidden="true">
                      <Icon name="check" size={14} />
                    </span>
                  </span>
                </div>

                <span className="provider-card-desc">{p.description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* ── Per-provider settings panel ─────────────────────────────── */}
        {mode !== 'demo' && (
          <div className="provider-settings-panel">
            <p className="provider-settings-panel-title">
              {selectedProvider?.label} settings
            </p>

            {/* ── Anthropic API ─────────────────────────────────────────── */}
            {mode === 'anthropic' && (
              <div className="stack">
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

            {/* ── Amazon Bedrock ───────────────────────────────────────── */}
            {mode === 'bedrock' && (
              <div className="stack">
                <div className="field">
                  <label htmlFor={`${uid}-bedrock-region`}>AWS region</label>
                  <AwsRegionSelect
                    id={`${uid}-bedrock-region`}
                    value={bedrockRegion}
                    onChange={(e) => setBedrockRegion(e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor={`${uid}-bedrock-auth`}>Sign-in method</label>
                  <select
                    id={`${uid}-bedrock-auth`}
                    value={bedrockAuth}
                    onChange={(e) => setBedrockAuth(e.target.value)}
                    disabled={!isAdmin}
                  >
                    {BEDROCK_AUTH_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {/* Named profile */}
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
                    <p className="field-hint">
                      SSO profiles work too — run{' '}
                      <code>aws sso login --profile &lt;name&gt;</code> on the server first to
                      authenticate the profile before using it here.
                    </p>
                  </div>
                )}

                {/* Access key + secret */}
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

                {/* Bedrock API key */}
                {bedrockAuth === 'bedrock-key' && (
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

                {/* AWS SSO / IAM Identity Center */}
                {bedrockAuth === 'sso' && (
                  <BedrockSsoSection
                    uid={uid}
                    isAdmin={isAdmin}
                    // Config fields
                    ssoStartUrl={ssoStartUrl}
                    ssoRegion={ssoRegion}
                    onSsoStartUrlChange={setSsoStartUrl}
                    onSsoRegionChange={setSsoRegion}
                    // Sign-in flow
                    ssoPhase={ssoPhase}
                    ssoChallenge={ssoChallenge}
                    ssoPollStatus={ssoPollStatus}
                    ssoStartBusy={ssoStartBusy}
                    ssoStartError={ssoStartError}
                    onStartSignIn={startSsoSignIn}
                    onCancelSignIn={cancelSsoSignIn}
                    // Account/role selection (always show when signed in)
                    ssoAccounts={ssoAccounts}
                    ssoAccountsLoading={ssoAccountsLoading}
                    ssoAccountsError={ssoAccountsError}
                    ssoAccountId={ssoAccountId}
                    onSsoAccountIdChange={(newId) => {
                      // Always reset role when account changes so a stale role
                      // from the previous account is never submitted.
                      if (newId !== ssoAccountId) setSsoRoleName('');
                      setSsoAccountId(newId);
                    }}
                    ssoRoles={ssoRoles}
                    ssoRolesLoading={ssoRolesLoading}
                    ssoRolesError={ssoRolesError}
                    ssoRoleName={ssoRoleName}
                    onSsoRoleNameChange={setSsoRoleName}
                    onCancelSelection={cancelSsoSelection}
                    // Saved status
                    ssoStatus={ssoStatus}
                    ssoWasConfigured={ssoWasConfigured}
                    ssoSignOutBusy={ssoSignOutBusy}
                    onSignOut={handleSsoSignOut}
                  />
                )}
              </div>
            )}

            {/* ── Kiro CLI ─────────────────────────────────────────────── */}
            {mode === 'codex' && <div><CodexCredentials isAdmin={isAdmin} /><p className="field-hint">Each user connects their own ChatGPT account. The portal never shares the administrator's sign-in. Test connection checks sign-in and the model catalog; a run verifies inference access.</p></div>}
            {mode === 'kiro' && (
              <KiroCliSection
                uid={uid}
                isAdmin={isAdmin}
                // API key (alternative to sign-in)
                kiroApiKey={kiroApiKey}
                showKiroKey={showKiroKey}
                kiroApiKeySet={settings?.kiroApiKeySet}
                onKiroApiKeyChange={setKiroApiKey}
                onToggleShowKey={() => setShowKiroKey((v) => !v)}
                // CLI status
                kiroStatus={kiroStatus}
                kiroStatusLoading={kiroStatusLoading}
                // Sign-in flow
                kiroSignInOpen={kiroSignInOpen}
                kiroSignInMethod={kiroSignInMethod}
                kiroSignInStartUrl={kiroSignInStartUrl}
                kiroSignInRegion={kiroSignInRegion}
                kiroChallenge={kiroChallenge}
                kiroPollStatus={kiroPollStatus}
                kiroSignInBusy={kiroSignInBusy}
                kiroSignInError={kiroSignInError}
                onOpenSignIn={() => { setKiroSignInOpen(true); setKiroSignInError(null); }}
                onCloseSignIn={() => setKiroSignInOpen(false)}
                onSignInMethodChange={setKiroSignInMethod}
                onSignInStartUrlChange={setKiroSignInStartUrl}
                onSignInRegionChange={setKiroSignInRegion}
                onStartSignIn={startKiroSignIn}
                onCancelSignIn={cancelKiroSignIn}
                // Sign-out
                kiroSignOutConfirm={kiroSignOutConfirm}
                kiroSignOutBusy={kiroSignOutBusy}
                onRequestSignOut={() => setKiroSignOutConfirm(true)}
                onCancelSignOut={() => setKiroSignOutConfirm(false)}
                onConfirmSignOut={handleKiroSignOut}
              />
            )}
          </div>
        )}

        {/* ── Default model ─────────────────────────────────────────────── */}
        <DefaultModel
          uid={uid}
          mode={mode}
          isAdmin={isAdmin}
          modelGroups={modelGroups}
          modelLoading={modelLoading}
          modelSource={modelSource}
          modelFallbackErr={modelFallbackErr}
          providerResetNote={providerResetNote}
          selectValue={selectValue}
          customModelId={customModelId}
          onSelectChange={(val) => {
            setSelectValue(val);
            setProviderResetNote(null);
            if (val !== 'custom') setCustomModelErr(null);
          }}
          onCustomChange={(val) => {
            setCustomModelId(val);
            if (customModelErr) setCustomModelErr(null);
          }}
          customModelErr={customModelErr}
          onRefresh={handleRefreshModels}
        />

        {/* ── Feedback ──────────────────────────────────────────────────── */}
        {saveError && <p className="error-note" role="alert">{saveError}</p>}
        {saved     && <p className="success-note" role="status">Settings saved.</p>}

        {/* ── Action row: Test + Save ────────────────────────────────────── */}
        <div className="provider-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={testConnection}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>

          {isAdmin ? (
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <p className="muted" style={{ fontSize: '0.84rem' }}>
              Admin access is required to change provider settings.
            </p>
          )}

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
      </form>
    </section>
  );
}

// ── Bedrock SSO section ────────────────────────────────────────────────────────

/**
 * All UI for the "AWS SSO / IAM Identity Center" Bedrock auth method:
 *   1. Config fields (start URL, SSO region)
 *   2. Signed-in status row (from saved settings) — with warning when no account/role chosen
 *   3. Account + role pickers — always visible when signed in (not just post-sign-in)
 *   4. Device-code sign-in flow (when authorizing)
 *   5. "Sign in again" (secondary) when signed in, "Sign in with AWS SSO" (primary) when not
 */
function BedrockSsoSection({
  uid, isAdmin,
  ssoStartUrl, ssoRegion, onSsoStartUrlChange, onSsoRegionChange,
  ssoPhase, ssoChallenge, ssoPollStatus, ssoStartBusy, ssoStartError,
  onStartSignIn, onCancelSignIn,
  ssoAccounts, ssoAccountsLoading, ssoAccountsError,
  ssoAccountId, onSsoAccountIdChange,
  ssoRoles, ssoRolesLoading, ssoRolesError,
  ssoRoleName, onSsoRoleNameChange,
  onCancelSelection,
  ssoStatus, ssoWasConfigured, ssoSignOutBusy, onSignOut,
}) {
  const ssoStartUrlId = `${uid}-sso-start-url`;
  const ssoRegionId   = `${uid}-sso-region`;
  const ssoAccountEl  = `${uid}-sso-account`;
  const ssoRoleEl     = `${uid}-sso-role`;

  const isSignedIn         = ssoStatus?.signedIn === true;
  const isExpired          = ssoWasConfigured && ssoStatus && !isSignedIn;
  const expiry             = formatExpiry(ssoStatus?.expiresAt);

  // Whether to show the account/role picker:
  // always when signed in (including after page reload), plus right after sign-in.
  const showPicker = (isSignedIn || ssoPhase === 'selecting') && !ssoChallenge;

  // Look up the account name for the status display
  const savedAccountId   = ssoStatus?.accountId;
  const savedRoleName    = ssoStatus?.roleName;
  const savedAccountName = ssoAccounts.find((a) => a.accountId === savedAccountId)?.accountName;
  const isFullyConfigured = isSignedIn && savedAccountId && savedRoleName;

  return (
    <div className="stack">
      {/* ── Config fields ─────────────────────────────────────────────── */}
      <div className="field">
        <label htmlFor={ssoStartUrlId}>SSO start URL</label>
        <input
          id={ssoStartUrlId}
          type="url"
          value={ssoStartUrl}
          onChange={(e) => onSsoStartUrlChange(e.target.value)}
          placeholder="https://d-xxxx.awsapps.com/start"
          disabled={!isAdmin}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${ssoStartUrlId}-hint`}
        />
        <p id={`${ssoStartUrlId}-hint`} className="field-hint">
          Your AWS IAM Identity Center access portal URL.
        </p>
      </div>

      <div className="field">
        <label htmlFor={ssoRegionId}>Identity Center region</label>
        <AwsRegionSelect
          id={ssoRegionId}
          value={ssoRegion}
          onChange={(e) => onSsoRegionChange(e.target.value)}
          disabled={!isAdmin}
        />
        <p className="field-hint">
          The AWS region your Identity Center is hosted in — this may differ from the Bedrock
          region above.
        </p>
      </div>

      {/* ── Signed-in status row ──────────────────────────────────────── */}
      {ssoWasConfigured && ssoStatus && (
        <div
          className={[
            'sso-status-row',
            isExpired                        ? 'sso-status-row--expired' : '',
            isSignedIn && !isFullyConfigured ? 'sso-status-row--warn'    : '',
          ].filter(Boolean).join(' ')}
          aria-live="polite"
          aria-atomic="true"
        >
          <span
            className={`dot ${
              isSignedIn
                ? isFullyConfigured ? 'dot-running' : 'dot-pending'
                : 'dot-failed'
            }`}
            aria-hidden="true"
          />
          {isSignedIn ? (
            <>
              <span>
                {isFullyConfigured ? (
                  <>
                    Signed in as{' '}
                    <strong>{savedRoleName}</strong>
                    {' @ '}
                    {savedAccountName
                      ? <>{savedAccountName} ({savedAccountId})</>
                      : savedAccountId}
                    {expiry && <> · {expiry}</>}
                  </>
                ) : (
                  'Signed in — choose an AWS account and role below'
                )}
              </span>
              {isAdmin && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={onSignOut}
                  disabled={ssoSignOutBusy}
                >
                  {ssoSignOutBusy ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </>
          ) : (
            <span>Session expired — sign in again to reconnect.</span>
          )}
        </div>
      )}

      {/* Portal-wide notice */}
      <p className="muted small">
        <Icon name="info" size={13} style={{ verticalAlign: -2 }} />{' '}
        This sign-in is <strong>portal-wide</strong> — all agent runs use this AWS identity.
      </p>

      {/* ── Device-code sign-in box ────────────────────────────────────── */}
      {ssoChallenge && (
        <DeviceCodeBox
          challenge={ssoChallenge}
          pollStatus={ssoPollStatus}
          onCancel={onCancelSignIn}
          heading="Sign in with AWS SSO"
        />
      )}

      {/* ── Account + role pickers ────────────────────────────────────────
          Always rendered when signed in (even after a page reload), not only
          immediately after the device-code flow completes.               */}
      {showPicker && (
        <div className="stack">
          {/* Confirmation message shown only right after sign-in completes */}
          {ssoPhase === 'selecting' && (
            <p className="muted small" style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <Icon name="check" size={13} style={{ color: 'var(--ok)', flexShrink: 0 }} />
              Signed in. Choose the account and role to use, then click Save.
            </p>
          )}

          {/* Account picker or error */}
          {ssoAccountsError ? (
            <p className="error-note" role="alert" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <Icon name="warning" size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                {ssoAccountsError}
                {isAdmin && (
                  <>{' '}<button type="button" className="btn btn-ghost btn-sm" onClick={onStartSignIn}>
                    Sign in again
                  </button></>
                )}
              </span>
            </p>
          ) : (
            <div className="field">
              <label htmlFor={ssoAccountEl}>
                AWS account
                {ssoAccountsLoading && (
                  <span className="spinner" style={{ width: 12, height: 12, marginLeft: 6 }} aria-hidden="true" />
                )}
              </label>
              <select
                id={ssoAccountEl}
                value={ssoAccountId}
                onChange={(e) => onSsoAccountIdChange(e.target.value)}
                disabled={!isAdmin || ssoAccountsLoading || ssoAccounts.length === 0}
              >
                <option value="">— Select account —</option>
                {ssoAccounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.accountName} ({a.accountId})
                  </option>
                ))}
              </select>
              {!ssoAccountsLoading && ssoAccounts.length === 0 && !ssoAccountsError && (
                <p className="field-error" role="alert">No accounts found for this identity.</p>
              )}
            </div>
          )}

          {/* Role picker — only once an account is selected */}
          {ssoAccountId && !ssoAccountsError && (
            <div className="field">
              <label htmlFor={ssoRoleEl}>
                IAM role
                {ssoRolesLoading && (
                  <span className="spinner" style={{ width: 12, height: 12, marginLeft: 6 }} aria-hidden="true" />
                )}
              </label>
              {ssoRolesError ? (
                <p className="error-note" role="alert" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <Icon name="warning" size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    {ssoRolesError}
                    {isAdmin && (
                      <>{' '}<button type="button" className="btn btn-ghost btn-sm" onClick={onStartSignIn}>
                        Sign in again
                      </button></>
                    )}
                  </span>
                </p>
              ) : (
                <select
                  id={ssoRoleEl}
                  value={ssoRoleName}
                  onChange={(e) => onSsoRoleNameChange(e.target.value)}
                  disabled={!isAdmin || ssoRolesLoading || ssoRoles.length === 0}
                >
                  <option value="">— Select role —</option>
                  {ssoRoles.map((r) => (
                    <option key={r.roleName} value={r.roleName}>
                      {r.roleName}
                    </option>
                  ))}
                </select>
              )}
              {!ssoRolesLoading && !ssoRolesError && ssoRoles.length === 0 && (
                <p className="muted small">No roles available for this account.</p>
              )}
            </div>
          )}

          {ssoPhase === 'selecting' && (
            <div className="row tight">
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelSelection}>
                Cancel
              </button>
              <p className="muted small">
                Click <strong>Save</strong> below to persist the selection.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── Sign-in / Sign-in-again button ───────────────────────────────
          Primary "Sign in with AWS SSO" when not signed in.
          Secondary "Sign in again" when already signed in.            */}
      {ssoPhase === 'idle' && isAdmin && (
        <div className="stack" style={{ gap: 6 }}>
          <div>
            <button
              type="button"
              className={isSignedIn ? 'btn btn-secondary' : 'btn btn-outline'}
              onClick={onStartSignIn}
              disabled={ssoStartBusy}
            >
              {ssoStartBusy ? (
                <><span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> Starting…</>
              ) : isSignedIn ? (
                <><Icon name="external" size={14} /> Sign in again</>
              ) : (
                <><Icon name="external" size={14} /> Sign in with AWS SSO</>
              )}
            </button>
          </div>
          {ssoStartError && (
            <p className="error-note" role="alert">{ssoStartError}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Kiro CLI section ───────────────────────────────────────────────────────────

/**
 * All UI for the Kiro CLI provider panel:
 *   - Status line from /kiro/status (installed / signed-in / method / email)
 *   - Sign-in flow (Builder ID or IAM Identity Center device-code)
 *   - Sign-out with confirmation
 *   - Optional API key (alternative to CLI sign-in)
 */
function KiroCliSection({
  uid, isAdmin,
  kiroApiKey, showKiroKey, kiroApiKeySet,
  onKiroApiKeyChange, onToggleShowKey,
  kiroStatus, kiroStatusLoading,
  kiroSignInOpen, kiroSignInMethod,
  kiroSignInStartUrl, kiroSignInRegion,
  kiroChallenge, kiroPollStatus,
  kiroSignInBusy, kiroSignInError,
  onOpenSignIn, onCloseSignIn,
  onSignInMethodChange, onSignInStartUrlChange, onSignInRegionChange,
  onStartSignIn, onCancelSignIn,
  kiroSignOutConfirm, kiroSignOutBusy,
  onRequestSignOut, onCancelSignOut, onConfirmSignOut,
}) {
  const kiroKeyId      = `${uid}-kiro-key`;
  const kiroUrlId      = `${uid}-kiro-signin-url`;
  const kiroRegionId   = `${uid}-kiro-signin-region`;

  const isInstalled  = kiroStatus?.installed !== false; // treat unknown as possibly installed
  const isSignedIn   = kiroStatus?.signedIn === true;
  const method       = kiroStatus?.method; // 'builder-id' | 'identity-center' | null

  const methodLabel =
    method === 'builder-id'      ? 'AWS Builder ID' :
    method === 'identity-center' ? 'IAM Identity Center' :
    null;

  // Cloud portal: Kiro runs in its own runner, so there is no CLI on this server to install or sign in.
  if (kiroStatus?.remote) {
    return (
      <div className="stack">
        <div className="sso-status-row">
          <Icon name="info" size={14} style={{ flexShrink: 0 }} />
          <span>
            Kiro runs in the cloud runner (AgentCore), not on this server, so there is nothing to install or sign in to here.
            Each person signs in under <strong>Agent setup › Agent sign-ins</strong>; a Kiro session uses that person's sign-in.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* ── Not installed notice ─────────────────────────────────────── */}
      {kiroStatus && !isInstalled && (
        <div className="sso-status-row sso-status-row--expired">
          <Icon name="warning" size={14} style={{ flexShrink: 0 }} />
          <span>
            Kiro CLI is not installed on this server.
            Install it first under <strong>Settings › Tools</strong>.
          </span>
        </div>
      )}

      {/* ── Signed-in status ─────────────────────────────────────────── */}
      {(kiroStatusLoading || kiroStatus) && (
        <div className="sso-status-row" aria-live="polite" aria-atomic="true">
          {kiroStatusLoading ? (
            <>
              <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
              <span>Checking Kiro CLI status…</span>
            </>
          ) : isSignedIn ? (
            <>
              <span className="dot dot-running" aria-hidden="true" />
              <span>
                Signed in
                {methodLabel && <> with {methodLabel}</>}
                {kiroStatus.email && <> · {kiroStatus.email}</>}
                {kiroStatus.startUrl && method === 'identity-center' && (
                  <> · {kiroStatus.startUrl}</>
                )}
              </span>
            </>
          ) : (
            <>
              <span className="dot" aria-hidden="true" />
              <span>Not signed in</span>
            </>
          )}
        </div>
      )}

      {/* Portal-wide notice */}
      <p className="muted small">
        <Icon name="info" size={13} style={{ verticalAlign: -2 }} />{' '}
        This sign-in is <strong>portal-wide</strong> — all Kiro CLI runs on this server share the
        same CLI identity. Sign in here once; individual users can still override with their own
        credential on the <strong>Credentials</strong> page.
      </p>

      {/* ── Sign-in / switch-account panel ───────────────────────────── */}
      {isAdmin && isInstalled && !kiroSignInOpen && !kiroChallenge && (
        <div className="row tight">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onOpenSignIn}
          >
            <Icon name="external" size={13} />
            {isSignedIn ? 'Switch account' : 'Sign in'}
          </button>

          {isSignedIn && !kiroSignOutConfirm && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onRequestSignOut}
            >
              Sign out
            </button>
          )}

          {isSignedIn && kiroSignOutConfirm && (
            <>
              <span className="muted small">
                This signs out the server's Kiro CLI for everyone.
              </span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={onConfirmSignOut}
                disabled={kiroSignOutBusy}
              >
                {kiroSignOutBusy ? 'Signing out…' : 'Confirm sign out'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onCancelSignOut}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {/* Sign-in method picker + fields */}
      {kiroSignInOpen && !kiroChallenge && (
        <div className="stack">
          <p className="muted small" style={{ fontWeight: 600 }}>Choose a sign-in method:</p>

          <div className="cred-mode-grid" role="radiogroup" aria-label="Kiro sign-in method">
            {[
              { id: 'builder-id',      label: 'AWS Builder ID',       desc: 'Free, personal AWS account' },
              { id: 'identity-center', label: 'IAM Identity Center',  desc: 'Organization SSO via AWS' },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={kiroSignInMethod === m.id}
                className={`cred-mode-card${kiroSignInMethod === m.id ? ' is-selected' : ''}`}
                onClick={() => onSignInMethodChange(m.id)}
              >
                <strong>{m.label}</strong>
                <span>{m.desc}</span>
              </button>
            ))}
          </div>

          {kiroSignInMethod === 'identity-center' && (
            <>
              <div className="field">
                <label htmlFor={kiroUrlId}>Start URL</label>
                <input
                  id={kiroUrlId}
                  type="url"
                  value={kiroSignInStartUrl}
                  onChange={(e) => onSignInStartUrlChange(e.target.value)}
                  placeholder="https://d-xxxx.awsapps.com/start"
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor={kiroRegionId}>Identity Center region</label>
                <AwsRegionSelect
                  id={kiroRegionId}
                  value={kiroSignInRegion}
                  onChange={(e) => onSignInRegionChange(e.target.value)}
                />
              </div>
            </>
          )}

          {kiroSignInError && (
            <p className="error-note" role="alert">{kiroSignInError}</p>
          )}

          <div className="row tight">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onStartSignIn}
              disabled={kiroSignInBusy}
            >
              {kiroSignInBusy ? (
                <><span className="spinner" style={{ width: 13, height: 13 }} aria-hidden="true" /> Starting…</>
              ) : (
                'Continue'
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onCloseSignIn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Device-code authorization box */}
      {kiroChallenge && (
        <DeviceCodeBox
          challenge={kiroChallenge}
          pollStatus={kiroPollStatus}
          onCancel={onCancelSignIn}
          heading="Authorize your Kiro CLI"
        />
      )}

      {/* ── Optional API key (alternative to CLI sign-in) ────────────── */}
      <div className="field">
        <label htmlFor={kiroKeyId}>Kiro API key (optional)</label>
        <div className="input-with-action">
          <input
            id={kiroKeyId}
            type={showKiroKey ? 'text' : 'password'}
            value={kiroApiKey}
            onChange={(e) => onKiroApiKeyChange(e.target.value)}
            placeholder={
              kiroApiKeySet
                ? '••••••••••••••••••• (set — enter to replace)'
                : 'Leave blank to use the CLI sign-in above'
            }
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onToggleShowKey}
            aria-label={showKiroKey ? 'Hide key' : 'Show key'}
          >
            {showKiroKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="field-hint">
          Use an API key as an alternative to signing in with the CLI above. When both are set, the
          API key takes precedence.
        </p>
      </div>
    </div>
  );
}

// ── Default model section ──────────────────────────────────────────────────────

/**
 * Dropdown for choosing the default model, grouped by model maker.
 * Placed inside the main form so the Save button applies to it.
 */
function DefaultModel({
  uid, mode, isAdmin,
  modelGroups, modelLoading, modelSource, modelFallbackErr,
  providerResetNote, selectValue, customModelId, customModelErr,
  onSelectChange, onCustomChange, onRefresh,
}) {
  const selectId = `${uid}-default-model`;
  const hintId   = `${uid}-default-model-hint`;
  const customId = `${uid}-custom-model-id`;

  if (mode === 'demo') {
    return (
      <section aria-label="Default model" className="provider-model-versions">
        <h3>Default model</h3>
        <p className="muted small">Not used in demo mode.</p>
      </section>
    );
  }

  return (
    <section aria-label="Default model" className="provider-model-versions">
      <div className="row tight" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Default model</h3>
        <button
          type="button"
          className="btn btn-icon"
          onClick={onRefresh}
          disabled={modelLoading}
          aria-label="Refresh model list"
          title="Refresh model list"
        >
          <Icon name="refresh" size={14} />
        </button>
        {modelLoading && (
          <span
            className="spinner"
            style={{ width: 14, height: 14, borderWidth: 2 }}
            aria-hidden="true"
          />
        )}
      </div>

      <p className="muted small">
        Default model — used for AI generation, code review and agent runs on this provider.
        Leave on "Built-in default" unless you need a specific model or inference-profile ARN.
      </p>

      {modelSource === 'fallback' && modelFallbackErr && (
        modelGroups.length === 0 ? (
          <p
            className="muted small"
            role="status"
            aria-live="polite"
            style={{ marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 5 }}
          >
            <Icon name="info" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{modelFallbackErr}</span>
          </p>
        ) : (
          <p
            className="muted small"
            role="status"
            aria-live="polite"
            style={{ marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 5 }}
          >
            <Icon name="warning" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Couldn&apos;t load live models from provider: {modelFallbackErr} Showing common models.
            </span>
          </p>
        )
      )}

      {providerResetNote && (
        <p
          className="muted small"
          role="status"
          aria-live="polite"
          style={{ marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 5 }}
        >
          <Icon name="info" size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{providerResetNote}</span>
        </p>
      )}

      <div className="stack" style={{ maxWidth: 480, marginTop: 10 }}>
        <div className="field">
          <label htmlFor={selectId}>Model</label>
          <select
            id={selectId}
            value={selectValue}
            onChange={(e) => onSelectChange(e.target.value)}
            disabled={!isAdmin || modelLoading}
            aria-describedby={hintId}
          >
            <option value="">Built-in default</option>

            {modelGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {(group.models ?? []).map((model) => (
                  <option key={model.id} value={model.id} title={model.id}>
                    {model.label}
                  </option>
                ))}
              </optgroup>
            ))}

            <option value="custom">Custom model ID…</option>
          </select>
          <p id={hintId} className="field-hint">
            {modelSource === 'live'
              ? 'Live model list loaded from the provider.'
              : modelSource === 'fallback' && modelGroups.length > 0
              ? 'Showing common models (live list unavailable).'
              : 'Select Built-in default to use the portal\u2019s recommended model.'}
          </p>
        </div>

        {selectValue === 'custom' && (
          <div className="field">
            <label htmlFor={customId}>Custom model ID or inference-profile ARN</label>
            <input
              id={customId}
              type="text"
              value={customModelId}
              onChange={(e) => onCustomChange(e.target.value)}
              placeholder="e.g. us.anthropic.claude-3-5-sonnet-20241022-v1:0"
              spellCheck={false}
              disabled={!isAdmin}
              autoComplete="off"
              aria-required="true"
              aria-invalid={customModelErr ? 'true' : undefined}
              aria-describedby={customModelErr ? `${customId}-err` : undefined}
            />
            {customModelErr && (
              <p id={`${customId}-err`} className="field-error" role="alert">
                {customModelErr}
              </p>
            )}
            <p className="field-hint">
              Enter a full model ID or cross-region inference profile ARN.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
