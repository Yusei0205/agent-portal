/**
 * Shared device-code authorization box.
 *
 * Used in Settings › Provider for both Bedrock SSO and Kiro CLI sign-in flows.
 * Renders the verification link (opens in new tab; prefers `verificationUriComplete`),
 * the user code with a copy button, a countdown, a live-region status line, and a
 * Cancel / Close button.
 *
 * When the box mounts, focus is moved to the first actionable element so keyboard
 * users do not have to tab through the rest of the form.
 *
 * @param {{
 *   challenge:   { verificationUri: string, verificationUriComplete?: string, userCode: string, expiresIn?: number },
 *   pollStatus:  'pending' | 'complete' | 'expired' | 'denied' | 'failed',
 *   onCancel:    () => void,
 *   heading?:    string,
 * }} props
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

export function DeviceCodeBox({
  challenge,
  pollStatus,
  onCancel,
  heading = 'Authorize in your browser',
}) {
  const boxRef                   = useRef(null);
  const [copied, setCopied]      = useState(false);
  const [remaining, setRemaining] = useState(challenge?.expiresIn ?? null);

  // Move focus to the verification link when the box first appears.
  useEffect(() => {
    const el = boxRef.current?.querySelector('a[href], button:not(:disabled)');
    el?.focus();
  // Only on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown from expiresIn seconds.
  useEffect(() => {
    if (!challenge?.expiresIn) return;
    const started = Date.now();
    const total   = challenge.expiresIn;
    setRemaining(total);
    const id = setInterval(() => {
      const left = Math.max(0, total - Math.floor((Date.now() - started) / 1000));
      setRemaining(left);
      if (left === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [challenge?.expiresIn]);

  const handleCopy = () => {
    const code = challenge?.userCode;
    if (!code) return;
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const isTerminal =
    pollStatus === 'complete' ||
    pollStatus === 'expired'  ||
    pollStatus === 'denied'   ||
    pollStatus === 'failed';

  // Prefer the complete URI (auto-fills the code in the browser on some IdPs).
  const href = challenge?.verificationUriComplete || challenge?.verificationUri || '#';

  const mins = remaining !== null ? Math.floor(remaining / 60) : 0;
  const secs = remaining !== null ? remaining % 60             : 0;

  return (
    <div
      className="device-code-box"
      role="region"
      aria-label="Device authorization"
      ref={boxRef}
    >
      <h4>{heading}</h4>

      {!isTerminal && (
        <>
          <p style={{ fontSize: '0.84rem', marginBottom: 8 }}>
            Open the link below in your browser and enter the code to sign in:
          </p>

          <div className="device-code-url">
            <a href={href} target="_blank" rel="noopener noreferrer">
              {challenge?.verificationUri}
            </a>
          </div>

          <div className="device-user-code-row">
            <div
              className="device-user-code"
              aria-label={`User code: ${challenge?.userCode}`}
            >
              {challenge?.userCode}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleCopy}
              aria-label="Copy user code to clipboard"
            >
              <Icon name="copy" size={13} />
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          {remaining !== null && remaining > 0 && (
            <p style={{ fontSize: '0.79rem', color: 'var(--ink-3)', marginTop: 4 }}>
              Expires in {mins}:{String(secs).padStart(2, '0')}
            </p>
          )}
        </>
      )}

      {/* Live region — screen readers announce status changes */}
      <div className="device-status" aria-live="polite" aria-atomic="true">
        {pollStatus === 'complete' ? (
          <>
            <Icon name="check" size={14} style={{ color: 'var(--ok)', flexShrink: 0 }} />
            Signed in successfully.
          </>
        ) : pollStatus === 'expired' ? (
          <>
            <Icon name="warning" size={14} style={{ flexShrink: 0 }} />
            Code expired — click Close and try again.
          </>
        ) : pollStatus === 'denied' ? (
          <>
            <Icon name="warning" size={14} style={{ flexShrink: 0 }} />
            Authorization was denied.
          </>
        ) : pollStatus === 'failed' ? (
          <>
            <Icon name="warning" size={14} style={{ flexShrink: 0 }} />
            Sign-in failed. Try again.
          </>
        ) : (
          <>
            <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />
            Waiting for you to authorize in the browser…
          </>
        )}
      </div>

      {onCancel && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          style={{ marginTop: 10 }}
        >
          {isTerminal ? 'Close' : 'Cancel'}
        </button>
      )}
    </div>
  );
}

export default DeviceCodeBox;
